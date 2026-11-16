// GitHub REST calls used by the MCP tools, link unfurling and the GitHub chat app. Results are
// trimmed to what's useful (never tokens). Server-only.
import { callApi } from "./api";
import { arr, clip, obj, ProviderError, str } from "./http";

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** "owner/repo" (also accepts a github.com URL); throws "invalid" otherwise. */
export function parseRepo(v: unknown): string {
  let s = typeof v === "string" ? v.trim() : "";
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s#?]+)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/\.git$/i, "");
  if (!REPO.test(s) || s.split("/")[1].startsWith(".")) throw new ProviderError("invalid", 'Expected a repository as "owner/repo".');
  return s;
}

export function parseNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/^#/, "")) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > 1e9) throw new ProviderError("invalid", "Expected an issue or pull request number.");
  return n;
}

const gh = (token: string, path: string, opts: Parameters<typeof callApi>[3] = {}) =>
  callApi("github", token, `${API}${path}`, { ...opts, headers: { ...HEADERS, ...(opts.headers ?? {}) } });

const login = (u: unknown) => str(obj(u).login) || null;

export type IssueSummary = {
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  author: string | null;
  assignees: string[];
  labels: string[];
  comments: number;
  created: string;
  updated: string;
  url: string;
  repo: string;
};

function repoOf(i: Record<string, unknown>): string {
  const u = str(i.repository_url);
  return u.startsWith(`${API}/repos/`) ? u.slice(`${API}/repos/`.length) : "";
}

function issueSummary(raw: unknown): IssueSummary {
  const i = obj(raw);
  const pr = obj(i.pull_request);
  return {
    number: Number(i.number),
    title: clip(str(i.title), 300),
    state: pr.merged_at ? "merged" : str(i.state),
    isPullRequest: !!i.pull_request,
    author: login(i.user),
    assignees: arr(i.assignees).map(login).filter((x): x is string => !!x).slice(0, 10),
    labels: arr(i.labels).map((l) => str(obj(l).name)).filter(Boolean).slice(0, 10),
    comments: Number(i.comments ?? 0),
    created: str(i.created_at),
    updated: str(i.updated_at),
    url: str(i.html_url),
    repo: repoOf(i),
  };
}

export async function listIssues(
  token: string,
  opts: { repo?: string; state: "open" | "closed" | "all"; labels?: string; assignee?: string; limit: number; includePullRequests?: boolean },
): Promise<IssueSummary[]> {
  const q = new URLSearchParams({ state: opts.state, per_page: String(Math.min(100, opts.limit * (opts.includePullRequests ? 1 : 2))), sort: "updated" });
  if (opts.labels) q.set("labels", opts.labels);
  let path: string;
  if (opts.repo) {
    if (opts.assignee) q.set("assignee", opts.assignee);
    path = `/repos/${opts.repo}/issues?${q}`;
  } else {
    q.set("filter", "assigned");
    path = `/issues?${q}`;
  }
  const { json } = await gh(token, path);
  return arr(json)
    .map(issueSummary)
    .filter((i) => opts.includePullRequests || !i.isPullRequest)
    .slice(0, opts.limit);
}

export async function getIssue(token: string, repo: string, n: number, comments: number) {
  const { json } = await gh(token, `/repos/${repo}/issues/${n}`);
  const i = obj(json);
  const out = { ...issueSummary(json), repo, body: clip(str(i.body), 8000), comments: [] as { author: string | null; created: string; body: string }[] };
  if (comments > 0 && Number(i.comments ?? 0) > 0) {
    const total = Number(i.comments);
    // The newest comments: the last page of size `comments`.
    const pageNo = Math.max(1, Math.ceil(total / comments));
    const { json: list } = await gh(token, `/repos/${repo}/issues/${n}/comments?per_page=${comments}&page=${pageNo}`);
    out.comments = arr(list).map((c) => ({ author: login(obj(c).user), created: str(obj(c).created_at), body: clip(str(obj(c).body), 2000) }));
  }
  return out;
}

export async function createIssue(token: string, repo: string, input: { title: string; body?: string; labels?: string[]; assignees?: string[] }) {
  const { json } = await gh(token, `/repos/${repo}/issues`, {
    method: "POST",
    body: { title: input.title, ...(input.body ? { body: input.body } : {}), ...(input.labels?.length ? { labels: input.labels } : {}), ...(input.assignees?.length ? { assignees: input.assignees } : {}) },
  });
  return { ...issueSummary(json), repo };
}

export async function addComment(token: string, repo: string, n: number, body: string) {
  const { json } = await gh(token, `/repos/${repo}/issues/${n}/comments`, { method: "POST", body: { body } });
  const c = obj(json);
  return { id: Number(c.id), url: str(c.html_url), created: str(c.created_at) };
}

export async function listPulls(token: string, repo: string, state: "open" | "closed" | "all", limit: number) {
  const { json } = await gh(token, `/repos/${repo}/pulls?state=${state}&per_page=${Math.min(100, limit)}&sort=updated&direction=desc`);
  return arr(json)
    .slice(0, limit)
    .map((raw) => {
      const p = obj(raw);
      return {
        number: Number(p.number),
        title: clip(str(p.title), 300),
        state: p.merged_at ? "merged" : str(p.state),
        draft: p.draft === true,
        author: login(p.user),
        assignees: arr(p.assignees).map(login).filter(Boolean),
        reviewers: arr(p.requested_reviewers).map(login).filter(Boolean),
        head: str(obj(p.head).ref),
        base: str(obj(p.base).ref),
        created: str(p.created_at),
        updated: str(p.updated_at),
        url: str(p.html_url),
      };
    });
}

export async function getPull(token: string, repo: string, n: number) {
  const { json } = await gh(token, `/repos/${repo}/pulls/${n}`);
  const p = obj(json);
  return {
    number: n,
    title: clip(str(p.title), 300),
    state: p.merged_at ? "merged" : str(p.state),
    draft: p.draft === true,
    author: login(p.user),
    assignees: arr(p.assignees).map(login).filter((x): x is string => !!x),
    url: str(p.html_url),
  };
}

export async function notifications(token: string, opts: { all: boolean; participating: boolean; limit: number }) {
  const q = new URLSearchParams({ all: String(opts.all), participating: String(opts.participating), per_page: String(Math.min(50, opts.limit)) });
  const { json } = await gh(token, `/notifications?${q}`);
  return arr(json)
    .slice(0, opts.limit)
    .map((raw) => {
      const n = obj(raw);
      const subject = obj(n.subject);
      // API URL → web URL for issues and pulls.
      const api = str(subject.url);
      const web = api.startsWith(`${API}/repos/`) ? `https://github.com/${api.slice(`${API}/repos/`.length).replace("/pulls/", "/pull/")}` : "";
      return {
        id: str(n.id),
        unread: n.unread === true,
        reason: str(n.reason),
        updated: str(n.updated_at),
        repo: str(obj(n.repository).full_name),
        type: str(subject.type),
        title: clip(str(subject.title), 300),
        url: web || null,
      };
    });
}

export async function repoInfo(token: string, repo: string) {
  const { json } = await gh(token, `/repos/${repo}`);
  const r = obj(json);
  return { fullName: str(r.full_name) || repo, private: r.private === true, url: str(r.html_url) };
}

/**
 * Newest issues and pull requests of a repo (for subscriptions), with conditional requests:
 * a 304 (no change) costs no rate limit. Returns null items when unchanged.
 */
export async function recentItems(token: string, repo: string, etag: string | null) {
  const res = await gh(token, `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=20`, {
    headers: etag ? { "If-None-Match": etag } : {},
    okStatuses: [304],
  });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? NaN);
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? NaN) * 1000;
  return {
    items: res.status === 304 ? null : arr(res.json).map((raw) => ({ ...issueSummary(raw), id: str(obj(raw).id), body: clip(str(obj(raw).body), 300) })),
    etag: res.headers.get("etag"),
    rateRemaining: Number.isFinite(remaining) ? remaining : null,
    rateReset: Number.isFinite(reset) ? reset : null,
  };
}
