// Docs: WOPI host for Collabora Online over JMAP FileNode storage.
// Collabora calls the WOPI endpoints server-to-server without cookies, so every call carries
// a sealed access token that wraps the user's JMAP OAuth access token. The refresh token is never
// copied in: Stalwart rotates it and revokes the user's whole grant (signing them out) when a
// superseded copy is presented. Instead the open editor page re-sends the browser session's
// current access token (renewWopiCreds) before the one in the WOPI token expires.
import { getSession } from "./auth";
import { seal, sha256, base64url, randomToken, unseal } from "./crypto";
import { env } from "./env";
import { actingAccount } from "./jmap";

/* ------------------------------------------------------------------ config */

/** Base URL of the Collabora Online server, or null when Docs isn't configured. */
export function collaboraUrl(): string | null {
  const v = process.env.COLLABORA_URL?.trim().replace(/\/$/, "");
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin + u.pathname.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export const FILENODE_CAP = "urn:ietf:params:jmap:filenode";
const USING = ["urn:ietf:params:jmap:core", FILENODE_CAP];

/** Largest file accepted by PutFile. */
export const MAX_PUT_BYTES = 100 * 1024 * 1024;
/** Lifetime of a WOPI access token (an editing session). */
export const WOPI_TOKEN_TTL_MS = 10 * 60 * 60 * 1000;
/** WOPI locks expire after 30 minutes unless refreshed (per the WOPI spec). */
const LOCK_TTL_MS = 30 * 60 * 1000;

export const ID = /^[A-Za-z0-9_-]{1,255}$/;

/* ---------------------------------------------------------------- doc kinds */

export type DocKind = "text" | "spreadsheet" | "presentation";

const KIND_BY_EXT: Record<string, DocKind> = {
  odt: "text", ott: "text", doc: "text", docx: "text", docm: "text", dot: "text", dotx: "text", rtf: "text", txt: "text",
  ods: "spreadsheet", ots: "spreadsheet", xls: "spreadsheet", xlsx: "spreadsheet", xlsm: "spreadsheet", csv: "spreadsheet",
  odp: "presentation", otp: "presentation", ppt: "presentation", pptx: "presentation", pps: "presentation", ppsx: "presentation",
};

export const NEW_DOC: Record<DocKind, { ext: string; type: string }> = {
  text: { ext: "odt", type: "application/vnd.oasis.opendocument.text" },
  spreadsheet: { ext: "ods", type: "application/vnd.oasis.opendocument.spreadsheet" },
  presentation: { ext: "odp", type: "application/vnd.oasis.opendocument.presentation" },
};

export const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export const docKind = (name: string): DocKind | null => KIND_BY_EXT[extOf(name)] ?? null;

/* ------------------------------------------------------------------ client */

export type FileNode = {
  id: string;
  parentId: string | null;
  name: string;
  blobId: string | null;
  type: string | null;
  size: number;
  modified: string | null;
};

// Stalwart names the MIME type `mediaType`; it is exposed as `type` on FileNode below.
const NODE_PROPS = ["id", "parentId", "name", "blobId", "mediaType", "size", "modified"];
const fromRaw = (n: FileNode & { mediaType?: string | null }): FileNode => ({ ...n, type: n.mediaType ?? n.type ?? null });

export type Creds = {
  accessToken: string;
  /** Epoch ms when the access token expires (if known). */
  accessExpiresAt?: number;
  /**
   * FileNode account to work in when it isn't the token's own: the delegated account the user acts
   * as (verified against the JMAP session before it gets here). File ids are per account.
   */
  accountId?: string;
};

type JmapSession = {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  primaryAccounts: Record<string, string>;
};

export class FilesError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

const sessions = new Map<string, { at: number; session: JmapSession }>();
const keyOf = async (s: string) => base64url(await sha256(s));

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Minimal JMAP FileNode client bound to explicit credentials (no cookies needed). */
export class FilesClient {
  private session?: JmapSession;

  constructor(private creds: Creds) {}

  private authed(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.creds.accessToken}` },
      cache: "no-store",
    });
  }

  private async getSession(): Promise<JmapSession> {
    if (this.session) return this.session;
    const key = await keyOf(this.creds.accessToken);
    const hit = sessions.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return (this.session = hit.session);
    const res = await this.authed(`${env.issuer}/jmap/session`);
    if (res.status === 401) throw new FilesError("Unauthorized", 401);
    if (!res.ok) throw new FilesError(`JMAP session failed: ${res.status}`);
    const session = (await res.json()) as JmapSession;
    if (sessions.size > 500) sessions.clear();
    sessions.set(await keyOf(this.creds.accessToken), { at: Date.now(), session });
    return (this.session = session);
  }

  /** The token owner's own FileNode account (uploads must go there). */
  private async ownAccountId(): Promise<string> {
    const id = (await this.getSession()).primaryAccounts[FILENODE_CAP];
    if (!id) throw new FilesError("File storage is not available for this account", 503);
    return id;
  }

  async accountId(): Promise<string> {
    return this.creds.accountId ?? this.ownAccountId();
  }

  private async call(calls: [string, Record<string, unknown>, string][]) {
    const session = await this.getSession();
    const res = await this.authed(session.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: calls }),
    });
    if (res.status === 401) throw new FilesError("Unauthorized", 401);
    if (!res.ok) throw new FilesError(`JMAP request failed: ${res.status}`);
    const { methodResponses } = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, args, id] of methodResponses) {
      if (name === "error") throw new FilesError(`JMAP ${id}: ${String(args.type)}`);
      out[id] ??= args; // implicit responses may share the call id: keep the first (explicit) one
    }
    return out;
  }

  async getNode(id: string): Promise<FileNode | null> {
    const accountId = await this.accountId();
    const r = await this.call([["FileNode/get", { accountId, ids: [id], properties: NODE_PROPS }, "g"]]);
    const list = ((r.g?.list as FileNode[] | undefined) ?? []).map(fromRaw);
    return list.find((n) => n.id === id) ?? null;
  }

  /**
   * The user's RFC 9670 myRights on a node, or null when the server doesn't report them (an
   * optional property: asked for separately so a server without it can't break getNode).
   */
  async myRights(id: string): Promise<Partial<Record<"mayModifyContent" | "mayRename", boolean>> | null> {
    try {
      const accountId = await this.accountId();
      const r = await this.call([["FileNode/get", { accountId, ids: [id], properties: ["id", "myRights"] }, "g"]]);
      const raw = ((r.g?.list as { id?: string; myRights?: unknown }[] | undefined) ?? []).find((n) => n.id === id);
      const m = raw?.myRights;
      return m && typeof m === "object" ? (m as Record<string, boolean>) : null;
    } catch (e) {
      if (e instanceof FilesError && e.status === 401) throw e;
      return null;
    }
  }

  /** Every node in the account (files and folders). */
  async listNodes(): Promise<FileNode[]> {
    const accountId = await this.accountId();
    const r = await this.call([
      ["FileNode/query", { accountId }, "q"],
      ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: NODE_PROPS }, "g"],
    ]);
    return ((r.g?.list as FileNode[] | undefined) ?? []).map(fromRaw);
  }

  async upload(body: ArrayBuffer | Uint8Array, type: string): Promise<{ blobId: string; size: number }> {
    const session = await this.getSession();
    const accountId = await this.ownAccountId();
    const url = session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId));
    const res = await this.authed(url, {
      method: "POST",
      headers: { "Content-Type": type || "application/octet-stream" },
      body: body as BodyInit,
    });
    if (res.status === 401) throw new FilesError("Unauthorized", 401);
    if (!res.ok) throw new FilesError(`Upload failed: ${res.status}`);
    const out = (await res.json()) as { blobId: string; size: number };
    return { blobId: out.blobId, size: out.size };
  }

  async download(node: FileNode): Promise<Response> {
    if (!node.blobId) throw new FilesError("Not a file", 404);
    const session = await this.getSession();
    const accountId = await this.accountId();
    const url = session.downloadUrl
      .replace("{accountId}", encodeURIComponent(accountId))
      .replace("{blobId}", encodeURIComponent(node.blobId))
      .replace("{name}", encodeURIComponent(node.name))
      .replace("{type}", encodeURIComponent(node.type || "application/octet-stream"));
    const res = await this.authed(url);
    if (res.status === 401) throw new FilesError("Unauthorized", 401);
    if (!res.ok) throw new FilesError(`Download failed: ${res.status}`, res.status === 404 ? 404 : 502);
    return res;
  }

  /** Points an existing node at new content and returns the refreshed node. */
  async replaceContent(node: FileNode, body: Uint8Array): Promise<FileNode> {
    const accountId = await this.accountId();
    const type = node.type || "application/octet-stream";
    const { blobId, size } = await this.upload(body, type);
    const r = await this.call([["FileNode/set", { accountId, update: { [node.id]: { blobId } } }, "s"]]);
    if ((r.s?.notUpdated as Record<string, unknown> | undefined)?.[node.id]) {
      throw new FilesError("Could not save the file");
    }
    let next = (await this.getNode(node.id)) ?? { ...node, blobId, size };
    // Servers that don't derive size/modified from the new blob: set them ourselves (best effort).
    const patch: Record<string, unknown> = {};
    if (next.size !== size) patch.size = size;
    if (!next.modified || next.modified === node.modified) patch.modified = utcNow();
    if (Object.keys(patch).length) {
      await this.call([["FileNode/set", { accountId, update: { [node.id]: patch } }, "p"]]).catch(() => null);
      next = (await this.getNode(node.id)) ?? next;
    }
    return next;
  }

  async rename(node: FileNode, name: string): Promise<void> {
    const accountId = await this.accountId();
    const r = await this.call([["FileNode/set", { accountId, update: { [node.id]: { name } } }, "s"]]);
    if ((r.s?.notUpdated as Record<string, unknown> | undefined)?.[node.id]) {
      throw new FilesError("Rename rejected", 400);
    }
  }
}

/** Client for the signed-in user (cookie session), for pages and server actions. */
export async function userFiles(): Promise<{ client: FilesClient; creds: Creds; email: string; name: string } | null> {
  const s = await getSession();
  if (!s) return null;
  const acting = await actingAccount();
  const creds: Creds = { accessToken: s.accessToken, accessExpiresAt: s.expiresAt, ...(acting && { accountId: acting.id }) };
  return { client: new FilesClient(creds), creds, email: s.email, name: s.name };
}

/* ------------------------------------------------------------ WOPI tokens */

export type WopiToken = {
  fileId: string;
  /** Random id of this editing session (key of its renewed credentials). */
  sid?: string;
  accessToken: string;
  accessExpiresAt?: number;
  /** Delegated FileNode account (Creds.accountId), when not the token's own. */
  accountId?: string;
  email: string;
  name: string;
  /** Epoch ms. */
  exp: number;
};

export async function mintWopiToken(
  fileId: string,
  user: { creds: Creds; email: string; name: string },
): Promise<{ token: string; ttl: number }> {
  const exp = Date.now() + WOPI_TOKEN_TTL_MS;
  const payload: WopiToken = {
    fileId,
    sid: randomToken(16),
    accessToken: user.creds.accessToken,
    accessExpiresAt: user.creds.accessExpiresAt,
    ...(user.creds.accountId && { accountId: user.creds.accountId }),
    email: user.email,
    name: user.name,
    exp,
  };
  return { token: await seal({ wopi: 1, ...payload }), ttl: exp };
}

/** Validates the access token of a WOPI request against the file in the URL. */
export async function verifyWopiToken(req: Request, fileId: string): Promise<WopiToken | null> {
  const url = new URL(req.url);
  const raw =
    url.searchParams.get("access_token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    undefined;
  if (!raw || raw.length > 8192) return null;
  const t = await unseal<WopiToken & { wopi?: number }>(raw);
  if (!t || t.wopi !== 1 || typeof t.fileId !== "string" || t.fileId !== fileId) return null;
  if (typeof t.exp !== "number" || t.exp < Date.now() || typeof t.accessToken !== "string") return null;
  return t;
}

// Newer access tokens for open editing sessions, sent by the editor page (renewWopiCreds), keyed
// by the WOPI token's sid. In-memory: a restart drops them (reopening the document mints a new token).
const g = globalThis as typeof globalThis & { __zwWopiCreds?: Map<string, Creds & { accessExpiresAt: number; exp: number }> };
const renewed = (g.__zwWopiCreds ??= new Map());

/** Client for a WOPI request: the most recently renewed access token of its editing session. */
export function clientFor(t: WopiToken): FilesClient {
  const fresh = t.sid ? renewed.get(t.sid) : undefined;
  const accountId = typeof t.accountId === "string" && ID.test(t.accountId) ? t.accountId : undefined;
  if (fresh && fresh.accessExpiresAt > (t.accessExpiresAt ?? 0)) return new FilesClient({ ...fresh, accountId });
  return new FilesClient({ accessToken: t.accessToken, accessExpiresAt: t.accessExpiresAt, accountId });
}

/**
 * Stores the browser session's current access token for the editing session `rawToken` belongs
 * to. Only its own user may renew it. Returns false for an invalid/expired/foreign token.
 */
export async function renewWopiCreds(rawToken: string, user: { email: string; creds: Creds }): Promise<boolean> {
  if (rawToken.length > 8192) return false;
  const t = await unseal<WopiToken & { wopi?: number }>(rawToken);
  if (!t || t.wopi !== 1 || typeof t.sid !== "string" || typeof t.exp !== "number" || t.exp < Date.now()) return false;
  if (t.email.toLowerCase() !== user.email.toLowerCase() || !user.creds.accessExpiresAt) return false;
  const now = Date.now();
  for (const [k, v] of renewed) if (v.exp < now) renewed.delete(k);
  renewed.set(t.sid, { accessToken: user.creds.accessToken, accessExpiresAt: user.creds.accessExpiresAt, exp: t.exp });
  return true;
}

/* ------------------------------------------------------------------- locks */

// In-memory lock table: correct for a single app instance. Multiple instances would need a
// shared store (e.g. Redis). A restart drops locks, which PutFile tolerates (see contents route).
const locks = new Map<string, { lock: string; expires: number }>();

export function currentLock(fileId: string): string | null {
  const l = locks.get(fileId);
  if (!l) return null;
  if (l.expires < Date.now()) {
    locks.delete(fileId);
    return null;
  }
  return l.lock;
}

export function setLock(fileId: string, lock: string) {
  locks.set(fileId, { lock, expires: Date.now() + LOCK_TTL_MS });
}

export function clearLock(fileId: string) {
  locks.delete(fileId);
}

/* ------------------------------------------------------------------ helpers */

export const isoTime = (v: string | null | undefined) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
};

/** Decodes the UTF-7 that WOPI uses for X-WOPI-RequestedName. Plain ASCII passes through. */
export function decodeUtf7(s: string): string {
  return s.replace(/\+([A-Za-z0-9+/]*)-?/g, (_, b64: string) => {
    if (!b64) return "+";
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    let out = "";
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return out;
  });
}

/** Security headers for WOPI JSON/binary responses. */
export const WOPI_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export function wopiError(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers: { ...WOPI_HEADERS, ...headers } });
}

/* --------------------------------------------------------------- discovery */

type Discovery = { at: number; actions: Map<string, string> };
let discovery: Discovery | undefined;

/** Collabora's discovery XML as `${action}:${ext}` → urlsrc, cached for an hour. */
async function getDiscovery(base: string): Promise<Map<string, string>> {
  if (discovery && Date.now() - discovery.at < 3600_000) return discovery.actions;
  const res = await fetch(`${base}/hosting/discovery`, { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Collabora discovery failed: ${res.status}`);
  const xml = await res.text();
  const actions = new Map<string, string>();
  for (const m of xml.matchAll(/<action\b([^>]*)\/?>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (attrs.name && attrs.ext && attrs.urlsrc) {
      const key = `${attrs.name}:${attrs.ext.toLowerCase()}`;
      if (!actions.has(key)) actions.set(key, attrs.urlsrc.replace(/&amp;/g, "&"));
    }
  }
  discovery = { at: Date.now(), actions };
  return actions;
}

/** Extensions Collabora can open (edit or view), from its discovery document. */
export async function supportedExts(base: string): Promise<Set<string>> {
  const actions = await getDiscovery(base);
  const out = new Set<string>();
  for (const key of actions.keys()) {
    const [action, ext] = key.split(":");
    if ((action === "edit" || action === "view") && ext) out.add(ext);
  }
  return out;
}

/** Largest file sent to Collabora's convert-to endpoint. */
export const MAX_CONVERT_BYTES = 25 * 1024 * 1024;

/**
 * Converts a file with Collabora's convert-to API (POST {COLLABORA_URL}/cool/convert-to/<format>,
 * multipart field "data"). Null when Collabora isn't configured; throws when the conversion fails
 * (unsupported input, or this host not allowed by Collabora's convert-to allowlist).
 */
export async function convertWithCollabora(bytes: Uint8Array, fileName: string, format: string): Promise<ArrayBuffer | null> {
  const base = collaboraUrl();
  if (!base) return null;
  if (!/^[a-z0-9]{2,10}$/.test(format)) throw new Error("Invalid conversion format");
  if (bytes.byteLength > MAX_CONVERT_BYTES) throw new Error("File too large to convert");
  const form = new FormData();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.append("data", new Blob([copy.buffer]), fileName.replace(/[\u0000-\u001f\u007f"\\/]/g, "_") || "file");
  const res = await fetch(`${base}/cool/convert-to/${format}`, {
    method: "POST",
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Collabora convert-to failed: ${res.status}`);
  return res.arrayBuffer();
}

/** The Collabora editor URL (without WOPISrc) for a file name, or null if unsupported. */
export async function editorUrlFor(base: string, name: string): Promise<{ url: string; canEdit: boolean } | null> {
  const ext = extOf(name);
  const actions = await getDiscovery(base);
  const edit = actions.get(`edit:${ext}`);
  const src = edit ?? actions.get(`view:${ext}`);
  if (!src) return null;
  // Strip the optional <param=VALUE&> placeholders and make sure we can append query params.
  let url = src.replace(/<[^>]*>/g, "");
  url += url.includes("?") ? (/[?&]$/.test(url) ? "" : "&") : "?";
  return { url, canEdit: !!edit };
}

/**
 * Public base Collabora uses to call our WOPI endpoints. Defaults to APP_URL; set WOPI_BASE_URL
 * when Collabora only allows another host (e.g. a path on the Nextcloud domain proxied to us).
 */
const wopiBase = () => (process.env.WOPI_BASE_URL || env.appUrl).replace(/\/$/, "");
export const wopiSrc = (fileId: string) => `${wopiBase()}/api/wopi/files/${encodeURIComponent(fileId)}`;

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

/** True when Collabora would have to call back a loopback host (local development): editing can't work. */
export function wopiIsLocal(): boolean {
  try {
    return LOCAL_HOST.test(new URL(wopiBase()).hostname) || new URL(wopiBase()).hostname.endsWith(".localhost");
  } catch {
    return true;
  }
}
