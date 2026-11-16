// Jira Cloud (through api.atlassian.com with the connection's cloud id): search, read, create,
// comment. Server-only.
import { callApi } from "./api";
import { arr, clip, obj, ProviderError, str } from "./http";
import type { Connection } from "./store";

const KEY = /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/;
const PROJECT = /^[A-Z][A-Z0-9_]{0,30}$/;
const CLOUD_ID = /^[0-9a-f-]{36}$/i;

export function parseIssueKey(v: unknown): string {
  let s = typeof v === "string" ? v.trim() : "";
  const m = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase();
  if (!KEY.test(s)) throw new ProviderError("invalid", 'Expected a Jira issue key such as "PROJ-123".');
  return s;
}

export function parseProjectKey(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!PROJECT.test(s)) throw new ProviderError("invalid", 'Expected a Jira project key such as "PROJ".');
  return s;
}

function site(conn: Connection): { base: string; siteUrl: string } {
  const cloudId = conn.meta.cloudId ?? "";
  if (!CLOUD_ID.test(cloudId)) throw new ProviderError("reauth", "The Jira connection has no site; reconnect it in Settings → Apps & bots.");
  return { base: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`, siteUrl: conn.meta.siteUrl ?? "" };
}

/** Plain text → Atlassian Document Format (paragraphs). */
function adf(text: string) {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: p.split("\n").flatMap((line, i) => [...(i > 0 ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
    })),
  };
}

/** ADF → plain text (good enough for reading descriptions and comments). */
function adfText(node: unknown, max: number): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    const o = obj(n);
    if (o.type === "text") out.push(str(o.text));
    else if (o.type === "hardBreak") out.push("\n");
    else if (o.type === "mention") out.push(str(obj(o.attrs).text));
    for (const c of arr(o.content)) walk(c);
    if (["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(str(o.type))) out.push("\n");
  };
  walk(node);
  return clip(out.join("").replace(/\n{3,}/g, "\n\n").trim(), max);
}

const FIELDS = "summary,status,assignee,reporter,priority,issuetype,updated,created,project";

function issueView(raw: unknown, siteUrl: string) {
  const i = obj(raw);
  const f = obj(i.fields);
  const key = str(i.key);
  return {
    key,
    summary: clip(str(f.summary), 300),
    status: str(obj(f.status).name),
    statusCategory: str(obj(obj(f.status).statusCategory).key),
    type: str(obj(f.issuetype).name),
    priority: str(obj(f.priority).name) || null,
    assignee: str(obj(f.assignee).displayName) || null,
    reporter: str(obj(f.reporter).displayName) || null,
    project: str(obj(f.project).key),
    created: str(f.created),
    updated: str(f.updated),
    url: siteUrl ? `${siteUrl}/browse/${key}` : null,
  };
}

export async function search(token: string, conn: Connection, jql: string, limit: number) {
  const { base, siteUrl } = site(conn);
  const q = new URLSearchParams({ jql, maxResults: String(limit), fields: FIELDS });
  const { json } = await callApi("atlassian", token, `${base}/search/jql?${q}`);
  return arr(obj(json).issues).map((i) => issueView(i, siteUrl));
}

export async function getIssue(token: string, conn: Connection, key: string, withDescription = false) {
  const { base, siteUrl } = site(conn);
  const { json } = await callApi("atlassian", token, `${base}/issue/${key}?fields=${FIELDS}${withDescription ? ",description" : ""}`);
  const view = issueView(json, siteUrl);
  return withDescription ? { ...view, description: adfText(obj(obj(json).fields).description, 6000) } : view;
}

export async function createIssue(token: string, conn: Connection, input: { project: string; summary: string; description?: string; issueType: string }) {
  const { base, siteUrl } = site(conn);
  const { json } = await callApi("atlassian", token, `${base}/issue`, {
    method: "POST",
    body: {
      fields: {
        project: { key: input.project },
        summary: input.summary,
        issuetype: { name: input.issueType },
        ...(input.description ? { description: adf(input.description) } : {}),
      },
    },
  });
  const key = str(obj(json).key);
  return { key, url: siteUrl ? `${siteUrl}/browse/${key}` : null };
}

export async function addComment(token: string, conn: Connection, key: string, body: string) {
  const { base, siteUrl } = site(conn);
  const { json } = await callApi("atlassian", token, `${base}/issue/${key}/comment`, { method: "POST", body: { body: adf(body) } });
  const c = obj(json);
  return { id: str(c.id), created: str(c.created), url: siteUrl ? `${siteUrl}/browse/${key}?focusedCommentId=${str(c.id)}` : null };
}
