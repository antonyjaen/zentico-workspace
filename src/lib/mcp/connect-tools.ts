// Tools over the user's connected apps (Settings → Apps & bots → Connected apps): GitHub, Google
// Calendar/Drive, Jira, Notion, Slack. Each tool names its provider and is only listed for users
// who have that provider connected (tools.ts). Calls run with the token's user's own connection
// (keyed by their OIDC sub); results are trimmed and never include tokens.
import { isTimeZone } from "@/app/(apps)/calendar/time";
import * as github from "../connect/github";
import * as google from "../connect/google";
import { ProviderError } from "../connect/http";
import * as jira from "../connect/jira";
import * as notion from "../connect/notion";
import type { ProviderId } from "../connect/providers";
import * as slack from "../connect/slack";
import { withToken, type Connection } from "../connect/store";
import { bool, emailList, int, oneOf, str, strList, ToolError, type Args } from "./args";
import { parseWhen } from "./calendar-tools";
import { A, B, I, S, type Tool, type ToolContext } from "./kit";

/** Runs fn with the user's token for the provider; provider failures become tool errors. */
async function use<T>(ctx: ToolContext, id: ProviderId, fn: (token: string, conn: Connection) => Promise<T>): Promise<T> {
  try {
    return await withToken(ctx.session.sub, id, fn);
  } catch (e) {
    if (e instanceof ProviderError) throw new ToolError(e.message);
    throw e;
  }
}

/** Validation helpers from the provider modules throw ProviderError("invalid"). */
function arg<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ProviderError) throw new ToolError(e.message);
    throw e;
  }
}

function required(a: Args, key: string, max: number): string {
  const v = str(a, key, { required: true, max }).trim();
  if (!v) throw new ToolError(`Missing required argument "${key}"`);
  return v;
}

/* ------------------------------------------------------------------ GitHub */

const REPO = S('Repository as "owner/repo".');
const STATE = (def: string) => S("open, closed or all.", { enum: ["open", "closed", "all"], default: def });

const GITHUB_TOOLS: Tool[] = [
  {
    name: "github_list_issues",
    provider: "github",
    description:
      "Lists GitHub issues (not pull requests), most recently updated first: of one repository, or — without `repo` — the issues assigned to the user across GitHub.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        state: STATE("open"),
        labels: S("Comma-separated label names (all must match)."),
        assignee: S('Login to filter by, "none" or "*" (repo only).'),
        limit: I("Max results.", 1, 50, 20),
      },
    },
    async run(a, ctx) {
      const repo = a.repo ? arg(() => github.parseRepo(a.repo)) : undefined;
      const state = oneOf(a, "state", ["open", "closed", "all"] as const, "open");
      const labels = str(a, "labels", { max: 300 });
      const assignee = str(a, "assignee", { max: 60 });
      if (assignee && !/^(\*|none|[A-Za-z0-9-]{1,39})$/.test(assignee)) throw new ToolError('"assignee" must be a GitHub login, "none" or "*"');
      const limit = int(a, "limit", { min: 1, max: 50, def: 20 });
      return { issues: await use(ctx, "github", (t) => github.listIssues(t, { repo, state, labels, assignee, limit })) };
    },
  },
  {
    name: "github_get_issue",
    provider: "github",
    description: "Reads one GitHub issue or pull request: title, state, labels, body and the newest comments.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO, number: I("Issue or pull request number.", 1, 1_000_000_000), comments: I("How many of the newest comments to include.", 0, 30, 10) },
      required: ["repo", "number"],
    },
    async run(a, ctx) {
      const repo = arg(() => github.parseRepo(a.repo));
      const n = arg(() => github.parseNumber(a.number));
      const comments = int(a, "comments", { min: 0, max: 30, def: 10 });
      return use(ctx, "github", (t) => github.getIssue(t, repo, n, comments));
    },
  },
  {
    name: "github_create_issue",
    provider: "github",
    write: true,
    openWorld: true,
    description: "Creates a GitHub issue in a repository, as the user.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        title: S("Issue title."),
        body: S("Issue description (GitHub Markdown)."),
        labels: A("Label names (must exist in the repository)."),
        assignees: A("GitHub logins to assign."),
      },
      required: ["repo", "title"],
    },
    async run(a, ctx) {
      const repo = arg(() => github.parseRepo(a.repo));
      const title = required(a, "title", 256);
      const body = str(a, "body", { max: 60_000 });
      const labels = strList(a, "labels", { max: 20, itemMax: 50 });
      const assignees = strList(a, "assignees", { max: 10, itemMax: 39 });
      return use(ctx, "github", (t) => github.createIssue(t, repo, { title, body, labels, assignees }));
    },
  },
  {
    name: "github_comment",
    provider: "github",
    write: true,
    openWorld: true,
    description: "Adds a comment to a GitHub issue or pull request, as the user.",
    inputSchema: {
      type: "object",
      properties: { repo: REPO, number: I("Issue or pull request number.", 1, 1_000_000_000), body: S("Comment (GitHub Markdown).") },
      required: ["repo", "number", "body"],
    },
    async run(a, ctx) {
      const repo = arg(() => github.parseRepo(a.repo));
      const n = arg(() => github.parseNumber(a.number));
      const body = required(a, "body", 60_000);
      return use(ctx, "github", (t) => github.addComment(t, repo, n, body));
    },
  },
  {
    name: "github_list_prs",
    provider: "github",
    description: "Lists pull requests of a GitHub repository, most recently updated first.",
    inputSchema: { type: "object", properties: { repo: REPO, state: STATE("open"), limit: I("Max results.", 1, 50, 20) }, required: ["repo"] },
    async run(a, ctx) {
      const repo = arg(() => github.parseRepo(a.repo));
      const state = oneOf(a, "state", ["open", "closed", "all"] as const, "open");
      const limit = int(a, "limit", { min: 1, max: 50, def: 20 });
      return { pullRequests: await use(ctx, "github", (t) => github.listPulls(t, repo, state, limit)) };
    },
  },
  {
    name: "github_notifications",
    provider: "github",
    description: "The user's GitHub notifications (unread by default): review requests, mentions, assignments, CI…",
    inputSchema: {
      type: "object",
      properties: {
        all: B("Include notifications already read."),
        participating: B("Only those where the user is directly involved (mentioned, assigned, review requested)."),
        limit: I("Max results.", 1, 50, 20),
      },
    },
    async run(a, ctx) {
      const opts = { all: bool(a, "all"), participating: bool(a, "participating"), limit: int(a, "limit", { min: 1, max: 50, def: 20 }) };
      return { notifications: await use(ctx, "github", (t) => github.notifications(t, opts)) };
    },
  },
];

/* ------------------------------------------------------------------ Google */

const DAY = 86_400_000;

function zone(a: Args): string {
  const tz = str(a, "timeZone", { max: 64 });
  if (tz && !isTimeZone(tz)) throw new ToolError('"timeZone" must be an IANA time zone such as "Europe/Madrid"');
  return tz ?? "UTC";
}

const GOOGLE_TOOLS: Tool[] = [
  {
    name: "gcal_list_events",
    provider: "google",
    description:
      "Lists events of the user's Google Calendar (the primary calendar unless calendarId is given) between two times, recurring events expanded. Defaults to the next 7 days.",
    inputSchema: {
      type: "object",
      properties: {
        from: S("Start: ISO 8601 date-time with offset, or local YYYY-MM-DD[THH:MM] in timeZone. Default: now."),
        to: S("End (same formats). Default: from + 7 days."),
        timeZone: S("IANA time zone for local times (default UTC)."),
        query: S("Free-text filter."),
        calendarId: S('Google calendar id (default "primary").'),
        limit: I("Max events.", 1, 100, 50),
      },
    },
    async run(a, ctx) {
      const tz = zone(a);
      const fromRaw = str(a, "from", { max: 40 });
      const toRaw = str(a, "to", { max: 40 });
      const from = fromRaw ? parseWhen(fromRaw, tz, "from") : Date.now();
      const to = toRaw ? parseWhen(toRaw, tz, "to") : from + 7 * DAY;
      if (to <= from) throw new ToolError('"to" must be after "from"');
      if (to - from > 366 * DAY) throw new ToolError("The range can't exceed one year");
      const calendarId = arg(() => google.parseCalendarId(a.calendarId));
      const query = str(a, "query", { max: 200 });
      const limit = int(a, "limit", { min: 1, max: 100, def: 50 });
      return use(ctx, "google", (t) =>
        google.listEvents(t, { calendarId, timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), query, limit }),
      );
    },
  },
  {
    name: "gcal_create_event",
    provider: "google",
    write: true,
    openWorld: true,
    description:
      "Creates an event in the user's Google Calendar. Attendees get Google's invitation emails. Times: ISO 8601 with offset, or local YYYY-MM-DDTHH:MM with timeZone; all-day events take YYYY-MM-DD dates (end exclusive).",
    inputSchema: {
      type: "object",
      properties: {
        title: S("Event title."),
        start: S("Start date-time (or date for all-day)."),
        end: S("End date-time (or exclusive end date for all-day). Default: start + 1 hour (or 1 day)."),
        allDay: B("All-day event."),
        timeZone: S("IANA time zone for local times (default UTC)."),
        description: S("Description."),
        location: S("Location."),
        attendees: A("Email addresses to invite."),
        calendarId: S('Google calendar id (default "primary").'),
      },
      required: ["title", "start"],
    },
    async run(a, ctx) {
      const title = required(a, "title", 300);
      const allDay = bool(a, "allDay");
      const tz = zone(a);
      const startRaw = required(a, "start", 40);
      const endRaw = str(a, "end", { max: 40 });
      let start: string;
      let end: string;
      if (allDay) {
        const DATE = /^\d{4}-\d{2}-\d{2}$/;
        if (!DATE.test(startRaw) || (endRaw && !DATE.test(endRaw))) throw new ToolError("All-day events take YYYY-MM-DD dates");
        start = startRaw;
        end = endRaw ?? new Date(Date.parse(`${startRaw}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
        if (end <= start) throw new ToolError('"end" must be after "start"');
      } else {
        const s = parseWhen(startRaw, tz, "start");
        const e = endRaw ? parseWhen(endRaw, tz, "end") : s + 3_600_000;
        if (e <= s) throw new ToolError('"end" must be after "start"');
        start = new Date(s).toISOString();
        end = new Date(e).toISOString();
      }
      const attendees = emailList(a, "attendees", 50);
      const calendarId = arg(() => google.parseCalendarId(a.calendarId));
      return use(ctx, "google", (t) =>
        google.createEvent(t, {
          calendarId,
          title,
          start,
          end,
          allDay,
          timeZone: str(a, "timeZone", { max: 64 }) ? tz : undefined,
          description: str(a, "description", { max: 8000 }),
          location: str(a, "location", { max: 500 }),
          attendees,
        }),
      );
    },
  },
  {
    name: "gdrive_search",
    provider: "google",
    description: "Searches the user's Google Drive (names and contents; read-only). Without a query: the most recently modified files.",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Text to search for."),
        mimeType: S('Exact MIME type filter, e.g. "application/vnd.google-apps.document".'),
        limit: I("Max results.", 1, 50, 20),
      },
    },
    async run(a, ctx) {
      const query = str(a, "query", { max: 200 }) ?? "";
      const mimeType = str(a, "mimeType", { max: 120 });
      if (mimeType && !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new ToolError('"mimeType" is not a valid MIME type');
      const limit = int(a, "limit", { min: 1, max: 50, def: 20 });
      return { files: await use(ctx, "google", (t) => google.driveSearch(t, { query, mimeType, limit })) };
    },
  },
  {
    name: "gdrive_read_text",
    provider: "google",
    description: "Reads a Google Drive file as text: Google Docs/Slides as plain text, Sheets as CSV (first sheet), and text-like files (txt, md, csv, json…).",
    inputSchema: {
      type: "object",
      properties: { fileId: S("Drive file id (or its URL)."), maxChars: I("Max characters returned.", 1000, 100_000, 20_000) },
      required: ["fileId"],
    },
    async run(a, ctx) {
      const fileId = arg(() => google.parseFileId(a.fileId));
      const maxChars = int(a, "maxChars", { min: 1000, max: 100_000, def: 20_000 });
      return use(ctx, "google", (t) => google.driveReadText(t, fileId, maxChars));
    },
  },
];

/* -------------------------------------------------------------------- Jira */

const JIRA_TOOLS: Tool[] = [
  {
    name: "jira_search",
    provider: "atlassian",
    description:
      'Searches Jira issues with JQL, e.g. "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC" or "project = PROJ AND text ~ \\"login\\"".',
    inputSchema: { type: "object", properties: { jql: S("JQL query."), limit: I("Max results.", 1, 50, 20) }, required: ["jql"] },
    async run(a, ctx) {
      const jql = required(a, "jql", 2000);
      const limit = int(a, "limit", { min: 1, max: 50, def: 20 });
      return use(ctx, "atlassian", async (t, conn) => ({ site: conn.meta.siteUrl ?? null, issues: await jira.search(t, conn, jql, limit) }));
    },
  },
  {
    name: "jira_get_issue",
    provider: "atlassian",
    description: "Reads one Jira issue: summary, status, assignee, priority and description.",
    inputSchema: { type: "object", properties: { issue: S('Issue key ("PROJ-123") or its URL.') }, required: ["issue"] },
    async run(a, ctx) {
      const key = arg(() => jira.parseIssueKey(a.issue));
      return use(ctx, "atlassian", (t, conn) => jira.getIssue(t, conn, key, true));
    },
  },
  {
    name: "jira_create_issue",
    provider: "atlassian",
    write: true,
    description: "Creates a Jira issue, as the user.",
    inputSchema: {
      type: "object",
      properties: {
        project: S('Project key, e.g. "PROJ".'),
        summary: S("Summary (title)."),
        description: S("Description (plain text; blank lines separate paragraphs)."),
        issueType: S('Issue type name (default "Task"), e.g. "Bug", "Story".'),
      },
      required: ["project", "summary"],
    },
    async run(a, ctx) {
      const project = arg(() => jira.parseProjectKey(a.project));
      const summary = required(a, "summary", 255).replace(/\s+/g, " ");
      const description = str(a, "description", { max: 30_000 });
      const issueType = str(a, "issueType", { max: 60 })?.trim() || "Task";
      return use(ctx, "atlassian", (t, conn) => jira.createIssue(t, conn, { project, summary, description, issueType }));
    },
  },
  {
    name: "jira_comment",
    provider: "atlassian",
    write: true,
    description: "Adds a comment to a Jira issue, as the user.",
    inputSchema: { type: "object", properties: { issue: S('Issue key ("PROJ-123") or its URL.'), body: S("Comment (plain text).") }, required: ["issue", "body"] },
    async run(a, ctx) {
      const key = arg(() => jira.parseIssueKey(a.issue));
      const body = required(a, "body", 30_000);
      return use(ctx, "atlassian", (t, conn) => jira.addComment(t, conn, key, body));
    },
  },
];

/* ------------------------------------------------------------------ Notion */

const NOTION_TOOLS: Tool[] = [
  {
    name: "notion_search",
    provider: "notion",
    description: "Searches Notion pages by title (only pages the user shared with Zentico when connecting). Without a query: recently edited pages.",
    inputSchema: { type: "object", properties: { query: S("Text to search for."), limit: I("Max results.", 1, 50, 20) } },
    async run(a, ctx) {
      const query = str(a, "query", { max: 200 }) ?? "";
      const limit = int(a, "limit", { min: 1, max: 50, def: 20 });
      return { pages: await use(ctx, "notion", (t) => notion.search(t, query, limit)) };
    },
  },
  {
    name: "notion_read_page",
    provider: "notion",
    description: "Reads a Notion page as Markdown-like text (top-level blocks).",
    inputSchema: {
      type: "object",
      properties: { page: S("Page id or URL."), maxChars: I("Max characters returned.", 1000, 100_000, 20_000) },
      required: ["page"],
    },
    async run(a, ctx) {
      const id = arg(() => notion.parsePageId(a.page));
      const maxChars = int(a, "maxChars", { min: 1000, max: 100_000, def: 20_000 });
      return use(ctx, "notion", (t) => notion.readPage(t, id, maxChars));
    },
  },
  {
    name: "notion_append",
    provider: "notion",
    write: true,
    description: "Appends text to the end of a Notion page as paragraphs (blank lines separate them).",
    inputSchema: { type: "object", properties: { page: S("Page id or URL."), text: S("Text to append.") }, required: ["page", "text"] },
    async run(a, ctx) {
      const id = arg(() => notion.parsePageId(a.page));
      const text = required(a, "text", 100_000);
      return use(ctx, "notion", async (t) => ({ page: id, ...(await notion.appendText(t, id, text)) }));
    },
  },
];

/* ------------------------------------------------------------------- Slack */

const SLACK_TOOLS: Tool[] = [
  {
    name: "slack_list_channels",
    provider: "slack",
    description: "Lists Slack channels the user can see (public, and private ones they belong to).",
    inputSchema: { type: "object", properties: { query: S("Filter by name (substring)."), limit: I("Max results.", 1, 200, 50) } },
    async run(a, ctx) {
      const query = str(a, "query", { max: 80 });
      const limit = int(a, "limit", { min: 1, max: 200, def: 50 });
      return use(ctx, "slack", async (t, conn) => ({ team: conn.meta.team ?? null, channels: await slack.listChannels(t, limit, query) }));
    },
  },
  {
    name: "slack_post_message",
    provider: "slack",
    write: true,
    openWorld: true,
    description: "Posts a message to a Slack channel as the user (Slack mrkdwn).",
    inputSchema: {
      type: "object",
      properties: { channel: S("Channel id (C…) or #name."), text: S("Message text."), threadTs: S("Reply in this thread (parent message ts).") },
      required: ["channel", "text"],
    },
    async run(a, ctx) {
      const text = required(a, "text", 40_000);
      const threadTs = str(a, "threadTs", { max: 30 });
      if (threadTs && !/^\d{1,12}\.\d{1,8}$/.test(threadTs)) throw new ToolError('"threadTs" must be a Slack message ts such as "1700000000.123456"');
      return use(ctx, "slack", async (t) => slack.postMessage(t, await slack.resolveChannel(t, a.channel), text, threadTs));
    },
  },
];

export const CONNECT_TOOLS: Tool[] = [...GITHUB_TOOLS, ...GOOGLE_TOOLS, ...JIRA_TOOLS, ...NOTION_TOOLS, ...SLACK_TOOLS];
