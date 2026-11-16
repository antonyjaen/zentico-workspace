// Google Calendar (events read/write) and Drive (read-only search and text read). Server-only.
import { callApi } from "./api";
import { arr, clip, obj, ProviderError, providerFetch, str, statusError } from "./http";
import { provider } from "./providers";

const CAL = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";

const CALENDAR_ID = /^[A-Za-z0-9._@#+-]{1,200}$/;
export function parseCalendarId(v: unknown): string {
  if (v == null || v === "") return "primary";
  if (typeof v !== "string" || !CALENDAR_ID.test(v)) throw new ProviderError("invalid", "Invalid calendarId.");
  return v;
}

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export function parseFileId(v: unknown): string {
  let s = typeof v === "string" ? v.trim() : "";
  const m = /\/d\/([A-Za-z0-9_-]{10,200})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,200})/.exec(s);
  if (m) s = m[1];
  if (!FILE_ID.test(s)) throw new ProviderError("invalid", "Invalid Drive file id.");
  return s;
}

function eventView(raw: unknown) {
  const e = obj(raw);
  const start = obj(e.start);
  const end = obj(e.end);
  return {
    id: str(e.id),
    title: clip(str(e.summary), 300),
    start: str(start.dateTime) || str(start.date),
    end: str(end.dateTime) || str(end.date),
    allDay: !start.dateTime,
    location: clip(str(e.location), 300) || null,
    description: clip(str(e.description), 1000) || null,
    status: str(e.status),
    organizer: str(obj(e.organizer).email) || null,
    attendees: arr(e.attendees)
      .slice(0, 30)
      .map((a) => ({ email: str(obj(a).email), response: str(obj(a).responseStatus) })),
    meetLink: str(e.hangoutLink) || null,
    url: str(e.htmlLink),
  };
}

export async function listEvents(token: string, opts: { calendarId: string; timeMin: string; timeMax: string; query?: string; limit: number }) {
  const q = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    maxResults: String(opts.limit),
  });
  if (opts.query) q.set("q", opts.query);
  const { json } = await callApi("google", token, `${CAL}/calendars/${encodeURIComponent(opts.calendarId)}/events?${q}`);
  const o = obj(json);
  return { timeZone: str(o.timeZone) || null, events: arr(o.items).map(eventView) };
}

export async function createEvent(
  token: string,
  input: {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    timeZone?: string;
    description?: string;
    location?: string;
    attendees: string[];
  },
) {
  const time = (v: string) => (input.allDay ? { date: v } : { dateTime: v, ...(input.timeZone ? { timeZone: input.timeZone } : {}) });
  const body = {
    summary: input.title,
    start: time(input.start),
    end: time(input.end),
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.attendees.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
  };
  const sendUpdates = input.attendees.length ? "all" : "none";
  const { json } = await callApi("google", token, `${CAL}/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=${sendUpdates}`, {
    method: "POST",
    body,
  });
  return eventView(json);
}

/** Drive query string literal ('…' with \ and ' escaped). */
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export async function driveSearch(token: string, opts: { query: string; limit: number; mimeType?: string }) {
  const parts = ["trashed = false"];
  if (opts.query) parts.push(`(name contains ${lit(opts.query)} or fullText contains ${lit(opts.query)})`);
  if (opts.mimeType) parts.push(`mimeType = ${lit(opts.mimeType)}`);
  const q = new URLSearchParams({
    q: parts.join(" and "),
    pageSize: String(opts.limit),
    fields: "files(id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress))",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  // Drive refuses orderBy together with fullText search.
  if (!opts.query) q.set("orderBy", "modifiedTime desc");
  const { json } = await callApi("google", token, `${DRIVE}/files?${q}`);
  return arr(obj(json).files).map((raw) => {
    const f = obj(raw);
    return {
      id: str(f.id),
      name: clip(str(f.name), 300),
      mimeType: str(f.mimeType),
      modified: str(f.modifiedTime),
      size: f.size ? Number(f.size) : null,
      owner: str(obj(arr(f.owners)[0]).displayName) || str(obj(arr(f.owners)[0]).emailAddress) || null,
      url: str(f.webViewLink),
    };
  });
}

const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-sh|sql|markdown))/;
const MAX_READ_BYTES = 1536 * 1024;

export async function driveReadText(token: string, fileId: string, maxChars: number) {
  const { json } = await callApi("google", token, `${DRIVE}/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,webViewLink&supportsAllDrives=true`);
  const f = obj(json);
  const mime = str(f.mimeType);
  let url: string;
  if (EXPORTS[mime]) url = `${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent(EXPORTS[mime])}`;
  else if (TEXTUAL.test(mime)) url = `${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`;
  else throw new ProviderError("unsupported", `Can't read "${clip(str(f.name), 120)}" as text (${mime || "unknown type"}).`);
  const res = await providerFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    hosts: provider("google").hosts,
    maxBytes: MAX_READ_BYTES,
  }).catch((e: unknown) => {
    if (e instanceof ProviderError && e.code === "tooLarge") throw new ProviderError("tooLarge", "The file is too large to read as text here (over 1.5 MB).");
    throw e;
  });
  if (res.status === 401) throw statusError("Google", 401);
  if (res.status < 200 || res.status >= 300) throw statusError("Google", res.status);
  const text = res.text;
  return {
    id: fileId,
    name: str(f.name),
    mimeType: mime,
    modified: str(f.modifiedTime),
    url: str(f.webViewLink),
    truncated: text.length > maxChars,
    text: text.slice(0, maxChars),
  };
}
