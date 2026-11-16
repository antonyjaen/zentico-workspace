// Client-safe model of the per-user dashboard: document shape, widget catalog with strict config
// validation, layout rules (12-column grid, collisions pushed down, gravity up) and the edit
// operations shared by the UI (/api/dashboard), the MCP tools (src/lib/mcp/dashboard-tools.ts)
// and the store (src/lib/dashboard/store.ts). Inputs may come from an LLM: validate everything.

export const GRID_COLS = 12;
/** Bottom edge limit (in rows) for any widget. */
export const MAX_ROWS = 400;
export const MAX_H = 30;
export const MAX_WIDGETS = 40;
export const TITLE_MAX = 80;
export const NOTES_MAX = 20_000;
export const CUSTOM_HTML_MAX_BYTES = 100 * 1024;
/** Serialized document limit (custom HTML included). */
export const DOC_MAX_BYTES = 1536 * 1024;
export const VERSIONS_KEPT = 20;
export const CHAT_TEXT_MAX = 2000;

export const WIDGET_ID = /^w_[a-z0-9]{6,16}$/;

export type WidgetType = "agenda" | "mail" | "chat" | "drive" | "meetings" | "notes" | "links" | "clock" | "chart" | "custom";
export const WIDGET_TYPES: readonly WidgetType[] = ["agenda", "mail", "chat", "drive", "meetings", "notes", "links", "clock", "chart", "custom"];

export type Config = Record<string, unknown>;
export type Widget = { id: string; type: WidgetType; title: string; x: number; y: number; w: number; h: number; config: Config };
export type Density = "comfortable" | "compact";
export type Background = "plain" | "muted" | "grid";
export type Theme = { accent?: string; density?: Density; background?: Background };
export type DashboardDoc = { version: number; theme: Theme; widgets: Widget[] };

/** A user-facing validation problem (shown to Claude / the UI as is). */
export class DashError extends Error {}

/* --------------------------------------------------------------- validation */

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Raw {
  if (v == null) return {};
  if (!isObj(v)) throw new DashError(`${what} must be an object`);
  return v;
}

function onlyKeys(o: Raw, keys: readonly string[], what: string) {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw new DashError(`${what}: unknown field "${k}" (allowed: ${keys.join(", ") || "none"})`);
  }
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function text(o: Raw, key: string, max: number, def = "", multiline = false): string {
  const v = o[key];
  if (v == null) return def;
  if (typeof v !== "string") throw new DashError(`"${key}" must be a string`);
  const clean = multiline ? v.replace(CONTROL, "") : v.replace(CONTROL, " ").replace(/[\r\n]+/g, " ");
  if (clean.length > max) throw new DashError(`"${key}" is too long (max ${max} characters)`);
  return clean;
}

function int(o: Raw, key: string, min: number, max: number, def: number): number {
  const v = o[key];
  if (v == null) return def;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new DashError(`"${key}" must be an integer`);
  if (v < min || v > max) throw new DashError(`"${key}" must be between ${min} and ${max}`);
  return v;
}

function bool(o: Raw, key: string, def: boolean): boolean {
  const v = o[key];
  if (v == null) return def;
  if (typeof v !== "boolean") throw new DashError(`"${key}" must be true or false`);
  return v;
}

function oneOf<T extends string>(o: Raw, key: string, values: readonly T[], def: T): T {
  const v = o[key];
  if (v == null) return def;
  if (typeof v !== "string" || !values.includes(v as T)) throw new DashError(`"${key}" must be one of: ${values.join(", ")}`);
  return v as T;
}

function list(o: Raw, key: string, max: number): unknown[] {
  const v = o[key];
  if (v == null) return [];
  if (!Array.isArray(v)) throw new DashError(`"${key}" must be an array`);
  if (v.length > max) throw new DashError(`"${key}" has too many items (max ${max})`);
  return v;
}

const ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
function optId(o: Raw, key: string): string {
  const v = text(o, key, 255);
  if (v && !ID_RE.test(v)) throw new DashError(`"${key}" is not a valid id`);
  return v;
}

export function isTimeZoneName(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Links: http(s), mailto, or a path inside the workspace ("/mail", "/drive?folder=…"). */
export function safeLink(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 500 || /[\u0000-\u001f\s\\]/.test(s)) return null;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/* ------------------------------------------------------------------ catalog */

export type JsonSchema = Record<string, unknown>;

type Spec = {
  description: string;
  minW: number;
  minH: number;
  defW: number;
  defH: number;
  /** JSON schema of the config, for Claude (dashboard_list_widget_types). */
  schema: JsonSchema;
  /** Strictly validates a config; returns the cleaned config with defaults filled in. */
  validate(raw: Raw): Config;
};

const S = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const I = (description: string, minimum: number, maximum: number, def: number): JsonSchema => ({ type: "integer", description, minimum, maximum, default: def });
const B = (description: string, def: boolean): JsonSchema => ({ type: "boolean", description, default: def });
const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

export const CHART_KINDS = ["bar", "line", "number"] as const;

export const WIDGETS: Record<WidgetType, Spec> = {
  agenda: {
    description: "Calendar agenda: events from today through the next N days (own and shared calendars).",
    minW: 3,
    minH: 4,
    defW: 4,
    defH: 8,
    schema: schema({ days: I("Days to show, starting today.", 1, 14, 3), limit: I("Max events.", 1, 50, 12) }),
    validate(raw) {
      onlyKeys(raw, ["days", "limit"], "agenda config");
      return { days: int(raw, "days", 1, 14, 3), limit: int(raw, "limit", 1, 50, 12) };
    },
  },
  mail: {
    description: "Mail: unread conversations in the inbox, or the results of a search query.",
    minW: 3,
    minH: 4,
    defW: 4,
    defH: 8,
    schema: schema({
      mode: S("unread = unread inbox; search = conversations matching `query`.", { enum: ["unread", "search"], default: "unread" }),
      query: S("Full-text search (mode=search), e.g. a sender, a subject word.", { maxLength: 200 }),
      folder: S("Folder name or role (inbox, sent, archive…). Default: inbox for unread, all folders for search.", { maxLength: 100 }),
      unreadOnly: B("With mode=search: only unread messages.", false),
      limit: I("Max conversations.", 1, 50, 8),
    }),
    validate(raw) {
      onlyKeys(raw, ["mode", "query", "folder", "unreadOnly", "limit"], "mail config");
      const mode = oneOf(raw, "mode", ["unread", "search"] as const, "unread");
      const query = text(raw, "query", 200).trim();
      if (mode === "search" && !query) throw new DashError('mail config: "query" is required when mode is "search"');
      return { mode, query, folder: text(raw, "folder", 100).trim(), unreadOnly: bool(raw, "unreadOnly", false), limit: int(raw, "limit", 1, 50, 8) };
    },
  },
  chat: {
    description: "Chat: conversations with unread messages, or the latest messages of one conversation.",
    minW: 3,
    minH: 4,
    defW: 4,
    defH: 8,
    schema: schema({
      mode: S("unread = conversations with unread messages; conversation = latest messages of `conversationId`.", {
        enum: ["unread", "conversation"],
        default: "unread",
      }),
      conversationId: S("Conversation id (from chat_list_conversations), for mode=conversation."),
      limit: I("Max conversations or messages.", 1, 50, 8),
    }),
    validate(raw) {
      onlyKeys(raw, ["mode", "conversationId", "limit"], "chat config");
      const mode = oneOf(raw, "mode", ["unread", "conversation"] as const, "unread");
      const conversationId = optId(raw, "conversationId");
      if (mode === "conversation" && !conversationId) throw new DashError('chat config: "conversationId" is required when mode is "conversation"');
      return { mode, conversationId, limit: int(raw, "limit", 1, 50, 8) };
    },
  },
  drive: {
    description: "Drive: recently modified files, or the contents of a folder.",
    minW: 3,
    minH: 4,
    defW: 4,
    defH: 6,
    schema: schema({
      mode: S("recent = recently modified files; folder = contents of `folderId`.", { enum: ["recent", "folder"], default: "recent" }),
      folderId: S("Folder id (from drive_list / drive_search), for mode=folder."),
      limit: I("Max entries.", 1, 50, 10),
    }),
    validate(raw) {
      onlyKeys(raw, ["mode", "folderId", "limit"], "drive config");
      const mode = oneOf(raw, "mode", ["recent", "folder"] as const, "recent");
      const folderId = optId(raw, "folderId");
      if (mode === "folder" && !folderId) throw new DashError('drive config: "folderId" is required when mode is "folder"');
      return { mode, folderId, limit: int(raw, "limit", 1, 50, 10) };
    },
  },
  meetings: {
    description: "Meetings: upcoming calendar events with other people, and recent meeting recordings/transcripts.",
    minW: 3,
    minH: 4,
    defW: 4,
    defH: 8,
    schema: schema({
      upcoming: B("Show upcoming meetings.", true),
      recordings: B("Show recent recordings.", true),
      days: I("Days ahead for upcoming meetings.", 1, 14, 7),
      limit: I("Max items per section.", 1, 20, 5),
    }),
    validate(raw) {
      onlyKeys(raw, ["upcoming", "recordings", "days", "limit"], "meetings config");
      const upcoming = bool(raw, "upcoming", true);
      const recordings = bool(raw, "recordings", true);
      if (!upcoming && !recordings) throw new DashError("meetings config: enable upcoming and/or recordings");
      return { upcoming, recordings, days: int(raw, "days", 1, 14, 7), limit: int(raw, "limit", 1, 20, 5) };
    },
  },
  notes: {
    description: "Notes: Markdown text stored in the widget (headings, lists, links, bold, code).",
    minW: 2,
    minH: 2,
    defW: 4,
    defH: 6,
    schema: schema({ text: S("Markdown text.", { maxLength: NOTES_MAX }) }),
    validate(raw) {
      onlyKeys(raw, ["text"], "notes config");
      return { text: text(raw, "text", NOTES_MAX, "", true) };
    },
  },
  links: {
    description: "Links / bookmarks: a list of labelled links (https://…, mailto:, or workspace paths like /drive).",
    minW: 2,
    minH: 2,
    defW: 3,
    defH: 5,
    schema: schema({
      items: {
        type: "array",
        maxItems: 50,
        items: schema({ label: S("Shown text.", { maxLength: 80 }), url: S("https://…, mailto:… or a workspace path starting with /.", { maxLength: 500 }) }, ["url"]),
      },
    }),
    validate(raw) {
      onlyKeys(raw, ["items"], "links config");
      const items = list(raw, "items", 50).map((v, i) => {
        if (!isObj(v)) throw new DashError(`links config: items[${i}] must be an object`);
        onlyKeys(v, ["label", "url"], `links config items[${i}]`);
        const url = safeLink(text(v, "url", 500));
        if (!url) throw new DashError(`links config: items[${i}].url must be https://, http://, mailto: or a path starting with /`);
        return { label: text(v, "label", 80).trim(), url };
      });
      return { items };
    },
  },
  clock: {
    description: "Clock / world clocks: current time in one or more IANA time zones.",
    minW: 2,
    minH: 2,
    defW: 3,
    defH: 3,
    schema: schema({
      zones: {
        type: "array",
        maxItems: 8,
        description: "Time zones to show. Empty = the viewer's local time.",
        items: schema({ timeZone: S('IANA name, e.g. "Europe/Madrid".'), label: S("Optional label, e.g. a city.", { maxLength: 40 }) }, ["timeZone"]),
      },
      hour12: B("12-hour clock.", false),
      seconds: B("Show seconds.", false),
    }),
    validate(raw) {
      onlyKeys(raw, ["zones", "hour12", "seconds"], "clock config");
      const zones = list(raw, "zones", 8).map((v, i) => {
        if (!isObj(v)) throw new DashError(`clock config: zones[${i}] must be an object`);
        onlyKeys(v, ["timeZone", "label"], `clock config zones[${i}]`);
        const timeZone = text(v, "timeZone", 64).trim();
        if (!isTimeZoneName(timeZone)) throw new DashError(`clock config: unknown time zone "${timeZone}"`);
        return { timeZone, label: text(v, "label", 40).trim() };
      });
      return { zones, hour12: bool(raw, "hour12", false), seconds: bool(raw, "seconds", false) };
    },
  },
  chart: {
    description:
      "Metric / chart from data given in the config (no live data): kind=bar or line with series of numbers, or kind=number for one big value with an optional change.",
    minW: 2,
    minH: 3,
    defW: 4,
    defH: 6,
    schema: schema({
      kind: S("bar, line or number.", { enum: [...CHART_KINDS], default: "bar" }),
      labels: { type: "array", maxItems: 100, items: S("Category / x label.", { maxLength: 40 }) },
      series: {
        type: "array",
        maxItems: 5,
        items: schema({ name: S("Series name.", { maxLength: 40 }), values: { type: "array", maxItems: 100, items: { type: "number" } } }, ["values"]),
      },
      value: { type: "number", description: "kind=number: the value." },
      delta: { type: "number", description: "kind=number: change vs. previous (shown as +/-)." },
      unit: S("Unit suffix, e.g. € or %.", { maxLength: 12 }),
      caption: S("Short caption under the chart.", { maxLength: 120 }),
    }),
    validate(raw) {
      onlyKeys(raw, ["kind", "labels", "series", "value", "delta", "unit", "caption"], "chart config");
      const kind = oneOf(raw, "kind", CHART_KINDS, "bar");
      const num = (v: unknown, what: string) => {
        if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e15) throw new DashError(`chart config: ${what} must be a finite number`);
        return v;
      };
      const labels = list(raw, "labels", 100).map((v, i) => {
        if (typeof v !== "string" || v.length > 40) throw new DashError(`chart config: labels[${i}] must be a string (max 40)`);
        return v.replace(CONTROL, " ");
      });
      const series = list(raw, "series", 5).map((v, i) => {
        if (!isObj(v)) throw new DashError(`chart config: series[${i}] must be an object`);
        onlyKeys(v, ["name", "values"], `chart config series[${i}]`);
        const values = list(v, "values", 100).map((n, j) => num(n, `series[${i}].values[${j}]`));
        return { name: text(v, "name", 40).trim(), values };
      });
      const out: Config = { kind, labels, series, unit: text(raw, "unit", 12).trim(), caption: text(raw, "caption", 120).trim() };
      if (kind === "number") {
        if (raw.value == null) throw new DashError('chart config: "value" is required when kind is "number"');
        out.value = num(raw.value, '"value"');
        if (raw.delta != null) out.delta = num(raw.delta, '"delta"');
      } else if (!series.length || !series.some((s) => s.values.length)) {
        throw new DashError('chart config: "series" needs at least one series with values');
      }
      return out;
    },
  },
  custom: {
    description:
      "Custom HTML/CSS/JS widget rendered in a sandboxed iframe (no network, no cookies; CSP default-src 'none', inline script/style only, images only as data: URIs). " +
      "Read workspace data with `await zentico.query(name, args)` (see dataQueries). The theme colors are CSS variables: --zw-ink, --zw-ink-soft, --zw-ink-mute, --zw-line, --zw-sheet, --zw-sheet-muted, --zw-accent. Max 100 KB.",
    minW: 2,
    minH: 2,
    defW: 4,
    defH: 6,
    schema: schema({ html: S("A complete HTML fragment or document (inline <style> and <script> allowed).", { maxLength: CUSTOM_HTML_MAX_BYTES }) }, ["html"]),
    validate(raw) {
      onlyKeys(raw, ["html"], "custom config");
      const html = raw.html;
      if (typeof html !== "string") throw new DashError('custom config: "html" must be a string');
      if (utf8Bytes(html) > CUSTOM_HTML_MAX_BYTES) throw new DashError(`custom config: "html" is larger than ${CUSTOM_HTML_MAX_BYTES / 1024} KB`);
      return { html };
    },
  },
};

export const isWidgetType = (v: unknown): v is WidgetType => typeof v === "string" && (WIDGET_TYPES as readonly string[]).includes(v);

export function validateConfig(type: WidgetType, raw: unknown): Config {
  return WIDGETS[type].validate(obj(raw, `${type} config`));
}

/* ----------------------------------------------------------- data queries */

/**
 * Read-only data queries a widget (built-in or custom) may run, answered by /api/dashboard/query
 * with the viewer's own session. Custom widgets reach them only through the parent's postMessage
 * bridge; nothing else (no tokens, no cookies) is exposed to the iframe.
 */
export const DATA_QUERIES = {
  "calendar.events": { args: "{ days?: 1-14 (default 3), limit?: 1-50 }", description: "Events from today through the next `days` days." },
  "mail.search": {
    args: "{ query?: string, folder?: string, unreadOnly?: boolean, limit?: 1-50 }",
    description: "Mail conversations (newest first). No query and no folder = unread inbox.",
  },
  "chat.conversations": { args: "{ unreadOnly?: boolean, limit?: 1-50 }", description: "Chat conversations with unread counts and last message." },
  "chat.messages": { args: "{ conversationId: string, limit?: 1-50 }", description: "Latest messages of one conversation." },
  "tasks.mine": { args: "{ includeDone?: boolean, limit?: 1-50 }", description: "Chat tasks assigned to the user, soonest due first." },
  "drive.recent": { args: "{ limit?: 1-50 }", description: "Recently modified Drive files." },
  "drive.folder": { args: "{ folderId: string, limit?: 1-50 }", description: "Contents of a Drive folder." },
  "meetings.upcoming": { args: "{ days?: 1-14, limit?: 1-20 }", description: "Upcoming calendar events with other people." },
  "meetings.recordings": { args: "{ limit?: 1-20 }", description: "Recent meeting recordings / transcripts." },
  "calendar.range": { args: '{ start: "YYYY-MM-DD", end: "YYYY-MM-DD", limit?: 1-200 }', description: "Events in a date range (end exclusive, max 31 days)." },
  "mail.thread": { args: "{ threadId: string }", description: "One mail conversation with its messages." },
  "drive.search": { args: "{ query: string, limit?: 1-50 }", description: "Drive files whose name contains the text." },
  "drive.read": { args: "{ fileId: string }", description: "Text of a Drive text file (max 200 KB)." },
  "drive.resolve": { args: '{ path: string, kind?: "folder" | "file" }', description: "Id of a Drive file or folder by its path from the root." },
  "contacts.search": { args: "{ query: string, limit?: 1-50 }", description: "Contacts and directory people matching the text." },
  "dashboard.state": { args: "{}", description: "Pages of the user's Dashboard." },
} as const;
export type DataQuery = keyof typeof DATA_QUERIES;
export const isDataQuery = (v: unknown): v is DataQuery => typeof v === "string" && Object.prototype.hasOwnProperty.call(DATA_QUERIES, v);

/** The data query (and its args) a built-in widget runs; null for widgets without live data. */
export function widgetQuery(w: Pick<Widget, "type" | "config">): { name: DataQuery; args: Raw } | null {
  const c = w.config;
  switch (w.type) {
    case "agenda":
      return { name: "calendar.events", args: { days: c.days, limit: c.limit } };
    case "mail":
      return c.mode === "search"
        ? { name: "mail.search", args: { query: c.query, folder: c.folder || undefined, unreadOnly: c.unreadOnly, limit: c.limit } }
        : { name: "mail.search", args: { folder: c.folder || undefined, unreadOnly: true, limit: c.limit } };
    case "chat":
      return c.mode === "conversation"
        ? { name: "chat.messages", args: { conversationId: c.conversationId, limit: c.limit } }
        : { name: "chat.conversations", args: { unreadOnly: true, limit: c.limit } };
    case "drive":
      return c.mode === "folder" ? { name: "drive.folder", args: { folderId: c.folderId, limit: c.limit } } : { name: "drive.recent", args: { limit: c.limit } };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------- layout */

const overlaps = (a: Widget, b: Widget) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function clampBox<T extends { type: WidgetType; x: number; y: number; w: number; h: number }>(wd: T): T {
  const spec = WIDGETS[wd.type];
  const w = Math.min(GRID_COLS, Math.max(spec.minW, Math.round(wd.w)));
  const h = Math.min(MAX_H, Math.max(spec.minH, Math.round(wd.h)));
  const x = Math.min(GRID_COLS - w, Math.max(0, Math.round(wd.x)));
  const y = Math.min(MAX_ROWS - h, Math.max(0, Math.round(wd.y)));
  return { ...wd, x, y, w, h };
}

/**
 * Resolves a layout: `pinned` widgets keep their spot, every other widget that collides is pushed
 * down, then everything floats up as far as it can (gravity), so there are never gaps or overlaps.
 */
export function normalizeLayout(widgets: Widget[], pinned: Iterable<string> = []): Widget[] {
  const pin = new Set(pinned);
  const order = widgets
    .map((w, i) => ({ w: clampBox(w), i }))
    .sort((a, b) => Number(pin.has(b.w.id)) - Number(pin.has(a.w.id)) || a.w.y - b.w.y || a.w.x - b.w.x || a.i - b.i)
    .map((e) => e.w);
  const placed: Widget[] = [];
  for (const w of order) {
    let cur = w;
    for (let guard = 0; guard < MAX_ROWS && placed.some((p) => overlaps(p, cur)); guard++) {
      const bottom = Math.max(...placed.filter((p) => overlaps(p, cur)).map((p) => p.y + p.h));
      cur = { ...cur, y: Math.min(MAX_ROWS - cur.h, bottom) };
      if (cur.y === MAX_ROWS - cur.h) break;
    }
    placed.push(cur);
  }
  // Gravity: top to bottom, each widget moves up while the space above is free.
  const sorted = [...placed].sort((a, b) => a.y - b.y || a.x - b.x);
  const settled: Widget[] = [];
  for (const w of sorted) {
    let cur = w;
    while (cur.y > 0) {
      const up = { ...cur, y: cur.y - 1 };
      if (settled.some((p) => overlaps(p, up))) break;
      cur = up;
    }
    settled.push(cur);
  }
  // Keep the original document order (stable ids → stable React keys).
  const byId = new Map(settled.map((w) => [w.id, w]));
  return widgets.map((w) => byId.get(w.id)!);
}

/** First free spot (top-left first) for a box of w × h. */
export function findSpot(widgets: Widget[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < MAX_ROWS; y++) {
    for (let x = 0; x + w <= GRID_COLS; x++) {
      const probe = { x, y, w, h } as Widget;
      if (!widgets.some((o) => overlaps(o, probe))) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, ...widgets.map((o) => o.y + o.h)) };
}

/* -------------------------------------------------------------- operations */

export type WidgetInput = { type: WidgetType; title?: string; x?: number; y?: number; w?: number; h?: number; config?: Config };
export type DashOp =
  | { op: "add"; widget: WidgetInput }
  | { op: "update"; id: string; title?: string; config?: Config; replaceConfig?: boolean; x?: number; y?: number; w?: number; h?: number }
  | { op: "remove"; id: string }
  | { op: "move"; items: { id: string; x: number; y: number; w?: number; h?: number }[] }
  | { op: "theme"; theme: { accent?: string | null; density?: Density | null; background?: Background | null } };

const optInt = (o: Raw, key: string, min: number, max: number): number | undefined => {
  const v = o[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new DashError(`"${key}" must be an integer`);
  if (v < min || v > max) throw new DashError(`"${key}" must be between ${min} and ${max}`);
  return v;
};

function widgetId(raw: unknown): string {
  if (typeof raw !== "string" || !WIDGET_ID.test(raw)) throw new DashError('"id" is not a valid widget id');
  return raw;
}

/** Parses an untrusted operation (JSON from the UI or MCP arguments) into a DashOp. */
export function parseOp(raw: unknown): DashOp {
  const o = obj(raw, "operation");
  switch (o.op) {
    case "add": {
      const w = obj(o.widget, "widget");
      onlyKeys(w, ["type", "title", "x", "y", "w", "h", "config"], "widget");
      if (!isWidgetType(w.type)) throw new DashError(`"type" must be one of: ${WIDGET_TYPES.join(", ")}`);
      return {
        op: "add",
        widget: {
          type: w.type,
          title: text(w, "title", TITLE_MAX).trim(),
          x: optInt(w, "x", 0, GRID_COLS - 1),
          y: optInt(w, "y", 0, MAX_ROWS - 1),
          w: optInt(w, "w", 1, GRID_COLS),
          h: optInt(w, "h", 1, MAX_H),
          config: w.config == null ? undefined : obj(w.config, "config"),
        },
      };
    }
    case "update": {
      onlyKeys(o, ["op", "id", "title", "config", "replaceConfig", "x", "y", "w", "h"], "update");
      return {
        op: "update",
        id: widgetId(o.id),
        title: o.title == null ? undefined : text(o, "title", TITLE_MAX).trim(),
        config: o.config == null ? undefined : obj(o.config, "config"),
        replaceConfig: bool(o, "replaceConfig", false),
        x: optInt(o, "x", 0, GRID_COLS - 1),
        y: optInt(o, "y", 0, MAX_ROWS - 1),
        w: optInt(o, "w", 1, GRID_COLS),
        h: optInt(o, "h", 1, MAX_H),
      };
    }
    case "remove":
      return { op: "remove", id: widgetId(o.id) };
    case "move": {
      const items = list(o, "items", MAX_WIDGETS).map((v, i) => {
        const it = obj(v, `items[${i}]`);
        onlyKeys(it, ["id", "x", "y", "w", "h"], `items[${i}]`);
        const x = optInt(it, "x", 0, GRID_COLS - 1);
        const y = optInt(it, "y", 0, MAX_ROWS - 1);
        if (x == null || y == null) throw new DashError(`items[${i}] needs "x" and "y"`);
        return { id: widgetId(it.id), x, y, w: optInt(it, "w", 1, GRID_COLS), h: optInt(it, "h", 1, MAX_H) };
      });
      if (!items.length) throw new DashError('"items" must not be empty');
      return { op: "move", items };
    }
    case "theme": {
      const t = obj(o.theme, "theme");
      onlyKeys(t, ["accent", "density", "background"], "theme");
      const theme: Extract<DashOp, { op: "theme" }>["theme"] = {};
      if (t.accent !== undefined) {
        if (t.accent !== null && (typeof t.accent !== "string" || !HEX_COLOR.test(t.accent))) throw new DashError('"accent" must be a color like "#3b6cf6" or null');
        theme.accent = t.accent === null ? null : t.accent.toLowerCase();
      }
      if (t.density !== undefined) theme.density = t.density === null ? null : oneOf(t, "density", ["comfortable", "compact"] as const, "comfortable");
      if (t.background !== undefined) theme.background = t.background === null ? null : oneOf(t, "background", ["plain", "muted", "grid"] as const, "plain");
      return { op: "theme", theme };
    }
    default:
      throw new DashError('"op" must be one of: add, update, remove, move, theme');
  }
}

/**
 * Applies operations to a document (pure). `newId` makes ids for added widgets. Returns the new
 * widgets/theme (the caller bumps the version) and the ids of widgets added, in order.
 */
export function applyOps(doc: DashboardDoc, ops: DashOp[], newId: () => string): { doc: DashboardDoc; added: string[] } {
  let widgets = doc.widgets.map((w) => ({ ...w }));
  let theme: Theme = { ...doc.theme };
  const added: string[] = [];
  const find = (id: string) => {
    const w = widgets.find((x) => x.id === id);
    if (!w) throw new DashError(`No widget with id "${id}"`);
    return w;
  };
  for (const op of ops) {
    if (op.op === "add") {
      if (widgets.length >= MAX_WIDGETS) throw new DashError(`A dashboard can have at most ${MAX_WIDGETS} widgets`);
      const spec = WIDGETS[op.widget.type];
      const config = validateConfig(op.widget.type, op.widget.config ?? {});
      const w = Math.min(GRID_COLS, Math.max(spec.minW, op.widget.w ?? spec.defW));
      const h = Math.min(MAX_H, Math.max(spec.minH, op.widget.h ?? spec.defH));
      const spot = op.widget.x != null && op.widget.y != null ? { x: op.widget.x, y: op.widget.y } : findSpot(widgets, w, h);
      const id = newId();
      widgets.push(clampBox({ id, type: op.widget.type, title: op.widget.title ?? "", x: spot.x, y: spot.y, w, h, config }));
      widgets = normalizeLayout(widgets, [id]);
      added.push(id);
    } else if (op.op === "update") {
      const cur = find(op.id);
      const next: Widget = { ...cur };
      if (op.title != null) next.title = op.title;
      if (op.config) next.config = validateConfig(cur.type, op.replaceConfig ? op.config : { ...cur.config, ...op.config });
      if (op.x != null) next.x = op.x;
      if (op.y != null) next.y = op.y;
      if (op.w != null) next.w = op.w;
      if (op.h != null) next.h = op.h;
      widgets = widgets.map((w) => (w.id === op.id ? clampBox(next) : w));
      if (op.x != null || op.y != null || op.w != null || op.h != null) widgets = normalizeLayout(widgets, [op.id]);
    } else if (op.op === "remove") {
      find(op.id);
      widgets = normalizeLayout(widgets.filter((w) => w.id !== op.id));
    } else if (op.op === "move") {
      const moved = new Set<string>();
      for (const it of op.items) {
        const cur = find(it.id);
        Object.assign(cur, clampBox({ ...cur, x: it.x, y: it.y, w: it.w ?? cur.w, h: it.h ?? cur.h }));
        moved.add(it.id);
      }
      widgets = normalizeLayout(widgets, moved);
    } else {
      for (const key of ["accent", "density", "background"] as const) {
        const v = op.theme[key];
        if (v === null) delete theme[key];
        else if (v !== undefined) theme = { ...theme, [key]: v };
      }
    }
  }
  const next = { version: doc.version, theme, widgets };
  if (utf8Bytes(JSON.stringify(next)) > DOC_MAX_BYTES) throw new DashError("The dashboard is too large (custom HTML included)");
  return { doc: next, added };
}

/** Repairs a stored document (unknown types dropped, configs re-validated, layout normalized). */
export function sanitizeDoc(raw: unknown): DashboardDoc | null {
  if (!isObj(raw) || !Array.isArray(raw.widgets)) return null;
  const widgets: Widget[] = [];
  for (const v of raw.widgets.slice(0, MAX_WIDGETS)) {
    if (!isObj(v) || !isWidgetType(v.type) || typeof v.id !== "string" || !WIDGET_ID.test(v.id)) continue;
    let config: Config;
    try {
      config = validateConfig(v.type, v.config);
    } catch {
      config = validateConfig(v.type, {});
    }
    const n = (k: string) => (typeof v[k] === "number" && Number.isFinite(v[k]) ? (v[k] as number) : 0);
    widgets.push(clampBox({ id: v.id, type: v.type, title: typeof v.title === "string" ? v.title.slice(0, TITLE_MAX) : "", x: n("x"), y: n("y"), w: n("w"), h: n("h"), config }));
  }
  let theme: Theme = {};
  try {
    theme = applyOps({ version: 0, theme: {}, widgets: [] }, [parseOp({ op: "theme", theme: isObj(raw.theme) ? raw.theme : {} })], () => "").doc.theme;
  } catch {
    theme = {};
  }
  return { version: typeof raw.version === "number" ? raw.version : 1, theme, widgets: normalizeLayout(widgets) };
}

/** The dashboard a new user starts with (the notes hint is localized). */
export function defaultDoc(locale: string, makeId: () => string): DashboardDoc {
  const hint =
    locale === "en"
      ? "### Make it yours\n\nAsk Claude to customize your dashboard: *“add a widget with my unread mail from Ana”*, *“show the time in New York and Tokyo”*, *“make a chart of this week's sales”*.\n\nOr use **Edit layout** to move, resize and add widgets yourself."
      : "### Hazlo tuyo\n\nPídele a Claude que personalice tu dashboard: *«añade un widget con mis correos sin leer de Ana»*, *«muestra la hora en Nueva York y Tokio»*, *«haz un gráfico con las ventas de esta semana»*.\n\nO usa **Editar diseño** para mover, redimensionar y añadir widgets tú mismo.";
  const mk = (type: WidgetType, x: number, y: number, w: number, h: number, config: Config = {}): Widget => ({
    id: makeId(),
    type,
    title: "",
    x,
    y,
    w,
    h,
    config: validateConfig(type, config),
  });
  return {
    version: 1,
    theme: {},
    widgets: [
      mk("agenda", 0, 0, 4, 8),
      mk("mail", 4, 0, 4, 8, { mode: "unread" }),
      mk("chat", 8, 0, 4, 8, { mode: "unread" }),
      mk("drive", 0, 8, 8, 6, { mode: "recent", limit: 8 }),
      mk("notes", 8, 8, 4, 6, { text: hint }),
    ],
  };
}

/** Compact description of the dashboard for Claude's prompt (custom HTML summarized). */
export function summarizeDoc(doc: DashboardDoc) {
  return {
    version: doc.version,
    theme: doc.theme,
    widgets: doc.widgets.map((w) => ({
      id: w.id,
      type: w.type,
      title: w.title || undefined,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      config:
        w.type === "custom"
          ? { htmlBytes: utf8Bytes(String(w.config.html ?? "")), htmlStart: String(w.config.html ?? "").slice(0, 400) }
          : w.type === "notes"
            ? { text: String(w.config.text ?? "").slice(0, 600) }
            : w.config,
    })),
  };
}

/* ----------------------------------------------------------------- chat */

export type TurnStatus = "queued" | "dispatched" | "needs_confirmation" | "done" | "failed" | "cancelled";
export type TurnView = {
  id: string;
  text: string;
  createdAt: number;
  commandId: string | null;
  status: TurnStatus;
  progress: string | null;
  result: string | null;
};
export type ChatState = {
  turns: TurnView[];
  confirmations: { id: string; commandId: string; tool: string; summary: string; expiresAt: number }[];
  bridge: { connected: boolean; lastSeen: number | null };
  hasWriteToken: boolean;
};
export const isFinalTurn = (s: TurnStatus) => s === "done" || s === "failed" || s === "cancelled";
