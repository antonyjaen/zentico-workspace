// Zentico UI ("Studio"): the user's Dashboard is built from plain files in their own Drive, under
// `Zentico UI/` (ui.json, theme.json, keys.json, mods/<id>/…, plus AGENTS.md for agents). This
// module is client-safe and pure: formats, the component / permission / query / action catalogs,
// and checkUi(), the validator that compiles the files into what the Dashboard renders. Its errors
// are written for agents: file + JSON pointer + what was expected. Inputs come from files anyone
// (or any agent) may have written: validate everything, never trust shapes.
import { DashError, WIDGETS, type WidgetType } from "@/app/(apps)/dashboard/model";
import { contrastIssues } from "./workspace";

export const UI_FOLDER = "Zentico UI";
export const GUIDE_FILE = "AGENTS.md";
export const UI_FILE = "ui.json";
export const THEME_FILE = "theme.json";
export const KEYS_FILE = "keys.json";
export const MODS_DIR = "mods";

export const MAX_PAGES = 20;
export const MAX_DEPTH = 8;
export const MAX_NODES_PER_PAGE = 80;
export const MAX_MODS = 20;
export const MAX_MOD_FILES = 12;
export const MOD_FILE_MAX_BYTES = 200 * 1024;
export const MOD_MAX_BYTES = 400 * 1024;
export const UI_FILE_MAX_BYTES = 512 * 1024;
export const SMALL_FILE_MAX_BYTES = 64 * 1024;
export const CONFIG_MAX_BYTES = 8 * 1024;
export const MAX_KEYS = 60;
export const GRID_COLUMNS = 12;
export const GRID_MAX_ROWS = 400;

export const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MOD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MOD_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.(json|html|css|js|md|txt)$/;

/** Every path an agent may write under `Zentico UI/`. */
export const UI_PATH = /^(AGENTS\.md|ui\.json|theme\.json|keys\.json|mods\/[a-z0-9][a-z0-9-]{0,39}\/[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.(json|html|css|js|md|txt))$/;
export const isUiPath = (p: unknown): p is string => typeof p === "string" && UI_PATH.test(p);

export type UiError = { file: string; pointer: string; message: string; expected?: string };

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/* ------------------------------------------------------------------- icons */

/** Lucide icons usable by name (pages, mods). A fixed set keeps the client bundle small. */
export const ICON_NAMES = [
  "layout-dashboard", "house", "inbox", "mail", "mail-open", "message-square", "message-circle", "calendar", "calendar-days",
  "calendar-check", "clock", "timer", "alarm-clock", "video", "users", "user", "hard-drive", "folder", "folder-open", "file-text",
  "book-open", "notebook", "sticky-note", "list-todo", "square-check", "kanban", "columns-2", "layout-grid", "layout-list", "star",
  "heart", "flag", "bookmark", "bell", "zap", "sparkles", "bot", "brain", "target", "trophy", "rocket", "briefcase", "building",
  "chart-bar", "chart-line", "chart-pie", "trending-up", "activity", "coffee", "sun", "moon", "globe", "map", "compass", "link",
  "hash", "at-sign", "phone", "headphones", "camera", "image", "palette", "pen-line", "code", "terminal", "settings", "wrench",
  "shield", "lock", "key", "search", "funnel", "tag", "archive", "package", "shopping-cart", "credit-card", "wallet",
  "dollar-sign", "gift", "graduation-cap", "lightbulb", "leaf", "flame", "plane", "car", "gauge", "focus", "layers", "rows-3",
  "panels-top-left", "circle-check", "megaphone", "newspaper", "handshake", "clipboard-list",
] as const;
export type IconName = (typeof ICON_NAMES)[number];
export const isIconName = (v: unknown): v is IconName => typeof v === "string" && (ICON_NAMES as readonly string[]).includes(v);

/* ------------------------------------------------------------- permissions */

/** What a mod may do. Reads unlock queries and live events; writes unlock actions (each confirmed). */
export const PERMISSIONS = [
  "mail.read",
  "mail.modify",
  "mail.draft",
  "calendar.read",
  "calendar.write",
  "chat.read",
  "chat.send",
  "drive.read",
  "drive.write",
  "contacts.read",
  "meetings.read",
  "claude",
  "mcp",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const isPermission = (v: unknown): v is Permission => typeof v === "string" && (PERMISSIONS as readonly string[]).includes(v);

export const PERMISSION_DOCS: Record<Permission, string> = {
  "mail.read": "Search mail and read threads; receive new-mail events.",
  "mail.modify": "Mark mail read/unread, star, archive (mail.markRead, mail.flag, mail.archive).",
  "mail.draft": "Create mail drafts (mail.draft). Never sends.",
  "calendar.read": "Read calendar events; receive calendar events (reminders, invitations).",
  "calendar.write": "Create calendar events (calendar.create).",
  "chat.read": "List chat conversations and read messages; receive chat-message events.",
  "chat.send": "Post chat messages as the user (chat.send).",
  "drive.read": "List, search and read Drive text files.",
  "drive.write": "Create or overwrite Drive text files (.md, .txt, .json) (drive.writeText).",
  "contacts.read": "Search contacts and the directory.",
  "meetings.read": "List meeting recordings and upcoming meetings.",
  claude: "Send requests to the user's own assistant (zentico.agent.ask, alias zentico.claude.ask); shown in the assistant panel.",
  mcp: 'Call tools of the user\'s connected MCP servers, limited to the manifest\'s "mcp" scopes (zentico.mcp). Added automatically when "mcp" scopes are declared.',
};

/** One MCP scope of a mod: a connected server (by slug, or "*") and the tools it may call ("*" = all). */
export type McpScope = { server: string; tools: string[] };
const MCP_SERVER = /^(?:\*|[a-z0-9][a-z0-9_-]{0,63})$/;
const MCP_TOOL = /^(?:\*|[A-Za-z0-9_.-]{1,64})$/;
/** Grant keys of MCP scopes, e.g. "mcp:github/search_issues" (approved like permissions). */
export const mcpScopeKeys = (scopes: McpScope[]) => scopes.flatMap((s) => s.tools.map((t) => `mcp:${s.server}/${t}`));
export const isMcpScopeKey = (v: unknown): v is string => typeof v === "string" && /^mcp:[^/\s]{1,64}\/[^/\s]{1,64}$/.test(v);
/** Whether `scopes` allow calling `tool` (null = any) on a server known by `ids` (its id and slug). */
export const mcpAllows = (scopes: McpScope[], ids: string[], tool: string | null) =>
  scopes.some((s) => (s.server === "*" || ids.includes(s.server)) && (tool === null || s.tools.includes("*") || s.tools.includes(tool)));

/** Queries a mod can run with zentico.query(name, args), and the permission each needs. */
export const MOD_QUERIES: Record<string, { permission: Permission | null; args: string; returns: string }> = {
  "calendar.events": { permission: "calendar.read", args: "{ days?: 1-14 (3), limit?: 1-50 (12) }", returns: '{ timeZone, events: [{ id, title, start, end, allDay, location, attendees (count), people: ["Name <email> (status)"], declined, href, meetHref }] }' },
  "calendar.range": { permission: "calendar.read", args: '{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" (exclusive, ≤ 31 days), limit?: 1-200 (100) }', returns: "{ timeZone, events: [...] } (same event shape)" },
  "mail.search": { permission: "mail.read", args: "{ query?: string, folder?: string, unreadOnly?: boolean, limit?: 1-50 (8) }", returns: "{ total, items: [{ threadId, from, subject, preview, receivedAt, unread, flagged, messages, href }] }" },
  "mail.thread": { permission: "mail.read", args: "{ threadId: string }", returns: "{ threadId, subject, href, messages: [{ emailId, from, to, date, unread, flagged, body (≤ 4000 chars) }] }" },
  "chat.conversations": { permission: "chat.read", args: "{ unreadOnly?: boolean, limit?: 1-50 (8) }", returns: "{ items: [{ id, kind, name, team, unread, lastMessage: { author, preview, at }, href }] }" },
  "chat.messages": { permission: "chat.read", args: "{ conversationId: string, limit?: 1-50 (8) }", returns: "{ conversationId, href, items: [{ id, author, at, body, kind }] }" },
  "tasks.mine": { permission: "chat.read", args: "{ includeDone?: boolean, limit?: 1-50 (20) }", returns: '{ timeZone, items: [{ id, title, status, priority, due ("YYYY-MM-DD" or local ISO), overdue, subtasks ("2/5 done"), conversation, parentTitle, href }] }' },
  "drive.recent": { permission: "drive.read", args: "{ limit?: 1-50 (10) }", returns: "{ items: [{ id, name, folder, type, size, modified, href }] }" },
  "drive.folder": { permission: "drive.read", args: "{ folderId: string, limit?: 1-50 (10) }", returns: "{ folderId, href, total, items: [...] }" },
  "drive.search": { permission: "drive.read", args: "{ query: string, limit?: 1-50 (20) }", returns: "{ items: [...] }" },
  "drive.read": { permission: "drive.read", args: "{ fileId: string }", returns: "{ id, name, modified, text (≤ 200 KB), truncated }" },
  "contacts.search": { permission: "contacts.read", args: "{ query: string, limit?: 1-50 (10) }", returns: "{ items: [{ name, emails, company, title }] }" },
  "meetings.upcoming": { permission: "meetings.read", args: "{ days?: 1-14 (7), limit?: 1-20 (5) }", returns: "{ timeZone, events: [...] }" },
  "meetings.recordings": { permission: "meetings.read", args: "{ limit?: 1-20 (5) }", returns: "{ items: [{ id, title, startedAt, durationMinutes, status, href }] }" },
  "dashboard.state": { permission: null, args: "{}", returns: "{ pages: [{ id, title, icon, pinned }], currentPage }" },
};

/** Write actions a mod can run with zentico.action(name, args): permission + in-app confirmation. */
export const MOD_ACTIONS: Record<string, { permission: Permission; args: string; description: string }> = {
  "mail.markRead": { permission: "mail.modify", args: "{ threadId: string, read?: boolean (true) }", description: "Mark a conversation read or unread." },
  "mail.flag": { permission: "mail.modify", args: "{ threadId: string, flagged: boolean }", description: "Star or unstar a conversation." },
  "mail.archive": { permission: "mail.modify", args: "{ threadId: string }", description: "Move a conversation to Archive." },
  "mail.draft": { permission: "mail.draft", args: "{ to?: string[], subject?: string, body: string, replyToEmailId?: string }", description: "Create a draft (never sends)." },
  "chat.send": { permission: "chat.send", args: "{ conversationId: string, body: string (≤ 4000) }", description: "Post a chat message as the user." },
  "calendar.create": {
    permission: "calendar.write",
    args: '{ title: string, start: "YYYY-MM-DDTHH:MM" (viewer time zone) or ISO, end?: same, durationMinutes?: 5-1440, location?: string, description?: string, attendees?: string[] }',
    description: "Create a calendar event (invitations are sent to attendees).",
  },
  "drive.writeText": { permission: "drive.write", args: "{ fileId?: string, name?: string (.md/.txt/.json), folderId?: string, content: string (≤ 512 KB) }", description: "Create or overwrite a text file in Drive." },
};

/** Live events (zentico.on(name, fn)) and the permission each needs. */
export const MOD_EVENTS: Record<string, { permission: Permission | null; data: string }> = {
  mail: { permission: "mail.read", data: "{ kind, title, body, ref (thread id), at }" },
  chat: { permission: "chat.read", data: "{ kind, title, body, ref (conversation id), at }" },
  calendar: { permission: "calendar.read", data: "{ kind (reminder | invite), title, body, at }" },
  command: { permission: null, data: "{ id, args } — a command from the mod's menu or keys.json" },
  selection: { permission: null, data: '{ kind: "mail.thread" | "chat.conversation" | "drive.file", id } — set by a list on the page' },
  theme: { permission: null, data: "{ dark }" },
  config: { permission: null, data: "the instance config, when ui.json changes it" },
};

/* -------------------------------------------------------- props mini-schema */

export type JsonSchema = Record<string, unknown>;

const S = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const I = (description: string, minimum: number, maximum: number, def?: number): JsonSchema => ({ type: "integer", description, minimum, maximum, ...(def !== undefined ? { default: def } : {}) });
const B = (description: string, def: boolean): JsonSchema => ({ type: "boolean", description, default: def });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

class Errs {
  list: UiError[] = [];
  constructor(public file: string) {}
  add(pointer: string, message: string, expected?: string) {
    if (this.list.length < 100) this.list.push({ file: this.file, pointer: pointer || "/", message, ...(expected ? { expected } : {}) });
  }
}

const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

/** Validates `v` against a small JSON-schema subset; returns the cleaned value (defaults filled). */
function vSchema(s: JsonSchema, v: unknown, ptr: string, e: Errs): unknown {
  const t = s.type;
  const types = Array.isArray(t) ? t : [t];
  if (v === null && types.includes("null")) return null;
  if (types.includes("string") && typeof v === "string") {
    if (s.enum && !(s.enum as unknown[]).includes(v)) e.add(ptr, `must be one of ${(s.enum as unknown[]).map(show).join(", ")} (got ${show(v)})`);
    if (typeof s.maxLength === "number" && v.length > s.maxLength) e.add(ptr, `is too long (${v.length} characters, max ${s.maxLength})`);
    return v;
  }
  if ((types.includes("integer") || types.includes("number")) && typeof v === "number" && Number.isFinite(v)) {
    if (types.includes("integer") && !types.includes("number") && !Number.isInteger(v)) e.add(ptr, `must be an integer (got ${v})`);
    if (typeof s.minimum === "number" && v < s.minimum) e.add(ptr, `must be ≥ ${s.minimum} (got ${v})`);
    if (typeof s.maximum === "number" && v > s.maximum) e.add(ptr, `must be ≤ ${s.maximum} (got ${v})`);
    return v;
  }
  if (types.includes("boolean") && typeof v === "boolean") return v;
  if (types.includes("array") && Array.isArray(v)) {
    if (typeof s.maxItems === "number" && v.length > s.maxItems) e.add(ptr, `has ${v.length} items (max ${s.maxItems})`);
    return s.items ? v.map((x, i) => vSchema(s.items as JsonSchema, x, `${ptr}/${i}`, e)) : v;
  }
  if (types.includes("object") && isObj(v)) {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    const out: Raw = {};
    if (s.additionalProperties === false) {
      for (const k of Object.keys(v)) if (!(k in props)) e.add(`${ptr}/${esc(k)}`, `unknown property "${k}"`, `one of: ${Object.keys(props).join(", ") || "(none)"}`);
    }
    for (const k of (s.required as string[] | undefined) ?? []) if (v[k] == null) e.add(`${ptr}/${esc(k)}`, `is required`);
    for (const [k, ps] of Object.entries(props)) {
      if (v[k] === undefined) {
        if (ps.default !== undefined) out[k] = ps.default;
        continue;
      }
      out[k] = vSchema(ps, v[k], `${ptr}/${esc(k)}`, e);
    }
    if (s.additionalProperties !== false) for (const k of Object.keys(v)) if (!(k in props)) out[k] = v[k];
    return out;
  }
  const want = types.filter(Boolean).join(" or ");
  const range = typeof s.minimum === "number" && typeof s.maximum === "number" ? ` between ${s.minimum} and ${s.maximum}` : "";
  const choices = s.enum ? `: ${(s.enum as unknown[]).map(show).join(", ")}` : "";
  e.add(ptr, `must be ${/^[aeiou]/.test(want) ? "an" : "a"} ${want}${range}${choices} (got ${show(v)})`);
  return s.default;
}

/* ------------------------------------------------------- component catalog */

export type ComponentSpec = {
  description: string;
  props: JsonSchema;
  /** Grid size defaults (12 columns, ~44 px rows). */
  size: { w: number; h: number; minW: number; minH: number };
  /** The legacy dashboard widget type it maps to (strict config rules shared with model.ts). */
  widget?: WidgetType;
  example: Raw;
};

const legacy = (type: WidgetType, extra: Record<string, JsonSchema> = {}, example: Raw = {}): ComponentSpec => {
  const w = WIDGETS[type];
  const schema = w.schema as { properties?: Record<string, JsonSchema>; required?: string[] };
  return {
    description: w.description,
    props: { ...w.schema, properties: { ...(schema.properties ?? {}), ...extra } },
    size: { w: w.defW, h: w.defH, minW: w.minW, minH: w.minH },
    widget: type,
    example,
  };
};

export const COMPONENTS: Record<string, ComponentSpec> = {
  agenda: legacy("agenda", {}, { days: 3 }),
  mail: legacy(
    "mail",
    { openIn: S('Where a click opens a conversation: "app" (the Mail app) or "reader" (a mail.thread component on the same page).', { enum: ["app", "reader"], default: "app" }) },
    { mode: "search", query: "from:ana", limit: 10, openIn: "reader" },
  ),
  chat: legacy("chat", {}, { mode: "unread" }),
  drive: legacy("drive", {}, { mode: "recent", limit: 8 }),
  meetings: legacy("meetings", {}, { upcoming: true, recordings: true }),
  notes: legacy("notes", {}, { text: "### Today\n- [ ] Ship it" }),
  links: legacy("links", {}, { items: [{ label: "Drive", url: "/drive" }] }),
  clock: legacy("clock", {}, { zones: [{ timeZone: "Europe/Madrid", label: "Madrid" }] }),
  chart: legacy("chart", {}, { kind: "bar", labels: ["Q1", "Q2"], series: [{ name: "Sales", values: [3, 5] }] }),
  custom: legacy("custom", {}, { html: "<b>Hello</b>" }),
  "mail.thread": {
    description: "Mail thread reader. Shows `threadId`, or (when omitted) the conversation selected in a `mail` component with openIn=\"reader\" on the same page. Has quick actions (mark read, star, archive, reply in Mail).",
    props: obj({ threadId: S("Thread id (from mail_search). Omit to follow the page selection.") }),
    size: { w: 6, h: 10, minW: 3, minH: 4 },
    example: {},
  },
  "chat.conversation": {
    description: "One chat conversation: latest messages plus a composer to reply as the user. Without `conversationId` it shows a picker that saves the choice into ui.json.",
    props: obj({
      conversationId: S("Conversation id (from chat_list_conversations). Omit to let the user pick."),
      limit: I("Messages shown.", 5, 100, 30),
      composer: B("Show the message box.", true),
    }),
    size: { w: 4, h: 10, minW: 3, minH: 4 },
    example: { conversationId: "c_123", composer: true },
  },
  "calendar.week": {
    description: "Calendar week grid (columns per day) from the user's calendars.",
    props: obj({
      days: I("Number of days shown.", 1, 14, 7),
      start: S('"week" = from Monday of this week; "today" = from today.', { enum: ["week", "today"], default: "week" }),
      fromHour: I("First hour shown.", 0, 23, 8),
      toHour: I("Last hour shown (exclusive).", 1, 24, 19),
    }),
    size: { w: 8, h: 10, minW: 4, minH: 6 },
    example: { days: 5, start: "week" },
  },
  "drive.folder": {
    description: "Contents of one Drive folder, by `folderId` or by `path` from My Drive's root (e.g. \"Projects/Q4\"). Without either it shows a picker.",
    props: obj({
      folderId: S("Folder id (from drive_list / drive_search)."),
      path: S('Folder path from the root, e.g. "Team/Shared".', { maxLength: 300 }),
      limit: I("Max entries.", 1, 50, 20),
    }),
    size: { w: 4, h: 7, minW: 3, minH: 4 },
    example: { path: "Projects" },
  },
  "doc.markdown": {
    description: "Renders a Markdown file from Drive (read-only, refreshes when it changes), by `fileId` or `path` (e.g. \"Notes/weekly.md\"). Without either it shows a picker of .md files.",
    props: obj({
      fileId: S("File id of a .md file."),
      path: S('File path from the root, e.g. "Notes/weekly.md".', { maxLength: 300 }),
    }),
    size: { w: 4, h: 8, minW: 3, minH: 3 },
    example: { path: "Notes/weekly.md" },
  },
  "meetings.next": {
    description: "Next meeting card: title, time, countdown and a Join button when it has a Meet link.",
    props: obj({ days: I("Look this many days ahead.", 1, 14, 7) }),
    size: { w: 4, h: 4, minW: 3, minH: 3 },
    example: {},
  },
  claude: {
    description: "The assistant chat panel (the user's own agent: Claude Code, Codex, … via their bridge). Use it inside a layout; the Dashboard also has a side panel.",
    props: obj({}),
    size: { w: 4, h: 12, minW: 3, minH: 6 },
    example: {},
  },
};
export const COMPONENT_NAMES = Object.keys(COMPONENTS);

/* ------------------------------------------------------------- compiled UI */

type NodeBase = { key: string; ptr: string; id?: string; title?: string; height?: number; x?: number; y?: number; w?: number; h?: number };
export type ContainerType = "row" | "column" | "tabs" | "stack" | "grid";
export type UiNode =
  | (NodeBase & { type: "row" | "column"; children: UiNode[]; sizes: number[] })
  | (NodeBase & { type: "tabs"; children: UiNode[]; active: number })
  | (NodeBase & { type: "stack"; children: UiNode[]; gap: number })
  | (NodeBase & { type: "grid"; children: UiNode[]; rowHeight: number })
  | (NodeBase & { type: "component"; component: string; props: Raw; chrome: "card" | "plain" })
  | (NodeBase & { type: "mod"; mod: string; config: Raw; chrome: "card" | "plain" });
export type UiContainer = Extract<UiNode, { children: UiNode[] }>;
export const isContainer = (n: UiNode): n is UiContainer => "children" in n;

export type Density = "compact" | "comfortable" | "spacious";
export type PageTheme = { accent?: string; density?: Density; background?: Background };
/** A page turned into its own app in the rail (/x/<id>), optionally with sub-pages ("sections"). */
export type UiApp = {
  id: string;
  name: string;
  icon: IconName;
  color?: string;
  hidden: boolean;
  order: number;
  sections: { id: string; title: string; icon: IconName; layout: UiNode; ptr: string }[];
};
export type UiPage = { id: string; title: string; icon: IconName; pinned: boolean; theme: PageTheme; layout: UiNode; ptr: string; app?: UiApp };

export type Background = "plain" | "muted" | "grid" | "dots";
export type Font = "system" | "sans" | "serif" | "mono" | "rounded";
/** Per color scheme. `ink`, `line` and the bubble colors only apply with a workspace-scoped theme. */
export type ModeOverride = {
  accent?: string;
  canvas?: string;
  card?: string;
  ink?: string;
  line?: string;
  bubbleMine?: string;
  bubbleOther?: string;
  vars: Record<string, string>;
};
/** "dashboard" (default): the theme styles the Dashboard and rail apps; "workspace": the whole app. */
export type ThemeScope = "dashboard" | "workspace";
export type UiTheme = {
  scope: ThemeScope;
  accent?: string;
  radius?: number;
  density: Density;
  font: Font;
  background: Background;
  light: ModeOverride;
  dark: ModeOverride;
  vars: Record<string, string>;
};

export const APP_TARGETS = ["mail", "calendar", "chat", "drive", "meet", "contacts", "dashboard", "settings"] as const;
export type KeyAction =
  | { action: "goto"; page: string }
  | { action: "open"; app?: (typeof APP_TARGETS)[number]; href?: string }
  | { action: "mod"; mod: string; command: string }
  | { action: "claude" }
  | { action: "edit" }
  | { action: "gallery" };
export type KeyBinding = KeyAction & { key: string; description?: string };

export type ModCommand = { id: string; title: string; description?: string };
export type ModManifest = {
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: Permission[];
  commands: ModCommand[];
  size: { w: number; h: number; height: number };
  config: Raw;
  author?: string;
  icon: IconName;
  mcp: McpScope[];
};
export type ModView = ModManifest & { id: string; html: string; bytes: number; hash: string };

/* ------------------------------------------------------------------ shell */

/** Built-in apps the rail can order or hide (they stay reachable by URL and from the settings menu). */
export const BUILTIN_APPS = ["mail", "dashboard", "chat", "calendar", "drive", "meet", "contacts"] as const;
export type BuiltinApp = (typeof BUILTIN_APPS)[number];
/** Places outside the Dashboard where a mod can run: a right-side panel in an app, or the top bar. */
export const SLOT_NAMES = ["mail.side", "chat.side", "calendar.side", "drive.side", "topbar"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
export const TOPBAR_ITEMS = ["search", "notifications", "theme", "launcher"] as const;
export type TopbarItem = (typeof TOPBAR_ITEMS)[number];
/** Never hideable: the settings menu holds "Restore default UI"; the account menu holds sign-out. */
export const LOCKED_TOPBAR_ITEMS = ["settings", "account"] as const;
/** Built-in shortcut that opens "Customize with Claude"; keys.json can't rebind it. */
export const CUSTOMIZE_KEY = "alt+shift+k";
export type ShellSlot = { mod: string; title?: string; config: Raw; width: number; open: boolean };
/** ui.json `shell`: the workspace around the apps (rail, landing app, density, top bar, slots). */
export type ShellPrefs = {
  /** Rail entries: built-in app ids and "app:<path>" for custom apps. */
  rail: { order: string[]; hidden: string[]; labels: boolean };
  /** Landing app after sign-in ("mail", …, or "app:<path>"); null = Mail. */
  home: string | null;
  /** null = follow theme.json (compact when a workspace theme says "compact"). */
  density: "compact" | "comfortable" | null;
  topbar: Record<TopbarItem, boolean>;
  slots: Partial<Record<SlotName, ShellSlot>>;
};
export const DEFAULT_SHELL: ShellPrefs = {
  rail: { order: [], hidden: [], labels: true },
  home: null,
  density: null,
  topbar: { search: true, notifications: true, theme: true, launcher: true },
  slots: {},
};

export type CompiledUi = { pages: UiPage[]; theme: UiTheme; keys: KeyBinding[]; mods: Record<string, ModView>; shell: ShellPrefs };
export type CheckResult = { ok: boolean; errors: UiError[]; ui: CompiledUi | null };

/* ----------------------------------------------------------------- helpers */

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[0-9.%,\s/+-]+\)$/;
const NAMED_COLOR = /^(?:transparent|currentcolor|white|black|[a-z]{3,20})$/;
export const isColor = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && (HEX.test(v) || FUNC_COLOR.test(v) || NAMED_COLOR.test(v));
const VAR_NAME = /^--[a-z][a-z0-9-]{0,40}$/;
const VAR_VALUE = /^[#a-zA-Z0-9 .,%()+\-/*]{1,100}$/;
/** CSS custom property values: colors, lengths, numbers, simple functions. Never url()/image(). */
export const isSafeVarValue = (v: unknown): v is string => typeof v === "string" && VAR_VALUE.test(v) && !/url|image|expression|attr/i.test(v);

/** Stable short hash (FNV-1a) for change detection, not security. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function parseJson(text: string | undefined, file: string, e: Errs, max: number): unknown {
  if (text === undefined) return undefined;
  if (utf8Bytes(text) > max) {
    e.add("", `file is larger than ${Math.round(max / 1024)} KB`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid JSON";
    const at = /position (\d+)/.exec(msg);
    let where = "";
    if (at) {
      const pos = Number(at[1]);
      const before = text.slice(0, pos);
      where = ` at line ${before.split("\n").length}, column ${pos - before.lastIndexOf("\n")}`;
    }
    e.add("", `is not valid JSON${where}: ${msg.replace(/^JSON\.parse: /, "")}`, `a JSON document (${file})`);
    return undefined;
  }
}

function onlyKeys(o: Raw, keys: readonly string[], ptr: string, e: Errs) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) e.add(`${ptr}/${esc(k)}`, `unknown property "${k}"`, `one of: ${keys.join(", ")}`);
}

function str(o: Raw, k: string, ptr: string, e: Errs, opts: { max: number; required?: boolean; re?: RegExp; reHint?: string }): string | undefined {
  const v = o[k];
  if (v == null) {
    if (opts.required) e.add(`${ptr}/${k}`, "is required", opts.reHint ?? "a string");
    return undefined;
  }
  if (typeof v !== "string") {
    e.add(`${ptr}/${k}`, `must be a string (got ${show(v)})`, opts.reHint);
    return undefined;
  }
  if (v.length > opts.max) e.add(`${ptr}/${k}`, `is too long (${v.length} characters, max ${opts.max})`);
  if (CONTROL.test(v)) e.add(`${ptr}/${k}`, "contains control characters");
  if (opts.re && !opts.re.test(v)) e.add(`${ptr}/${k}`, `is not valid (got ${show(v)})`, opts.reHint);
  return v;
}

function num(o: Raw, k: string, ptr: string, e: Errs, min: number, max: number, int = true): number | undefined {
  const v = o[k];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || (int && !Number.isInteger(v)) || v < min || v > max) {
    e.add(`${ptr}/${k}`, `must be ${int ? "an integer" : "a number"} between ${min} and ${max} (got ${show(v)})`);
    return undefined;
  }
  return v;
}

function oneOf<T extends string>(o: Raw, k: string, ptr: string, e: Errs, values: readonly T[]): T | undefined {
  const v = o[k];
  if (v == null) return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) {
    e.add(`${ptr}/${k}`, `must be one of ${values.map((x) => `"${x}"`).join(", ")} (got ${show(v)})`);
    return undefined;
  }
  return v as T;
}

/* ------------------------------------------------------------------ layout */

const CONTAINERS = ["row", "column", "tabs", "stack", "grid"] as const;
const NODE_TYPES = [...CONTAINERS, "component", "mod"] as const;
const COMMON = ["type", "id", "title", "height", "x", "y", "w", "h"];

type Ctx = { e: Errs; mods: Set<string>; ids: Set<string>; count: number; modSizes: Map<string, { w: number; h: number }> };

function compileNode(raw: unknown, ptr: string, depth: number, ctx: Ctx, parent: ContainerType | null): UiNode | null {
  const { e } = ctx;
  if (!isObj(raw)) {
    e.add(ptr, `must be a layout node object (got ${show(raw)})`, `{ "type": ${NODE_TYPES.map((t) => `"${t}"`).join(" | ")}, … }`);
    return null;
  }
  if (++ctx.count > MAX_NODES_PER_PAGE) {
    if (ctx.count === MAX_NODES_PER_PAGE + 1) e.add(ptr, `a page can have at most ${MAX_NODES_PER_PAGE} nodes`);
    return null;
  }
  const type = raw.type;
  if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
    e.add(`${ptr}/type`, `unknown node type ${show(type)}`, NODE_TYPES.join(", "));
    return null;
  }
  const base: NodeBase = { key: "", ptr };
  const id = str(raw, "id", ptr, e, { max: 40, re: NODE_ID, reHint: "letters, digits, _ or -, 1-40 characters" });
  if (id) {
    if (ctx.ids.has(id)) e.add(`${ptr}/id`, `duplicate id "${id}" on this page`);
    ctx.ids.add(id);
    base.id = id;
  }
  base.key = id ?? `n${ptr.replace(/[^0-9]+/g, ".")}`;
  const title = str(raw, "title", ptr, e, { max: 80 });
  if (title) base.title = title;
  const height = num(raw, "height", ptr, e, 60, 2000);
  if (height != null) {
    if (parent !== "stack") e.add(`${ptr}/height`, `"height" only applies to children of a "stack"`);
    base.height = height;
  }
  if (parent === "grid") {
    for (const k of ["x", "y", "w", "h"] as const) {
      if (raw[k] == null) e.add(`${ptr}/${k}`, `is required for an item of a "grid" (x: column 0-11, y: row, w: width in columns, h: height in rows)`);
    }
    base.x = num(raw, "x", ptr, e, 0, GRID_COLUMNS - 1) ?? 0;
    base.y = num(raw, "y", ptr, e, 0, GRID_MAX_ROWS - 1) ?? 0;
    base.w = num(raw, "w", ptr, e, 1, GRID_COLUMNS) ?? 4;
    base.h = num(raw, "h", ptr, e, 1, 40) ?? 6;
    if (base.x + base.w > GRID_COLUMNS) e.add(`${ptr}/w`, `x + w must be ≤ ${GRID_COLUMNS} (x=${base.x}, w=${base.w})`);
  } else {
    for (const k of ["x", "y", "w", "h"]) if (raw[k] != null) e.add(`${ptr}/${k}`, `"${k}" only applies to items of a "grid"`);
  }

  if ((CONTAINERS as readonly string[]).includes(type)) {
    const t = type as ContainerType;
    const extra = t === "row" || t === "column" ? ["children", "sizes"] : t === "tabs" ? ["children", "active"] : t === "stack" ? ["children", "gap"] : ["children", "rowHeight"];
    onlyKeys(raw, [...COMMON, ...extra], ptr, e);
    if (depth >= MAX_DEPTH) {
      e.add(ptr, `layout is nested too deeply (max ${MAX_DEPTH} levels)`);
      return null;
    }
    if (!Array.isArray(raw.children) || !raw.children.length) {
      e.add(`${ptr}/children`, "must be a non-empty array of layout nodes");
      return null;
    }
    if (raw.children.length > 24) e.add(`${ptr}/children`, `has ${raw.children.length} children (max 24)`);
    const children = raw.children
      .slice(0, 24)
      .map((c, i) => compileNode(c, `${ptr}/children/${i}`, depth + 1, ctx, t))
      .filter((c): c is UiNode => !!c);
    if (t === "row" || t === "column") {
      let sizes: number[] = children.map(() => 1);
      if (raw.sizes != null) {
        if (!Array.isArray(raw.sizes) || raw.sizes.length !== (raw.children as unknown[]).length || raw.sizes.some((s) => typeof s !== "number" || !Number.isFinite(s) || s <= 0 || s > 1000)) {
          e.add(`${ptr}/sizes`, `must be an array of ${(raw.children as unknown[]).length} positive numbers (relative weights, e.g. [2, 1] = two thirds / one third)`);
        } else sizes = (raw.sizes as number[]).slice(0, children.length);
      }
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      return { ...base, type: t, children, sizes: sizes.map((s) => (s / total) * 100) };
    }
    if (t === "tabs") {
      const active = num(raw, "active", ptr, e, 0, 23) ?? 0;
      children.forEach((c, i) => {
        if (!c.title) e.add(`${ptr}/children/${i}/title`, 'is required for a child of "tabs" (it is the tab label)');
      });
      return { ...base, type: t, children, active: Math.min(active, children.length - 1) };
    }
    if (t === "stack") return { ...base, type: t, children, gap: num(raw, "gap", ptr, e, 0, 48) ?? 12 };
    // grid
    return { ...base, type: "grid", children, rowHeight: num(raw, "rowHeight", ptr, e, 24, 120) ?? 44 };
  }

  const chrome = oneOf(raw, "chrome", ptr, e, ["card", "plain"] as const) ?? "card";
  if (type === "component") {
    onlyKeys(raw, [...COMMON, "component", "props", "chrome"], ptr, e);
    const name = raw.component;
    if (typeof name !== "string" || !COMPONENTS[name]) {
      e.add(`${ptr}/component`, `unknown component ${show(name)}`, COMPONENT_NAMES.join(", "));
      return null;
    }
    const spec = COMPONENTS[name];
    if (raw.props != null && !isObj(raw.props)) {
      e.add(`${ptr}/props`, `must be an object (got ${show(raw.props)})`);
      return null;
    }
    const before = e.list.length;
    let props = vSchema(spec.props, raw.props ?? {}, `${ptr}/props`, e) as Raw;
    if (spec.widget && e.list.length === before) {
      const { openIn, ...rest } = props;
      try {
        props = { ...WIDGETS[spec.widget].validate(rest), ...(openIn !== undefined ? { openIn } : {}) };
      } catch (err) {
        if (err instanceof DashError) e.add(`${ptr}/props`, err.message.replace(/^\w+ config: /, ""));
        else throw err;
      }
    }
    if (name === "drive.folder" && props.folderId && props.path) e.add(`${ptr}/props`, 'use either "folderId" or "path", not both');
    if (name === "doc.markdown" && props.fileId && props.path) e.add(`${ptr}/props`, 'use either "fileId" or "path", not both');
    if (name === "calendar.week" && Number(props.toHour) <= Number(props.fromHour)) e.add(`${ptr}/props/toHour`, "must be greater than fromHour");
    if (parent === "grid" && base.w != null && base.h != null && (base.w < spec.size.minW || base.h < spec.size.minH)) {
      e.add(ptr, `"${name}" needs at least w=${spec.size.minW}, h=${spec.size.minH} in a grid (got w=${base.w}, h=${base.h})`);
    }
    return { ...base, type: "component", component: name, props, chrome };
  }
  // mod
  onlyKeys(raw, [...COMMON, "mod", "config", "chrome"], ptr, e);
  const mod = str(raw, "mod", ptr, e, { max: 40, required: true, re: MOD_ID, reHint: "a mod id: a folder name under mods/" });
  if (!mod) return null;
  if (!ctx.mods.has(mod)) e.add(`${ptr}/mod`, `no mod "${mod}" (expected a folder mods/${mod}/ with manifest.json)`, ctx.mods.size ? [...ctx.mods].join(", ") : "add the mod folder first");
  let config: Raw = {};
  if (raw.config != null) {
    if (!isObj(raw.config)) e.add(`${ptr}/config`, "must be an object");
    else if (utf8Bytes(JSON.stringify(raw.config)) > CONFIG_MAX_BYTES) e.add(`${ptr}/config`, `is larger than ${CONFIG_MAX_BYTES / 1024} KB`);
    else config = raw.config;
  }
  return { ...base, type: "mod", mod, config, chrome };
}

function compilePages(raw: unknown, ctx: Omit<Ctx, "ids" | "count">): UiPage[] {
  const { e } = ctx;
  if (!isObj(raw)) {
    e.add("", "must be a JSON object", '{ "version": 1, "pages": [ … ] }');
    return [];
  }
  onlyKeys(raw, ["$schema", "version", "pages", "shell"], "", e);
  if (raw.version != null && raw.version !== 1) e.add("/version", `must be 1 (got ${show(raw.version)})`);
  if (!Array.isArray(raw.pages) || !raw.pages.length) {
    e.add("/pages", "must be a non-empty array of pages", '[{ "id": "home", "title": "Home", "layout": { … } }]');
    return [];
  }
  if (raw.pages.length > MAX_PAGES) e.add("/pages", `has ${raw.pages.length} pages (max ${MAX_PAGES})`);
  const seen = new Set<string>();
  const appIds = new Set<string>();
  const pages: UiPage[] = [];
  raw.pages.slice(0, MAX_PAGES).forEach((p, i) => {
    const ptr = `/pages/${i}`;
    if (!isObj(p)) {
      e.add(ptr, "must be a page object", '{ "id", "title", "icon"?, "pinned"?, "theme"?, "layout" }');
      return;
    }
    onlyKeys(p, ["id", "title", "icon", "pinned", "theme", "layout", "app"], ptr, e);
    const id = str(p, "id", ptr, e, { max: 32, required: true, re: PAGE_ID, reHint: "lowercase letters, digits and -, e.g. \"home\"" });
    if (id && seen.has(id)) e.add(`${ptr}/id`, `duplicate page id "${id}"`);
    if (id) seen.add(id);
    const title = str(p, "title", ptr, e, { max: 40, required: true }) ?? id ?? "Page";
    let icon: IconName = "layout-dashboard";
    if (p.icon != null) {
      if (isIconName(p.icon)) icon = p.icon;
      else e.add(`${ptr}/icon`, `unknown icon ${show(p.icon)}`, `a Lucide icon name from the list in AGENTS.md, e.g. "inbox", "calendar", "kanban"`);
    }
    if (p.pinned != null && typeof p.pinned !== "boolean") e.add(`${ptr}/pinned`, "must be true or false");
    const theme: PageTheme = {};
    if (p.theme != null) {
      if (!isObj(p.theme)) e.add(`${ptr}/theme`, "must be an object", '{ "accent"?, "density"?, "background"? }');
      else {
        onlyKeys(p.theme, ["accent", "density", "background"], `${ptr}/theme`, e);
        if (p.theme.accent != null) {
          if (isColor(p.theme.accent)) theme.accent = p.theme.accent;
          else e.add(`${ptr}/theme/accent`, `must be a CSS color (got ${show(p.theme.accent)})`, '"#0f9f8f"');
        }
        theme.density = oneOf(p.theme, "density", `${ptr}/theme`, e, ["compact", "comfortable", "spacious"] as const);
        theme.background = oneOf(p.theme, "background", `${ptr}/theme`, e, ["plain", "muted", "grid", "dots"] as const);
      }
    }
    if (p.layout == null) {
      e.add(`${ptr}/layout`, "is required", '{ "type": "row", "children": [ … ] }');
      return;
    }
    const layout = compileNode(p.layout, `${ptr}/layout`, 0, { ...ctx, ids: new Set(), count: 0 }, null);
    const app = p.app == null ? undefined : compileApp(p.app, `${ptr}/app`, id ?? "app", title, icon, ctx, appIds);
    if (id && layout) pages.push({ id, title, icon, pinned: p.pinned === true, theme, layout, ptr, ...(app ? { app } : {}) });
  });
  return pages;
}

function compileApp(raw: unknown, ptr: string, pageId: string, pageTitle: string, pageIcon: IconName, ctx: Omit<Ctx, "ids" | "count">, appIds: Set<string>): UiApp | undefined {
  const { e } = ctx;
  if (!isObj(raw)) {
    e.add(ptr, "must be an object", '{ "name": "CRM", "icon": "users", "color"?, "path"?, "hidden"?, "order"?, "sections"? }');
    return undefined;
  }
  onlyKeys(raw, ["name", "icon", "color", "path", "hidden", "order", "sections"], ptr, e);
  const name = str(raw, "name", ptr, e, { max: 24 }) ?? pageTitle;
  let icon = pageIcon;
  if (raw.icon != null) {
    if (isIconName(raw.icon)) icon = raw.icon;
    else e.add(`${ptr}/icon`, `unknown icon ${show(raw.icon)}`, "a Lucide icon name from AGENTS.md");
  }
  let color: string | undefined;
  if (raw.color != null) {
    if (isColor(raw.color)) color = raw.color;
    else e.add(`${ptr}/color`, `must be a CSS color (got ${show(raw.color)})`, '"#0f9f8f"');
  }
  const id = str(raw, "path", ptr, e, { max: 32, re: PAGE_ID, reHint: 'lowercase letters, digits and -: the app lives at /x/<path>' }) ?? pageId;
  if (appIds.has(id)) e.add(`${ptr}/path`, `another app already uses the path "${id}"`);
  appIds.add(id);
  if (raw.hidden != null && typeof raw.hidden !== "boolean") e.add(`${ptr}/hidden`, "must be true or false");
  const order = num(raw, "order", ptr, e, -1000, 1000) ?? 0;
  const sections: UiApp["sections"] = [];
  if (raw.sections != null) {
    if (!Array.isArray(raw.sections) || raw.sections.length > 12) e.add(`${ptr}/sections`, "must be an array of at most 12 sub-pages", '[{ "id": "pipeline", "title": "Pipeline", "icon": "kanban", "layout": { … } }]');
    else {
      const ids = new Set<string>([pageId]);
      raw.sections.forEach((sec, i) => {
        const sp = `${ptr}/sections/${i}`;
        if (!isObj(sec)) return e.add(sp, "must be an object", '{ "id", "title", "icon"?, "layout" }');
        onlyKeys(sec, ["id", "title", "icon", "layout"], sp, e);
        const sid = str(sec, "id", sp, e, { max: 32, required: true, re: PAGE_ID, reHint: "lowercase letters, digits and -" });
        if (sid && ids.has(sid)) e.add(`${sp}/id`, `duplicate sub-page id "${sid}" (the page's own id "${pageId}" is the first sub-page)`);
        if (sid) ids.add(sid);
        const stitle = str(sec, "title", sp, e, { max: 40, required: true }) ?? sid ?? "";
        let sicon: IconName = "layout-dashboard";
        if (sec.icon != null) {
          if (isIconName(sec.icon)) sicon = sec.icon;
          else e.add(`${sp}/icon`, `unknown icon ${show(sec.icon)}`, "a Lucide icon name from AGENTS.md");
        }
        if (sec.layout == null) return e.add(`${sp}/layout`, "is required");
        const layout = compileNode(sec.layout, `${sp}/layout`, 0, { ...ctx, ids: new Set(), count: 0 }, null);
        if (sid && layout) sections.push({ id: sid, title: stitle, icon: sicon, layout, ptr: sp });
      });
    }
  }
  return { id, name, icon, ...(color ? { color } : {}), hidden: raw.hidden === true, order, sections };
}

/* ------------------------------------------------------------------- theme */

const FONTS = ["system", "sans", "serif", "mono", "rounded"] as const;

function compileMode(raw: unknown, ptr: string, e: Errs): ModeOverride {
  const out: ModeOverride = { vars: {} };
  if (raw == null) return out;
  if (!isObj(raw)) {
    e.add(ptr, "must be an object", '{ "accent"?, "canvas"?, "card"?, "ink"?, "line"?, "bubbleMine"?, "bubbleOther"?, "vars"? }');
    return out;
  }
  onlyKeys(raw, ["accent", "canvas", "card", "ink", "line", "bubbleMine", "bubbleOther", "vars"], ptr, e);
  for (const k of ["accent", "canvas", "card", "ink", "line", "bubbleMine", "bubbleOther"] as const) {
    if (raw[k] == null) continue;
    if (isColor(raw[k])) out[k] = raw[k] as string;
    else e.add(`${ptr}/${k}`, `must be a CSS color (got ${show(raw[k])})`, '"#3b6cf6", "rgb(…)", "oklch(…)"');
  }
  out.vars = compileVars(raw.vars, `${ptr}/vars`, e);
  return out;
}

function compileVars(raw: unknown, ptr: string, e: Errs): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw == null) return out;
  if (!isObj(raw)) {
    e.add(ptr, "must be an object of CSS custom properties", '{ "--my-color": "#ff8800" }');
    return out;
  }
  const entries = Object.entries(raw);
  if (entries.length > 40) e.add(ptr, `has ${entries.length} variables (max 40)`);
  for (const [k, v] of entries.slice(0, 40)) {
    if (!VAR_NAME.test(k)) e.add(`${ptr}/${esc(k)}`, `invalid custom property name "${k}"`, 'a name like "--card-shadow" (lowercase, starts with --)');
    else if (!isSafeVarValue(v)) e.add(`${ptr}/${esc(k)}`, `invalid value ${show(v)}`, "a color, length or number (no url(), quotes, ; or braces)");
    else out[k] = v;
  }
  return out;
}

function compileTheme(raw: unknown, e: Errs): UiTheme {
  const theme: UiTheme = { scope: "dashboard", density: "comfortable", font: "system", background: "plain", light: { vars: {} }, dark: { vars: {} }, vars: {} };
  if (raw === undefined) return theme;
  if (!isObj(raw)) {
    e.add("", "must be a JSON object");
    return theme;
  }
  onlyKeys(raw, ["$schema", "scope", "accent", "radius", "density", "font", "background", "light", "dark", "vars"], "", e);
  theme.scope = oneOf(raw, "scope", "", e, ["dashboard", "workspace"] as const) ?? "dashboard";
  if (raw.accent != null) {
    if (isColor(raw.accent)) theme.accent = raw.accent;
    else e.add("/accent", `must be a CSS color (got ${show(raw.accent)})`, '"#3b6cf6"');
  }
  theme.radius = num(raw, "radius", "", e, 0, 28);
  theme.density = oneOf(raw, "density", "", e, ["compact", "comfortable", "spacious"] as const) ?? "comfortable";
  theme.font = oneOf(raw, "font", "", e, FONTS) ?? "system";
  theme.background = oneOf(raw, "background", "", e, ["plain", "muted", "grid", "dots"] as const) ?? "plain";
  theme.light = compileMode(raw.light, "/light", e);
  theme.dark = compileMode(raw.dark, "/dark", e);
  theme.vars = compileVars(raw.vars, "/vars", e);
  if (theme.scope === "workspace") {
    // Unreadable text across every app is worse than a plain theme: reject it with the numbers.
    for (const c of contrastIssues(theme)) e.add(c.pointer, c.message, c.expected);
  } else {
    for (const mode of ["light", "dark"] as const)
      for (const k of ["ink", "line", "bubbleMine", "bubbleOther"] as const)
        if (theme[mode][k] != null) e.add(`/${mode}/${k}`, `only applies with "scope": "workspace"`, '"scope": "workspace" (or remove it)');
  }
  // A theme with errors never styles the whole workspace (fall back to the Dashboard only).
  if (e.list.length) theme.scope = "dashboard";
  return theme;
}

/* -------------------------------------------------------------------- keys */

const KEY_NAMES = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|arrowup|arrowdown|arrowleft|arrowright|enter|escape|space|tab|slash|backslash|comma|period|semicolon|quote|bracketleft|bracketright|minus|equal|backquote)$/;
const MODIFIERS = ["ctrl", "alt", "shift", "meta", "mod"];

/** "ctrl+shift+k" / "g h" → normalized chords, or an error message. */
export function parseKey(key: string): { chords: string[] } | { error: string } {
  const parts = key.trim().toLowerCase().split(/\s+/);
  if (!parts.length || parts.length > 2 || !parts[0]) return { error: "must be one chord or a sequence of two (e.g. \"alt+1\" or \"g h\")" };
  const chords: string[] = [];
  for (const p of parts) {
    const bits = p.split("+");
    const k = bits.pop()!;
    if (!KEY_NAMES.test(k)) return { error: `unknown key "${k}" (a-z, 0-9, f1-f12, arrows, enter, escape, space, slash, comma, period…)` };
    const mods = [...new Set(bits)];
    for (const m of mods) if (!MODIFIERS.includes(m)) return { error: `unknown modifier "${m}" (ctrl, alt, shift, meta, mod = ctrl on Windows/Linux, ⌘ on Mac)` };
    chords.push([...MODIFIERS.filter((m) => mods.includes(m)), k].join("+"));
  }
  return { chords };
}

function compileKeys(raw: unknown, e: Errs, pages: Set<string>, mods: Map<string, ModManifest>): KeyBinding[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) {
    e.add("", "must be a JSON object", '{ "bindings": [ … ] }');
    return [];
  }
  onlyKeys(raw, ["$schema", "bindings"], "", e);
  if (!Array.isArray(raw.bindings)) {
    e.add("/bindings", "must be an array", '[{ "key": "alt+1", "action": "goto", "page": "home" }]');
    return [];
  }
  if (raw.bindings.length > MAX_KEYS) e.add("/bindings", `has ${raw.bindings.length} bindings (max ${MAX_KEYS})`);
  const seen = new Map<string, number>();
  const out: KeyBinding[] = [];
  raw.bindings.slice(0, MAX_KEYS).forEach((b, i) => {
    const ptr = `/bindings/${i}`;
    if (!isObj(b)) {
      e.add(ptr, "must be an object", '{ "key", "action", … }');
      return;
    }
    const key = str(b, "key", ptr, e, { max: 40, required: true });
    const parsed = key ? parseKey(key) : null;
    if (parsed && "error" in parsed) e.add(`${ptr}/key`, parsed.error);
    const norm = parsed && "chords" in parsed ? parsed.chords.join(" ") : null;
    if (norm === CUSTOMIZE_KEY) e.add(`${ptr}/key`, `"${key}" is reserved for "Customize with Claude"`, "another chord, e.g. alt+shift+j");
    if (norm) {
      if (seen.has(norm)) e.add(`${ptr}/key`, `"${key}" is already bound by /bindings/${seen.get(norm)}`);
      seen.set(norm, i);
    }
    const description = str(b, "description", ptr, e, { max: 80 });
    const action = b.action;
    const common = ["key", "action", "description"];
    let binding: KeyBinding | null = null;
    switch (action) {
      case "goto": {
        onlyKeys(b, [...common, "page"], ptr, e);
        const page = str(b, "page", ptr, e, { max: 32, required: true });
        if (page && !pages.has(page)) e.add(`${ptr}/page`, `no page "${page}" in ui.json`, [...pages].join(", "));
        if (page) binding = { key: norm ?? "", action, page };
        break;
      }
      case "open": {
        onlyKeys(b, [...common, "app", "href"], ptr, e);
        const app = oneOf(b, "app", ptr, e, APP_TARGETS);
        const href = str(b, "href", ptr, e, { max: 300 });
        if (href && (!href.startsWith("/") || href.startsWith("//") || /[\s\\]/.test(href))) e.add(`${ptr}/href`, "must be a workspace path starting with / (e.g. \"/drive?folder=…\")");
        if (!app && !href) e.add(ptr, 'needs "app" or "href"', `app: ${APP_TARGETS.join(", ")}`);
        if (app && href) e.add(ptr, 'use either "app" or "href", not both');
        binding = { key: norm ?? "", action, ...(app ? { app } : {}), ...(href ? { href } : {}) };
        break;
      }
      case "mod": {
        onlyKeys(b, [...common, "mod", "command"], ptr, e);
        const mod = str(b, "mod", ptr, e, { max: 40, required: true });
        const command = str(b, "command", ptr, e, { max: 32, required: true });
        const m = mod ? mods.get(mod) : undefined;
        if (mod && !m) e.add(`${ptr}/mod`, `no mod "${mod}"`, [...mods.keys()].join(", ") || "(no mods)");
        if (m && command && !m.commands.some((c) => c.id === command)) e.add(`${ptr}/command`, `mod "${mod}" has no command "${command}"`, m.commands.map((c) => c.id).join(", ") || "(declare commands in its manifest.json)");
        if (mod && command) binding = { key: norm ?? "", action, mod, command };
        break;
      }
      case "claude":
      case "edit":
      case "gallery":
        onlyKeys(b, common, ptr, e);
        binding = { key: norm ?? "", action };
        break;
      default:
        e.add(`${ptr}/action`, `unknown action ${show(action)}`, "goto, open, mod, claude, edit, gallery");
    }
    if (binding && norm) out.push(description ? { ...binding, description } : binding);
  });
  return out;
}

/* -------------------------------------------------------------------- mods */

function compileManifest(raw: unknown, file: string, e: Errs, files: Set<string>): ModManifest | null {
  if (!isObj(raw)) {
    e.add("", "must be a JSON object", '{ "name", "version", "description", "entry", "permissions", "commands", "size", "config" }');
    return null;
  }
  onlyKeys(raw, ["$schema", "name", "version", "description", "entry", "permissions", "commands", "size", "config", "author", "icon", "mcp"], "", e);
  const name = str(raw, "name", "", e, { max: 60, required: true }) ?? "";
  const version = str(raw, "version", "", e, { max: 20, re: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/, reHint: 'semantic version like "1.0.0"' }) ?? "1.0.0";
  const description = str(raw, "description", "", e, { max: 300 }) ?? "";
  const entry = str(raw, "entry", "", e, { max: 60, re: /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.html$/, reHint: 'an .html file in the mod folder, e.g. "index.html"' }) ?? "index.html";
  if (!files.has(entry)) e.add("/entry", `"${entry}" does not exist in ${file.replace(/manifest\.json$/, "")}`, "the mod's HTML file");
  const permissions: Permission[] = [];
  if (raw.permissions != null) {
    if (!Array.isArray(raw.permissions)) e.add("/permissions", "must be an array", PERMISSIONS.join(", "));
    else
      raw.permissions.forEach((p, i) => {
        if (!isPermission(p)) e.add(`/permissions/${i}`, `unknown permission ${show(p)}`, PERMISSIONS.join(", "));
        else if (!permissions.includes(p)) permissions.push(p);
      });
  }
  const commands: ModCommand[] = [];
  if (raw.commands != null) {
    if (!Array.isArray(raw.commands) || raw.commands.length > 20) e.add("/commands", "must be an array of at most 20 commands", '[{ "id": "start", "title": "Start timer" }]');
    else
      raw.commands.forEach((c, i) => {
        const ptr = `/commands/${i}`;
        if (!isObj(c)) return e.add(ptr, "must be an object", '{ "id", "title", "description"? }');
        onlyKeys(c, ["id", "title", "description"], ptr, e);
        const id = str(c, "id", ptr, e, { max: 32, required: true, re: /^[a-z0-9][a-z0-9-]{0,31}$/, reHint: "lowercase letters, digits and -" });
        const title = str(c, "title", ptr, e, { max: 60, required: true });
        const d = str(c, "description", ptr, e, { max: 200 });
        if (id && commands.some((x) => x.id === id)) e.add(`${ptr}/id`, `duplicate command "${id}"`);
        if (id && title) commands.push({ id, title, ...(d ? { description: d } : {}) });
      });
  }
  const size = { w: 4, h: 6, height: 360 };
  if (raw.size != null) {
    if (!isObj(raw.size)) e.add("/size", "must be an object", '{ "w": 4, "h": 6, "height": 360 }');
    else {
      onlyKeys(raw.size, ["w", "h", "height"], "/size", e);
      size.w = num(raw.size, "w", "/size", e, 2, GRID_COLUMNS) ?? size.w;
      size.h = num(raw.size, "h", "/size", e, 2, 40) ?? size.h;
      size.height = num(raw.size, "height", "/size", e, 80, 2000) ?? size.height;
    }
  }
  let config: Raw = {};
  if (raw.config != null) {
    if (!isObj(raw.config)) e.add("/config", "must be an object of default instance settings");
    else if (utf8Bytes(JSON.stringify(raw.config)) > CONFIG_MAX_BYTES) e.add("/config", `is larger than ${CONFIG_MAX_BYTES / 1024} KB`);
    else config = raw.config;
  }
  const mcp: McpScope[] = [];
  if (raw.mcp != null) {
    if (!Array.isArray(raw.mcp) || raw.mcp.length > 20) e.add("/mcp", "must be an array of at most 20 scopes", '[{ "server": "github", "tools": ["search_issues"] }]');
    else
      raw.mcp.forEach((sc, i) => {
        const ptr = `/mcp/${i}`;
        if (!isObj(sc)) return e.add(ptr, "must be an object", '{ "server": "<slug or *>", "tools": ["<tool name or *>"] }');
        onlyKeys(sc, ["server", "tools"], ptr, e);
        const server = str(sc, "server", ptr, e, { max: 64, required: true, re: MCP_SERVER, reHint: 'a connected server slug (lowercase), or "*" for any' });
        const tools: string[] = [];
        if (!Array.isArray(sc.tools) || !sc.tools.length || sc.tools.length > 50) e.add(`${ptr}/tools`, "must be a non-empty array of tool names (max 50)", '["search_issues"] or ["*"]');
        else
          sc.tools.forEach((t, j) => {
            if (typeof t !== "string" || !MCP_TOOL.test(t)) e.add(`${ptr}/tools/${j}`, `invalid tool name ${show(t)}`, 'a tool name or "*"');
            else tools.push(t);
          });
        if (server && tools.length) mcp.push({ server, tools });
      });
  }
  if (mcp.length && !permissions.includes("mcp")) permissions.push("mcp");
  if (!mcp.length && permissions.includes("mcp")) e.add("/permissions", '"mcp" needs at least one scope in "mcp"', '"mcp": [{ "server": "github", "tools": ["*"] }]');
  const author = str(raw, "author", "", e, { max: 80 });
  let icon: IconName = "sparkles";
  if (raw.icon != null) {
    if (isIconName(raw.icon)) icon = raw.icon;
    else e.add("/icon", `unknown icon ${show(raw.icon)}`, "a Lucide icon name from AGENTS.md");
  }
  return { name, version, description, entry, permissions, commands, size, config, ...(author ? { author } : {}), icon, mcp };
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Inlines `<link rel="stylesheet" href="x.css">` and `<script src="x.js"></script>` from the mod folder. */
function bundleMod(dir: string, entry: string, texts: Record<string, string>, e: Errs): string {
  const html = texts[entry] ?? "";
  const ref = (name: string, what: string): string | null => {
    if (EXTERNAL.test(name)) {
      e.add("", `${what} "${name}" is external: mods can't load anything from the network (CSP). Copy it into the mod folder or inline it`);
      return null;
    }
    const clean = name.replace(/^\.\//, "");
    if (!(clean in texts)) {
      e.add("", `${what} "${name}" does not exist in ${dir}/`, Object.keys(texts).join(", "));
      return null;
    }
    return texts[clean];
  };
  let out = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) return tag;
    const css = ref(href, "stylesheet");
    return css == null ? "" : `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
  });
  out = out.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (_m, a: string, src: string, b: string) => {
    const js = ref(src, "script");
    const attrs = `${a} ${b}`.replace(/\s+/g, " ").trim();
    return js == null ? "" : `<script${attrs ? ` ${attrs}` : ""}>${js.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
  return out;
}

function compileMods(texts: Record<string, string>, all: Errs[]): { mods: Record<string, ModView>; manifests: Map<string, ModManifest>; ids: Set<string> } {
  const byMod = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(texts)) {
    const m = /^mods\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) continue;
    const [, id, name] = m;
    const files = byMod.get(id) ?? {};
    files[name] = text;
    byMod.set(id, files);
  }
  const mods: Record<string, ModView> = {};
  const manifests = new Map<string, ModManifest>();
  const ids = new Set<string>();
  let count = 0;
  for (const [id, files] of [...byMod].sort(([a], [b]) => a.localeCompare(b))) {
    const dir = `mods/${id}`;
    if (!MOD_ID.test(id)) {
      const e = new Errs(dir);
      e.add("", `invalid mod folder name "${id}"`, "lowercase letters, digits and -, starting with a letter or digit (max 40)");
      all.push(e);
      continue;
    }
    if (++count > MAX_MODS) {
      const e = new Errs(dir);
      e.add("", `too many mods (max ${MAX_MODS})`);
      all.push(e);
      continue;
    }
    ids.add(id);
    const e = new Errs(dir);
    all.push(e);
    const names = Object.keys(files);
    if (names.length > MAX_MOD_FILES) e.add("", `has ${names.length} files (max ${MAX_MOD_FILES})`);
    let total = 0;
    for (const n of names) {
      const bytes = utf8Bytes(files[n]);
      total += bytes;
      if (!MOD_FILE_NAME.test(n)) e.add(`/${esc(n)}`, `unsupported file "${n}"`, ".json, .html, .css, .js, .md or .txt");
      if (bytes > MOD_FILE_MAX_BYTES) e.add(`/${esc(n)}`, `"${n}" is larger than ${MOD_FILE_MAX_BYTES / 1024} KB`);
    }
    if (total > MOD_MAX_BYTES) e.add("", `mod files total ${Math.round(total / 1024)} KB (max ${MOD_MAX_BYTES / 1024} KB)`);
    if (!("manifest.json" in files)) {
      e.add("", "is missing manifest.json", '{ "name", "version", "entry": "index.html", "permissions": [] }');
      continue;
    }
    const me = new Errs(`${dir}/manifest.json`);
    all.push(me);
    const manifest = compileManifest(parseJson(files["manifest.json"], `${dir}/manifest.json`, me, SMALL_FILE_MAX_BYTES), `${dir}/manifest.json`, me, new Set(names));
    if (!manifest) continue;
    manifests.set(id, manifest);
    const be = new Errs(`${dir}/${manifest.entry}`);
    all.push(be);
    const html = manifest.entry in files ? bundleMod(dir, manifest.entry, files, be) : "";
    mods[id] = { ...manifest, id, html, bytes: utf8Bytes(html), hash: hashText(html + JSON.stringify(manifest)) };
  }
  return { mods, manifests, ids };
}

/* ------------------------------------------------------------------- shell */

const appRef = (v: string, apps: Set<string>) => (BUILTIN_APPS as readonly string[]).includes(v) || (v.startsWith("app:") && apps.has(v.slice(4)));
const appRefHint = (apps: Set<string>) => [...BUILTIN_APPS, ...[...apps].map((a) => `app:${a}`)].join(", ");

/**
 * ui.json `shell`. Errors are reported like everything else; a shell with errors compiles to the
 * defaults, so a broken shell can never hide the way back (the settings menu is never hideable).
 */
function compileShell(raw: unknown, e: Errs, apps: Set<string>, mods: Set<string>): ShellPrefs {
  if (raw == null) return DEFAULT_SHELL;
  const before = e.list.length;
  const out: ShellPrefs = structuredClone(DEFAULT_SHELL);
  if (!isObj(raw)) {
    e.add("/shell", "must be an object", '{ "rail"?, "home"?, "density"?, "topbar"?, "slots"? }');
    return DEFAULT_SHELL;
  }
  onlyKeys(raw, ["rail", "home", "density", "topbar", "slots"], "/shell", e);
  if (raw.rail != null) {
    if (!isObj(raw.rail)) e.add("/shell/rail", "must be an object", '{ "order"?: [...], "hidden"?: [...], "labels"?: true }');
    else {
      onlyKeys(raw.rail, ["order", "hidden", "labels"], "/shell/rail", e);
      for (const k of ["order", "hidden"] as const) {
        const list = raw.rail[k];
        if (list == null) continue;
        if (!Array.isArray(list) || list.length > 40) {
          e.add(`/shell/rail/${k}`, "must be an array of app ids (max 40)", appRefHint(apps));
          continue;
        }
        list.forEach((v, i) => {
          if (typeof v !== "string" || !appRef(v, apps)) e.add(`/shell/rail/${k}/${i}`, `unknown app ${show(v)}`, appRefHint(apps));
          else if (out.rail[k].includes(v)) e.add(`/shell/rail/${k}/${i}`, `"${v}" is listed twice`);
          else out.rail[k].push(v);
        });
      }
      if (raw.rail.labels != null) {
        if (typeof raw.rail.labels !== "boolean") e.add("/shell/rail/labels", "must be true or false");
        else out.rail.labels = raw.rail.labels;
      }
    }
  }
  if (raw.home != null) {
    if (typeof raw.home !== "string" || !appRef(raw.home, apps)) e.add("/shell/home", `unknown app ${show(raw.home)}`, appRefHint(apps));
    else out.home = raw.home;
  }
  out.density = oneOf(raw, "density", "/shell", e, ["compact", "comfortable"] as const) ?? null;
  if (raw.topbar != null) {
    if (!isObj(raw.topbar)) e.add("/shell/topbar", "must be an object", '{ "search": false }');
    else {
      for (const k of Object.keys(raw.topbar)) {
        if ((LOCKED_TOPBAR_ITEMS as readonly string[]).includes(k)) {
          e.add(`/shell/topbar/${esc(k)}`, `the ${k} menu can't be hidden or changed (it always offers ${k === "settings" ? '"Restore default UI"' : "sign-out"})`, `remove "${k}"`);
          continue;
        }
        if (!(TOPBAR_ITEMS as readonly string[]).includes(k)) {
          e.add(`/shell/topbar/${esc(k)}`, `unknown top bar item "${k}"`, TOPBAR_ITEMS.join(", "));
          continue;
        }
        if (typeof raw.topbar[k] !== "boolean") e.add(`/shell/topbar/${k}`, "must be true (shown) or false (hidden)");
        else out.topbar[k as TopbarItem] = raw.topbar[k] as boolean;
      }
    }
  }
  if (raw.slots != null) {
    if (!isObj(raw.slots)) e.add("/shell/slots", "must be an object of slot → mod", '{ "mail.side": { "mod": "pomodoro" } }');
    else {
      for (const [name, v] of Object.entries(raw.slots)) {
        const ptr = `/shell/slots/${esc(name)}`;
        if (!(SLOT_NAMES as readonly string[]).includes(name)) {
          e.add(ptr, `unknown slot "${name}"`, SLOT_NAMES.join(", "));
          continue;
        }
        if (v === null) continue;
        if (!isObj(v)) {
          e.add(ptr, "must be an object", '{ "mod": "<id>", "title"?, "config"?, "width"?, "open"? }');
          continue;
        }
        onlyKeys(v, ["mod", "title", "config", "width", "open"], ptr, e);
        const mod = str(v, "mod", ptr, e, { max: 40, required: true, re: MOD_ID, reHint: "a mod id: a folder name under mods/" });
        if (mod && !mods.has(mod)) e.add(`${ptr}/mod`, `no mod "${mod}"`, mods.size ? [...mods].join(", ") : "add the mod folder first");
        const title = str(v, "title", ptr, e, { max: 40 });
        const top = name === "topbar";
        const width = num(v, "width", ptr, e, top ? 120 : 240, top ? 360 : 480) ?? (top ? 200 : 320);
        let config: Raw = {};
        if (v.config != null) {
          if (!isObj(v.config)) e.add(`${ptr}/config`, "must be an object");
          else if (utf8Bytes(JSON.stringify(v.config)) > CONFIG_MAX_BYTES) e.add(`${ptr}/config`, `is larger than ${CONFIG_MAX_BYTES / 1024} KB`);
          else config = v.config;
        }
        if (v.open != null && typeof v.open !== "boolean") e.add(`${ptr}/open`, "must be true or false");
        if (mod) out.slots[name as SlotName] = { mod, ...(title ? { title } : {}), config, width, open: v.open !== false };
      }
    }
  }
  return e.list.length > before ? DEFAULT_SHELL : out;
}

/* -------------------------------------------------------------------- check */

/**
 * Validates and compiles the files of `Zentico UI/` (path → text). Errors point at the exact file
 * and JSON pointer. A result with errors still carries whatever compiled (`ui` is null when ui.json
 * itself is unusable), but only an error-free result should replace the UI the user sees.
 */
export function checkUi(texts: Record<string, string>): CheckResult {
  const errs: Errs[] = [];
  const modResult = compileMods(texts, errs);

  const ue = new Errs(UI_FILE);
  errs.push(ue);
  const uiRaw = texts[UI_FILE] === undefined ? (ue.add("", "is missing", "ui.json with at least one page"), undefined) : parseJson(texts[UI_FILE], UI_FILE, ue, UI_FILE_MAX_BYTES);
  const modSizes = new Map([...modResult.manifests].map(([id, m]) => [id, { w: m.size.w, h: m.size.h }]));
  const pages = uiRaw === undefined ? [] : compilePages(uiRaw, { e: ue, mods: modResult.ids, modSizes });

  const te = new Errs(THEME_FILE);
  errs.push(te);
  const theme = compileTheme(parseJson(texts[THEME_FILE], THEME_FILE, te, SMALL_FILE_MAX_BYTES), te);

  const ke = new Errs(KEYS_FILE);
  errs.push(ke);
  const keys = compileKeys(parseJson(texts[KEYS_FILE], KEYS_FILE, ke, SMALL_FILE_MAX_BYTES), ke, new Set(pages.map((p) => p.id)), modResult.manifests);

  const appIds = new Set(pages.flatMap((p) => (p.app ? [p.app.id] : [])));
  const shell = isObj(uiRaw) ? compileShell(uiRaw.shell, ue, appIds, modResult.ids) : DEFAULT_SHELL;

  const errors = errs.flatMap((e) => e.list).slice(0, 100);
  const ui = pages.length ? { pages, theme, keys, mods: modResult.mods, shell } : null;
  return { ok: errors.length === 0 && !!ui, errors, ui };
}

/** One line per error, for prompts and tool results. */
export const formatErrors = (errors: UiError[]) =>
  errors.map((e) => `${e.file} ${e.pointer}: ${e.message}${e.expected ? ` (expected: ${e.expected})` : ""}`).join("\n");

/* ------------------------------------------------------------ JSON pointer */

export type PointerOp = { op: "set"; pointer: string; value: unknown } | { op: "remove"; pointer: string } | { op: "insert"; pointer: string; value: unknown };

const unesc = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");

/** Applies pointer edits to a parsed JSON document (deep-cloned first). Throws Error on a bad path. */
export function applyPointerOps(doc: unknown, ops: PointerOp[]): unknown {
  const root = structuredClone(doc) as unknown;
  for (const op of ops) {
    if (typeof op.pointer !== "string" || !op.pointer.startsWith("/")) throw new Error(`Invalid pointer "${String(op.pointer)}"`);
    const parts = op.pointer.slice(1).split("/").map(unesc);
    const last = parts.pop()!;
    let cur: unknown = root;
    for (const p of parts) {
      if (Array.isArray(cur)) cur = cur[Number(p)];
      else if (isObj(cur)) cur = cur[p];
      else cur = undefined;
      if (cur === undefined) throw new Error(`Path not found: ${op.pointer}`);
    }
    if (Array.isArray(cur)) {
      const i = last === "-" ? cur.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > cur.length) throw new Error(`Bad index in ${op.pointer}`);
      if (op.op === "remove") cur.splice(i, 1);
      else if (op.op === "insert") cur.splice(i, 0, op.value);
      else cur[i] = op.value;
    } else if (isObj(cur)) {
      if (["__proto__", "constructor", "prototype"].includes(last)) throw new Error("Forbidden key");
      if (op.op === "remove") delete cur[last];
      else cur[last] = op.value;
    } else throw new Error(`Path not found: ${op.pointer}`);
  }
  return root;
}

export function getAtPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return doc;
  let cur: unknown = doc;
  for (const p of pointer.slice(1).split("/").map(unesc)) {
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (isObj(cur)) cur = cur[p];
    else return undefined;
  }
  return cur;
}

/* -------------------------------------------------------------- grid boxes */

export type Box = { id: string; x: number; y: number; w: number; h: number; minW: number; minH: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function clampBox<T extends Box>(b: T, maxH = 40): T {
  const w = Math.min(GRID_COLUMNS, Math.max(b.minW, Math.round(b.w)));
  const h = Math.min(maxH, Math.max(b.minH, Math.round(b.h)));
  return { ...b, w, h, x: Math.min(GRID_COLUMNS - w, Math.max(0, Math.round(b.x))), y: Math.min(GRID_MAX_ROWS - h, Math.max(0, Math.round(b.y))) };
}

/** Pinned boxes keep their spot, colliding ones are pushed down, then everything floats up. */
export function normalizeBoxes<T extends Box>(boxes: T[], pinned: Iterable<string> = []): T[] {
  const pin = new Set(pinned);
  const order = boxes
    .map((b, i) => ({ b: clampBox(b), i }))
    .sort((a, b) => Number(pin.has(b.b.id)) - Number(pin.has(a.b.id)) || a.b.y - b.b.y || a.b.x - b.b.x || a.i - b.i)
    .map((x) => x.b);
  const placed: T[] = [];
  for (const b of order) {
    let cur = b;
    for (let guard = 0; guard < GRID_MAX_ROWS && placed.some((p) => overlaps(p, cur)); guard++) {
      cur = { ...cur, y: Math.min(GRID_MAX_ROWS - cur.h, Math.max(...placed.filter((p) => overlaps(p, cur)).map((p) => p.y + p.h))) };
      if (cur.y === GRID_MAX_ROWS - cur.h) break;
    }
    placed.push(cur);
  }
  const settled: T[] = [];
  for (const b of [...placed].sort((a, c) => a.y - c.y || a.x - c.x)) {
    let cur = b;
    while (cur.y > 0 && !settled.some((p) => overlaps(p, { ...cur, y: cur.y - 1 }))) cur = { ...cur, y: cur.y - 1 };
    settled.push(cur);
  }
  const byId = new Map(settled.map((b) => [b.id, b]));
  return boxes.map((b) => byId.get(b.id)!);
}

/** First free spot (top-left first) in a grid for a box of w × h. */
export function findSpot(boxes: { x: number; y: number; w: number; h: number }[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < GRID_MAX_ROWS; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const probe = { id: "", x, y, w, h, minW: 1, minH: 1 };
      if (!boxes.some((o) => overlaps({ id: "", minW: 1, minH: 1, ...o }, probe))) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, ...boxes.map((o) => o.y + o.h)) };
}

/** Grid min size of a node (component spec, or a mod / container default). */
export function minSizeOf(n: UiNode): { minW: number; minH: number } {
  if (n.type === "component") return { minW: COMPONENTS[n.component]?.size.minW ?? 2, minH: COMPONENTS[n.component]?.size.minH ?? 2 };
  return { minW: 2, minH: 2 };
}

/* ------------------------------------------------------------- traversal */

export function walk(n: UiNode, fn: (n: UiNode, parent: UiContainer | null) => void, parent: UiContainer | null = null) {
  fn(n, parent);
  if (isContainer(n)) for (const c of n.children) walk(c, fn, n);
}

/** Mods used anywhere in the UI. */
export function modsInUse(ui: CompiledUi): Set<string> {
  const out = new Set<string>();
  for (const p of ui.pages) walk(p.layout, (n) => n.type === "mod" && out.add(n.mod));
  return out;
}

/** Compact description for prompts and dashboard_get. */
export function summarizeUi(ui: CompiledUi | null) {
  if (!ui) return null;
  const node = (n: UiNode): unknown => {
    const box = n.x != null ? { x: n.x, y: n.y, w: n.w, h: n.h } : {};
    if (n.type === "component") return { component: n.component, id: n.id, title: n.title, ...box };
    if (n.type === "mod") return { mod: n.mod, id: n.id, title: n.title, ...box };
    return { type: n.type, id: n.id, title: n.title, ...box, children: n.children.map(node) };
  };
  return {
    pages: ui.pages.map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      pinned: p.pinned || undefined,
      app: p.app ? { path: `/x/${p.app.id}`, name: p.app.name, hidden: p.app.hidden || undefined, sections: p.app.sections.map((s) => s.id) } : undefined,
      layout: node(p.layout),
    })),
    mods: Object.values(ui.mods).map((m) => ({ id: m.id, name: m.name, version: m.version, permissions: m.permissions, commands: m.commands.map((c) => c.id) })),
    keys: ui.keys.length,
    theme: { scope: ui.theme.scope },
    shell: ui.shell,
  };
}

/* -------------------------------------------------------------------- view */

/** perms: approved permissions and MCP scope keys ("mcp:<server>/<tool>"). */
export type ModGrant = { perms: string[]; always: string[] };

/** What the Dashboard receives: the last valid UI plus the current problems and the user's grants. */
export type UiView = {
  ui: CompiledUi | null;
  errors: UiError[];
  /** Signature of the files the server last looked at (valid or not). */
  sig: string;
  folderId: string | null;
  grants: Record<string, ModGrant>;
  undo: number;
  updated: number;
};

/** Pages pinned to the app rail and the key bindings: what every app needs (cheap, from sqlite). */
export type UiShellApp = { id: string; pageId: string; name: string; icon: IconName; color?: string; hidden: boolean; order: number };
export type UiShell = {
  pages: { id: string; title: string; icon: IconName; pinned: boolean }[];
  apps: UiShellApp[];
  keys: KeyBinding[];
  /** Shell customization (defaults in safe mode). */
  prefs: ShellPrefs;
  /** The theme when it is workspace-scoped (null otherwise or in safe mode). */
  theme: UiTheme | null;
  /** Problems in theme.json or ui.json's shell (the last valid version or the defaults are shown). */
  issues: number;
  /** Safe mode: customizations are ignored in this browser. */
  safe: boolean;
};

/** Rail apps in rail order (by `order`, then file order); hidden ones included (flagged). */
export function shellApps(ui: CompiledUi | null): UiShellApp[] {
  return (ui?.pages ?? [])
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.app)
    .sort((a, b) => a.p.app!.order - b.p.app!.order || a.i - b.i)
    .map(({ p }) => ({ id: p.app!.id, pageId: p.id, name: p.app!.name, icon: p.app!.icon, ...(p.app!.color ? { color: p.app!.color } : {}), hidden: p.app!.hidden, order: p.app!.order }));
}

/** Global density: the shell's, else compact when a workspace theme asks for it. */
export const shellDensity = (s: Pick<UiShell, "prefs" | "theme">): "compact" | "comfortable" =>
  s.prefs.density ?? (s.theme?.density === "compact" ? "compact" : "comfortable");

/** Errors that touch the workspace shell (theme.json, ui.json /shell): shown as a notice in every app. */
export const shellIssues = (errors: UiError[]) => errors.filter((e) => e.file === THEME_FILE || (e.file === UI_FILE && e.pointer.startsWith("/shell"))).length;

/** What every app needs from a compiled UI. In safe mode the shell and theme are the defaults. */
export function shellFromUi(ui: CompiledUi | null, errors: UiError[], safe: boolean): UiShell {
  const theme = ui?.theme && ui.theme.scope === "workspace" ? ui.theme : null;
  return {
    pages: (ui?.pages ?? []).map((p) => ({ id: p.id, title: p.title, icon: p.icon, pinned: p.pinned })),
    apps: shellApps(ui),
    keys: ui?.keys ?? [],
    prefs: safe ? DEFAULT_SHELL : (ui?.shell ?? DEFAULT_SHELL),
    theme: safe ? null : theme,
    issues: shellIssues(errors),
    safe,
  };
}

/** Permissions a mod effectively has: declared in its manifest AND granted by the user. */
export const effectivePerms = (mod: Pick<ModManifest, "permissions"> | undefined, grant: ModGrant | undefined): Permission[] =>
  mod ? mod.permissions.filter((p) => grant?.perms.includes(p)) : [];

/** MCP scopes a mod may use: declared AND approved. */
export const effectiveMcp = (mod: Pick<ModManifest, "mcp"> | undefined, grant: ModGrant | undefined): McpScope[] =>
  (mod?.mcp ?? []).map((s) => ({ server: s.server, tools: s.tools.filter((t) => grant?.perms.includes(`mcp:${s.server}/${t}`)) })).filter((s) => s.tools.length);

/** Everything a mod asks the user to approve: permissions plus MCP scope keys. */
export const requestedGrants = (mod: Pick<ModManifest, "permissions" | "mcp">): string[] => [...mod.permissions, ...mcpScopeKeys(mod.mcp ?? [])];

/** Requested grants the user hasn't approved yet (the mod waits for approval while non-empty). */
export const missingPerms = (mod: Pick<ModManifest, "permissions" | "mcp">, grant: ModGrant | undefined): string[] =>
  requestedGrants(mod).filter((p) => !grant?.perms.includes(p));
