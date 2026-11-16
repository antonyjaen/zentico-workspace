// Link previews in Chat: when a person posts a GitHub issue/PR, Jira issue or Notion page URL
// and has that provider connected, a compact card is attached to their message, fetched with the
// AUTHOR's own token after the message is posted (never someone else's). Results are cached per
// author and URL for 5 minutes; failures and unconnected providers are silently skipped.
// Server-only.
import type { BotCard, ChatMessage } from "@/app/(apps)/chat/shared";
import { rateLimiter } from "../chat/bots";
import { get as chatGet } from "../chat/db";
import { attachUnfurls } from "../chat/store";
import { githubCard, jiraCard, notionCard } from "./cards";
import * as github from "./github";
import * as jira from "./jira";
import * as notion from "./notion";
import type { ProviderId } from "./providers";
import { connectedProviders, getConnection, withToken } from "./store";

const MAX_PER_MESSAGE = 3;
const CACHE_MS = 5 * 60_000;
const URL_RE = /https:\/\/[^\s<>()[\]"'`]+/g;

const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/(issues|pull)\/(\d{1,9})(?:[/?#].*)?$/;
const JIRA_RE = /^https:\/\/([a-z0-9][a-z0-9-]{0,62}\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]{0,30}-\d{1,9})(?:[/?#].*)?$/;
const NOTION_RE = /^https:\/\/(?:www\.)?(?:notion\.so|[a-z0-9-]{1,63}\.notion\.site)\/\S*[0-9a-f]{32}/i;

/** Lookups per author per 5 minutes (each URL counts once; cache hits are free). */
const allowed = rateLimiter(30, 5 * 60_000);

const g = globalThis as typeof globalThis & { __zwUnfurlCache?: Map<string, { at: number; card: BotCard | null }> };
const cache = (g.__zwUnfurlCache ??= new Map());

type Target = { provider: ProviderId; url: string; fetch: (sub: string) => Promise<BotCard | null> };

function classify(url: string, connected: Set<ProviderId>, sub: string): Target | null {
  const clean = url.replace(/[.,;:!?]+$/, "");
  let m = GITHUB_RE.exec(clean);
  if (m && connected.has("github")) {
    const [, repo, kind, num] = m;
    const n = Number(num);
    return {
      provider: "github",
      url: clean,
      fetch: (s) =>
        withToken(s, "github", async (t) =>
          kind === "pull"
            ? githubCard({ ...(await github.getPull(t, repo, n)), repo, isPullRequest: true })
            : githubCard(await github.getIssue(t, repo, n, 0)),
        ),
    };
  }
  m = JIRA_RE.exec(clean);
  if (m && connected.has("atlassian")) {
    // Only the Jira site this person connected.
    const site = getConnection(sub, "atlassian")?.meta.siteUrl ?? "";
    const host = (() => {
      try {
        return new URL(site).hostname;
      } catch {
        return "";
      }
    })();
    if (host && host === m[1]) {
      const key = m[2];
      return { provider: "atlassian", url: clean, fetch: (s) => withToken(s, "atlassian", async (t, conn) => jiraCard(await jira.getIssue(t, conn, key))) };
    }
  }
  if (NOTION_RE.test(clean) && connected.has("notion")) {
    let id: string;
    try {
      id = notion.parsePageId(clean);
    } catch {
      return null;
    }
    return { provider: "notion", url: clean, fetch: (s) => withToken(s, "notion", async (t) => notionCard(await notion.getPage(t, id))) };
  }
  return null;
}

async function cardFor(sub: string, target: Target): Promise<BotCard | null> {
  const key = `${sub}\n${target.url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.card;
  if (!allowed(sub)) return null;
  let card: BotCard | null = null;
  try {
    card = await target.fetch(sub);
  } catch {
    // Not found, no access, expired connection…: no preview.
    card = null;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), card });
  return card;
}

/** Called (async, fire-and-forget) after a person's message is posted. */
export async function unfurlMessage(m: ChatMessage): Promise<void> {
  if (!m.author || m.author.bot || m.ephemeral || m.deleted || !m.body.includes("https://")) return;
  if (m.meta?.cards?.length) return;
  const row = chatGet("SELECT sub FROM users WHERE id = ? AND bot_id IS NULL", m.author.id);
  const sub = typeof row?.sub === "string" ? row.sub : "";
  if (!sub) return;
  const connected = connectedProviders(sub);
  if (!connected.size) return;
  const urls = [...new Set(m.body.match(URL_RE) ?? [])].slice(0, 10);
  const targets: Target[] = [];
  for (const url of urls) {
    const t = classify(url, connected, sub);
    if (t && !targets.some((x) => x.url === t.url)) targets.push(t);
    if (targets.length >= MAX_PER_MESSAGE) break;
  }
  if (!targets.length) return;
  const cards = (await Promise.all(targets.map((t) => cardFor(sub, t)))).filter((c): c is BotCard => !!c);
  if (cards.length) attachUnfurls(m.id, cards);
}
