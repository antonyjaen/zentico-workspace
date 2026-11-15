// Server-side Drive on JMAP FileNode (draft-ietf-jmap-filenode) with Stalwart.
// The draft is still moving, so every call is defensive: FileNode/query falls back to
// FileNode/get + local filtering, folders are detected by several signals, and unexpected
// server errors are logged (never tokens) so they can be adjusted against the live server.
//
// Sharing follows RFC 9670 (JMAP Sharing): nodes carry `myRights` and `shareWith`
// (principalId → rights), people/groups come from Principal/get, and data shared with the
// user shows up as extra (non-personal) accounts in the session. Every read/write takes an
// optional accountId; null/undefined means the user's primary FileNode account.
import { cache } from "react";
import { getSession } from "./auth";
import { env } from "./env";
import { CAP, jmap, JmapError, type Invocation } from "./jmap";

export const FILENODE = "urn:ietf:params:jmap:filenode";
export const QUOTA = "urn:ietf:params:jmap:quota";
export const PRINCIPALS = "urn:ietf:params:jmap:principals";
export const PRINCIPALS_OWNER = "urn:ietf:params:jmap:principals:owner";
const USING = [CAP.core, FILENODE];

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const TEXT_PREVIEW_BYTES = 200 * 1024;
export const ID = /^[A-Za-z0-9_-]{1,255}$/;
export const MIME = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;

/* ------------------------------------------------------------------ types */

export const RIGHT_KEYS = [
  "mayRead",
  "mayAddChildren",
  "mayRename",
  "mayDelete",
  "mayModifyContent",
  "mayShare",
  "maySetMetadata",
] as const;
export type Rights = Record<(typeof RIGHT_KEYS)[number], boolean>;

const rightsOf = (on: readonly (typeof RIGHT_KEYS)[number][]): Rights =>
  Object.fromEntries(RIGHT_KEYS.map((k) => [k, on.includes(k)])) as Rights;

export const FULL_RIGHTS = rightsOf(RIGHT_KEYS);
export const READ_RIGHTS = rightsOf(["mayRead"]);

export type ShareRole = "viewer" | "editor" | "manager";
export const ROLE_RIGHTS: Record<ShareRole, Rights> = {
  viewer: READ_RIGHTS,
  editor: rightsOf(["mayRead", "mayAddChildren", "mayRename", "mayDelete", "mayModifyContent", "maySetMetadata"]),
  manager: FULL_RIGHTS,
};

/** Closest role for a rights object (null when it grants nothing). */
export function roleOf(r: Partial<Rights> | null | undefined): ShareRole | null {
  if (!r) return null;
  if (r.mayShare) return "manager";
  if (r.mayModifyContent || r.mayAddChildren || r.mayRename || r.mayDelete || r.maySetMetadata) return "editor";
  if (r.mayRead) return "viewer";
  return null;
}

export type DriveNode = {
  id: string;
  accountId: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  blobId: string | null;
  type: string;
  size: number;
  created: string | null;
  modified: string | null;
  role: string | null;
  rights: Rights;
  /** True when `shareWith` has at least one grant (only known when the server returns it). */
  shared: boolean;
};

type RawNode = {
  id?: string;
  parentId?: string | null;
  name?: string | null;
  blobId?: string | null;
  "@type"?: string | null;
  type?: string | null;
  mediaType?: string | null;
  size?: number | null;
  created?: string | null;
  modified?: string | null;
  updated?: string | null;
  role?: string | null;
  myRights?: Partial<Rights> | null;
  shareWith?: Record<string, Partial<Rights> | null> | null;
};

export class DriveError extends Error {
  constructor(
    message: string,
    readonly code: string = "failed",
  ) {
    super(message);
  }
}

/* ---------------------------------------------------------------- session */

export type SessionAccount = {
  id: string;
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  isPrimary: boolean;
  /** RFC 9670 principals:owner → principalId of the account's owner, when advertised. */
  ownerPrincipalId: string | null;
};

type DriveSession = {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  /** Primary FileNode account. */
  accountId: string;
  /** Every account with FileNode support (primary first). */
  accounts: SessionAccount[];
  quotaAccountId: string | null;
  principalsAccountId: string | null;
  selfPrincipalId: string | null;
  token: string;
};

type RawAccount = {
  name?: string;
  isPersonal?: boolean;
  isReadOnly?: boolean;
  accountCapabilities?: Record<string, unknown>;
};

type RawSession = {
  apiUrl?: string;
  uploadUrl?: string;
  downloadUrl?: string;
  capabilities?: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, RawAccount>;
};

function ownerPrincipal(a: RawAccount | undefined): string | null {
  const cap = a?.accountCapabilities?.[PRINCIPALS_OWNER] as { principalId?: unknown } | undefined;
  return typeof cap?.principalId === "string" && ID.test(cap.principalId) ? cap.principalId : null;
}

/** JMAP session details for Drive; null when the server has no FileNode support. */
export const getDriveSession = cache(async (): Promise<DriveSession | null> => {
  const session = await getSession();
  if (!session) return null;
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP session failed: ${res.status}`);
  const s = (await res.json()) as RawSession;
  if (!s.capabilities?.[FILENODE] || !s.apiUrl || !s.uploadUrl || !s.downloadUrl) return null;
  const raw = s.accounts ?? {};
  const accountId =
    s.primaryAccounts?.[FILENODE] ??
    Object.entries(raw).find(([, a]) => a.accountCapabilities?.[FILENODE] && a.isPersonal !== false)?.[0] ??
    s.primaryAccounts?.[CAP.mail];
  if (!accountId) return null;
  const accounts: SessionAccount[] = Object.entries(raw)
    .filter(([id, a]) => id === accountId || (ID.test(id) && a.accountCapabilities?.[FILENODE]))
    .map(([id, a]) => ({
      id,
      name: a.name || id,
      isPersonal: a.isPersonal !== false,
      isReadOnly: a.isReadOnly === true,
      isPrimary: id === accountId,
      ownerPrincipalId: ownerPrincipal(a),
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  if (!accounts.some((a) => a.isPrimary)) {
    accounts.unshift({ id: accountId, name: "", isPersonal: true, isReadOnly: false, isPrimary: true, ownerPrincipalId: null });
  }
  return {
    apiUrl: s.apiUrl,
    uploadUrl: s.uploadUrl,
    downloadUrl: s.downloadUrl,
    accountId,
    accounts,
    quotaAccountId: s.capabilities?.[QUOTA] ? (s.primaryAccounts?.[QUOTA] ?? accountId) : null,
    principalsAccountId: s.capabilities?.[PRINCIPALS] ? (s.primaryAccounts?.[PRINCIPALS] ?? accountId) : null,
    selfPrincipalId: ownerPrincipal(raw[accountId]),
    token: session.accessToken,
  };
});

/**
 * Resolves an account id from untrusted input: null/undefined/"" → primary. Any other id must
 * be one of the session's FileNode accounts.
 */
export async function resolveAccount(accountId?: string | null): Promise<SessionAccount> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  if (!accountId) return s.accounts.find((a) => a.isPrimary)!;
  const found = s.accounts.find((a) => a.id === accountId);
  if (!found) throw new DriveError("Unknown account", "not_found");
  return found;
}

async function account(accountId?: string | null): Promise<string> {
  return (await resolveAccount(accountId)).id;
}

/* ------------------------------------------------------------- validation */

/** Returns a clean node name or null: no '/', no control chars, 1–255 chars, not "." / "..". */
export function validName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").trim();
  if (!s || s.length > 255 || s === "." || s === "..") return null;
  if (/[\u0000-\u001f\u007f/]/.test(s)) return null;
  return s;
}

export const validId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/* -------------------------------------------------------------- normalize */

function isFolderRaw(n: RawNode): boolean {
  if (n["@type"]) return n["@type"] === "Directory";
  const type = (n.mediaType ?? n.type ?? "").toLowerCase();
  return n.blobId == null || type === "inode/directory" || type === "httpd/unix-directory";
}

function normalizeRights(r: Partial<Rights> | null | undefined, fallback: Rights): Rights {
  if (!r || typeof r !== "object") return fallback;
  return Object.fromEntries(RIGHT_KEYS.map((k) => [k, r[k] === true])) as Rights;
}

const hasGrants = (sw: RawNode["shareWith"]) =>
  !!sw && typeof sw === "object" && Object.values(sw).some((r) => r && Object.values(r).some(Boolean));

function normalize(n: RawNode, accountId: string, isPrimary: boolean): DriveNode | null {
  if (!n.id) return null;
  const isFolder = isFolderRaw(n);
  return {
    id: n.id,
    accountId,
    parentId: n.parentId ?? null,
    name: n.name ?? "",
    isFolder,
    blobId: isFolder ? null : (n.blobId ?? null),
    type: isFolder ? "inode/directory" : n.mediaType || n.type || "application/octet-stream",
    size: typeof n.size === "number" ? n.size : 0,
    created: n.created ?? null,
    modified: n.modified ?? n.updated ?? n.created ?? null,
    role: n.role ?? null,
    // Without myRights: owner of the primary account may do anything; elsewhere assume read-only.
    rights: normalizeRights(n.myRights, isPrimary ? FULL_RIGHTS : READ_RIGHTS),
    shared: hasGrants(n.shareWith),
  };
}

async function lister(accountId: string) {
  const acc = await resolveAccount(accountId);
  return (r: Record<string, unknown> | undefined): DriveNode[] =>
    ((r?.list as RawNode[] | undefined) ?? [])
      .map((n) => normalize(n, acc.id, acc.isPrimary))
      .filter((n): n is DriveNode => !!n);
}

function logError(where: string, e: unknown) {
  console.error(`[drive] ${where}:`, e instanceof Error ? e.message : e);
}

type TryResponse = { ok: true; args: Record<string, unknown> } | { ok: false; type: string; description?: string };

/**
 * Like jmap(), but method-level errors are returned instead of thrown, so optional calls
 * (properties the server may not know) can fail without failing the batch. Logs the errors.
 */
async function jmapTry(where: string, calls: Invocation[], using: string[]): Promise<Record<string, TryResponse>> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  const res = await fetch(s.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { type?: string; detail?: string };
      detail = ` ${body.type ?? ""} ${body.detail ?? ""}`.trimEnd();
    } catch {}
    throw new JmapError(`JMAP request failed: ${res.status}${detail}`);
  }
  const { methodResponses } = (await res.json()) as { methodResponses?: Invocation[] };
  const out: Record<string, TryResponse> = {};
  for (const [name, args, id] of methodResponses ?? []) {
    if (out[id]) continue;
    if (name === "error") {
      const err = { ok: false as const, type: String(args.type ?? "error"), description: args.description ? String(args.description) : undefined };
      logError(`${where} (${id})`, `${err.type}${err.description ? `: ${err.description}` : ""}`);
      out[id] = err;
    } else out[id] = { ok: true, args };
  }
  return out;
}

/* ------------------------------------------------------------------ reads */

const allNodes = cache(async (accountId: string): Promise<DriveNode[]> => {
  const r = await jmap([["FileNode/get", { accountId, ids: null }, "g"]], USING);
  return (await lister(accountId))(r.g);
});

/** Every node visible in the account (FileNode/get with ids: null). Cached per request. */
export async function getAllNodes(accountId?: string | null): Promise<DriveNode[]> {
  return allNodes(await account(accountId));
}

/** Nodes by id (missing ids are simply absent). */
export async function getNodes(ids: string[], accountId?: string | null): Promise<DriveNode[]> {
  if (!ids.length) return [];
  const acc = await account(accountId);
  const r = await jmap([["FileNode/get", { accountId: acc, ids }, "g"]], USING);
  return (await lister(acc))(r.g);
}

export async function getNode(id: string, accountId?: string | null): Promise<DriveNode | null> {
  if (!validId(id)) return null;
  return (await getNodes([id], accountId))[0] ?? null;
}

const rootIdOf = cache(async (accountId: string): Promise<string | null> => {
  const all = await allNodes(accountId).catch((e) => {
    logError("getAllNodes", e);
    return [] as DriveNode[];
  });
  return all.find((n) => n.parentId == null && n.isFolder && (n.role === "root" || n.role === "home"))?.id ?? null;
});

/**
 * Some servers expose one top-level home folder (role "root" / "home"); its id is then the
 * effective root. Returns null when top-level nodes are the root contents.
 */
export async function getRootId(accountId?: string | null): Promise<string | null> {
  return rootIdOf(await account(accountId));
}

const trashIdOf = cache(async (accountId: string): Promise<string | null> => {
  const all = await allNodes(accountId).catch(() => [] as DriveNode[]);
  return all.find((n) => n.isFolder && n.role === "trash")?.id ?? null;
});

/** Trash folder, when the server has one (role "trash") visible in the account. */
export async function getTrashId(accountId?: string | null): Promise<string | null> {
  return trashIdOf(await account(accountId));
}

/** Top-level visible nodes: parentless, or whose parent isn't visible (shared subtrees). */
function visibleRoots(all: DriveNode[]): DriveNode[] {
  const ids = new Set(all.map((n) => n.id));
  return all.filter((n) => n.parentId == null || !ids.has(n.parentId));
}

/** Children of a folder (null = root). Tries FileNode/query first, then get-all + filter. */
export async function listChildren(parentId: string | null, accountId?: string | null): Promise<DriveNode[]> {
  const acc = await account(accountId);
  const rootId = parentId ?? (await rootIdOf(acc));
  // Stalwart rejects `filter: { parentId: null }` (invalidArguments): list the root locally.
  if (rootId === null) return visibleRoots(await allNodes(acc));
  const want = (n: DriveNode) => (n.parentId ?? null) === rootId;
  try {
    const r = await jmap(
      [
        ["FileNode/query", { accountId: acc, filter: { parentId: rootId } }, "q"],
        ["FileNode/get", { accountId: acc, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" } }, "g"],
      ],
      USING,
    );
    // Filter locally too, in case the server ignored the filter.
    return (await lister(acc))(r.g).filter(want);
  } catch (e) {
    logError(`FileNode/query parentId=${rootId} (falling back to get-all)`, e);
    return (await allNodes(acc)).filter(want);
  }
}

/** Folder chain from the (visible) root down to (and including) `id`. */
export async function getPath(id: string, accountId?: string | null): Promise<DriveNode[]> {
  const acc = await account(accountId);
  const rootId = await rootIdOf(acc);
  const chain: DriveNode[] = [];
  let current: string | null = id;
  const seen = new Set<string>();
  while (current && current !== rootId && !seen.has(current) && chain.length < 64) {
    seen.add(current);
    const node = await getNode(current, acc);
    if (!node) break;
    chain.unshift(node);
    current = node.parentId;
  }
  return chain;
}

export type FolderEntry = { id: string; name: string; parentId: string | null };

/** All folders, for the move picker (trash and its contents excluded). */
export async function listFolders(accountId?: string | null): Promise<{ rootId: string | null; folders: FolderEntry[] }> {
  const acc = await account(accountId);
  const [all, rootId, trashId] = await Promise.all([allNodes(acc), rootIdOf(acc), trashIdOf(acc)]);
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  const visible = new Set(all.map((n) => n.id));
  return {
    rootId,
    folders: all
      .filter((n) => n.isFolder && n.id !== rootId && n.id !== trashId && !inTrash.has(n.id))
      .map(({ id, name, parentId }) => ({
        id,
        name,
        parentId: parentId === rootId || !parentId || !visible.has(parentId) ? null : parentId,
      })),
  };
}

/** Ids of every node below `id` (not including it). */
export function descendantsOf(all: DriveNode[], id: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const n of all) if (n.parentId) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n.id]);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of byParent.get(stack.pop()!) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
  }
  return out;
}

/** Case- and accent-insensitive substring search over names (server filters match whole words only). */
export async function searchNodes(q: string, accountId?: string | null): Promise<DriveNode[]> {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = fold(q);
  const [all, trashId] = await Promise.all([getAllNodes(accountId), getTrashId(accountId)]);
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  return all.filter((n) => n.role == null && !inTrash.has(n.id) && fold(n.name).includes(needle));
}

/** Most recently modified files. */
export async function recentFiles(limit = 50, accountId?: string | null): Promise<DriveNode[]> {
  const [all, trashId] = await Promise.all([getAllNodes(accountId), getTrashId(accountId)]);
  const inTrash = trashId ? descendantsOf(all, trashId) : new Set<string>();
  return all
    .filter((n) => !n.isFolder && !inTrash.has(n.id))
    .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
    .slice(0, limit);
}

export type Quota = { used: number; limit: number | null };

/** Storage usage (urn:ietf:params:jmap:quota); null if unsupported. */
export async function getQuota(): Promise<Quota | null> {
  const s = await getDriveSession();
  if (!s?.quotaAccountId) return null;
  try {
    const r = await jmap([["Quota/get", { accountId: s.quotaAccountId, ids: null }, "q"]], [CAP.core, QUOTA]);
    type RawQuota = { resourceType?: string; used?: number; hardLimit?: number; types?: string[]; scope?: string };
    const quotas = ((r.q.list as RawQuota[] | undefined) ?? []).filter((q) => q.resourceType === "octets");
    const pick =
      quotas.find((q) => q.types?.some((t) => /file/i.test(t))) ??
      quotas.find((q) => q.scope === "account") ??
      quotas[0];
    if (!pick) return null;
    return { used: pick.used ?? 0, limit: pick.hardLimit && pick.hardLimit > 0 ? pick.hardLimit : null };
  } catch (e) {
    logError("Quota/get", e);
    return null;
  }
}

/* ---------------------------------------------------------------- sharing */

// Set once the server rejects `shareWith` as a property, so lists stop asking for it.
let shareWithUnsupported = false;

/**
 * Fills `shared` for listed nodes with an explicit FileNode/get of `shareWith` (it may not be
 * a default property). Failures leave the nodes untouched.
 */
export async function annotateShared(nodes: DriveNode[]): Promise<DriveNode[]> {
  if (shareWithUnsupported || !nodes.length) return nodes;
  const byAccount = new Map<string, DriveNode[]>();
  for (const n of nodes) byAccount.set(n.accountId, [...(byAccount.get(n.accountId) ?? []), n]);
  const shared = new Set<string>();
  try {
    const calls: Invocation[] = [...byAccount.entries()].map(([accountId, list], i) => [
      "FileNode/get",
      { accountId, ids: list.map((n) => n.id), properties: ["id", "shareWith"] },
      `s${i}`,
    ]);
    const r = await jmapTry("FileNode/get shareWith", calls, USING);
    for (const res of Object.values(r)) {
      if (!res.ok) {
        if (/invalidArguments|unknownProperty|invalidProperties/i.test(res.type)) shareWithUnsupported = true;
        continue;
      }
      for (const raw of (res.args.list as RawNode[] | undefined) ?? []) if (raw.id && hasGrants(raw.shareWith)) shared.add(raw.id);
    }
  } catch (e) {
    logError("annotateShared", e);
    return nodes;
  }
  return nodes.map((n) => (n.shared || shared.has(n.id) ? { ...n, shared: true } : n));
}

export type Sharing = {
  /** False when the server doesn't expose `shareWith` on FileNode. */
  supported: boolean;
  node: DriveNode | null;
  shareWith: Record<string, Rights>;
};

/** Current grants of a node: FileNode/get with explicit properties incl. `shareWith`. */
export async function getSharing(id: string, accountId?: string | null): Promise<Sharing> {
  const acc = await resolveAccount(accountId);
  const r = await jmapTry(
    "FileNode/get sharing",
    [["FileNode/get", { accountId: acc.id, ids: [id], properties: ["id", "name", "parentId", "@type", "myRights", "shareWith"] }, "g"]],
    USING,
  );
  const res = r.g;
  if (!res?.ok) return { supported: false, node: null, shareWith: {} };
  const raw = ((res.args.list as RawNode[] | undefined) ?? [])[0];
  if (!raw) throw new DriveError("Not found", "not_found");
  const node = normalize(raw, acc.id, acc.isPrimary);
  if (!("shareWith" in raw)) {
    logError("FileNode/get sharing", "server returned no shareWith property");
    return { supported: false, node, shareWith: {} };
  }
  const shareWith: Record<string, Rights> = {};
  for (const [pid, rights] of Object.entries(raw.shareWith ?? {})) {
    if (rights && ID.test(pid)) shareWith[pid] = normalizeRights(rights, READ_RIGHTS);
  }
  return { supported: true, node, shareWith };
}

/**
 * `shareWith` of several nodes of one account in a single FileNode/get (e.g. a node and its
 * ancestors). Null when the server doesn't expose the property.
 */
export async function getShareWithMany(ids: string[], accountId?: string | null): Promise<Map<string, Record<string, Rights>> | null> {
  const out = new Map<string, Record<string, Rights>>();
  const valid = ids.filter(validId);
  if (!valid.length) return out;
  const acc = await account(accountId);
  const r = await jmapTry(
    "FileNode/get shareWith (many)",
    [["FileNode/get", { accountId: acc, ids: valid, properties: ["id", "shareWith"] }, "g"]],
    USING,
  );
  const res = r.g;
  if (!res?.ok) return null;
  const list = (res.args.list as RawNode[] | undefined) ?? [];
  if (list.length && !list.some((n) => "shareWith" in n)) return null;
  for (const raw of list) {
    if (!raw.id) continue;
    const grants: Record<string, Rights> = {};
    for (const [pid, rights] of Object.entries(raw.shareWith ?? {})) {
      if (rights && ID.test(pid)) grants[pid] = normalizeRights(rights, READ_RIGHTS);
    }
    out.set(raw.id, grants);
  }
  return out;
}

/** Grants (rights object) or revokes (null) access with a `shareWith/<principalId>` patch. */
export async function setShare(id: string, principalId: string, rights: Rights | null, accountId?: string | null): Promise<void> {
  if (!validId(id) || !validId(principalId)) throw new DriveError("Invalid id", "invalid");
  const acc = await account(accountId);
  const r = await jmapTry(
    "FileNode/set shareWith",
    [["FileNode/set", { accountId: acc, update: { [id]: { [`shareWith/${principalId}`]: rights } } }, "s"]],
    USING,
  );
  const res = r.s;
  if (!res?.ok) throw new DriveError(res?.description || res?.type || "FileNode/set failed", "share_failed");
  const err = firstError(res.args, "notUpdated");
  if (err) setFailure("update shareWith", err);
}

export type PrincipalEntry = { id: string; name: string; email: string | null; type: "individual" | "group"; accounts: string[] };

type RawPrincipal = { id?: string; type?: string; name?: string; email?: string | null; accounts?: Record<string, unknown> | null };

function toPrincipal(p: RawPrincipal): PrincipalEntry | null {
  if (!p.id || !ID.test(p.id) || (p.type !== "individual" && p.type !== "group")) return null;
  return {
    id: p.id,
    name: (p.name || p.email || p.id).slice(0, 200),
    email: typeof p.email === "string" ? p.email.slice(0, 320) : null,
    type: p.type,
    accounts: p.accounts && typeof p.accounts === "object" ? Object.keys(p.accounts) : [],
  };
}

/** People and groups the user can share with (Principal/query + Principal/get); null if unsupported. */
export const listPrincipals = cache(async (): Promise<PrincipalEntry[] | null> => {
  const s = await getDriveSession();
  if (!s?.principalsAccountId) return null;
  try {
    const accountId = s.principalsAccountId;
    const r = await jmapTry(
      "Principal/query",
      [
        ["Principal/query", { accountId, limit: 1000 }, "q"],
        ["Principal/get", { accountId, "#ids": { resultOf: "q", name: "Principal/query", path: "/ids" } }, "g"],
      ],
      [CAP.core, PRINCIPALS],
    );
    if (!r.g?.ok) return null;
    return ((r.g.args.list as RawPrincipal[] | undefined) ?? []).map(toPrincipal).filter((p): p is PrincipalEntry => !!p);
  } catch (e) {
    logError("Principal/query", e);
    return null;
  }
});

/** Principals by id (Principal/get), for grants that aren't in the query results. */
export async function getPrincipals(ids: string[]): Promise<PrincipalEntry[]> {
  const s = await getDriveSession();
  if (!s?.principalsAccountId || !ids.length) return [];
  try {
    const r = await jmapTry("Principal/get", [["Principal/get", { accountId: s.principalsAccountId, ids }, "g"]], [CAP.core, PRINCIPALS]);
    if (!r.g?.ok) return [];
    return ((r.g.args.list as RawPrincipal[] | undefined) ?? []).map(toPrincipal).filter((p): p is PrincipalEntry => !!p);
  } catch (e) {
    logError("Principal/get", e);
    return [];
  }
}

export type DriveAccount = { id: string; name: string; kind: "personal" | "shared" | "space"; isReadOnly: boolean };

const SPACE_NAME = /\b(team|teams|group|groups|space|spaces|equipo|equipos|grupo|grupos|espacio|espacios|shared|compartid[oa]s?)\b/i;

/**
 * Every FileNode account, classified: the primary is "personal"; other accounts are "space"
 * when their owner principal is a group (resolved via principals:owner → Principal/get, else by
 * matching Principal/query results, else a name heuristic) and "shared" otherwise.
 */
export const getDriveAccounts = cache(async (): Promise<DriveAccount[]> => {
  const s = await getDriveSession();
  if (!s) return [];
  const others = s.accounts.filter((a) => !a.isPrimary);
  const types = new Map<string, PrincipalEntry["type"]>();
  if (others.length) {
    const owners = [...new Set(others.map((a) => a.ownerPrincipalId).filter((x): x is string => !!x))];
    for (const p of await getPrincipals(owners)) types.set(p.id, p.type);
    if (others.some((a) => !a.ownerPrincipalId || !types.has(a.ownerPrincipalId))) {
      const all = (await listPrincipals()) ?? [];
      for (const a of others) {
        if (a.ownerPrincipalId && types.has(a.ownerPrincipalId)) continue;
        const name = a.name.toLowerCase();
        const match =
          all.find((p) => p.accounts.includes(a.id)) ??
          all.find((p) => p.id === a.id) ??
          all.find((p) => p.name.toLowerCase() === name || p.email?.toLowerCase() === name);
        if (match) types.set(`acct:${a.id}`, match.type);
      }
    }
  }
  return s.accounts.map((a) => {
    if (a.isPrimary) return { id: a.id, name: a.name, kind: "personal" as const, isReadOnly: a.isReadOnly };
    const type = (a.ownerPrincipalId && types.get(a.ownerPrincipalId)) || types.get(`acct:${a.id}`);
    const kind = type ? (type === "group" ? "space" : "shared") : SPACE_NAME.test(a.name) ? "space" : "shared";
    return { id: a.id, name: a.name, kind, isReadOnly: a.isReadOnly };
  });
});

/* ----------------------------------------------------------------- writes */

type SetError = { type?: string; description?: string; properties?: string[] };

function firstError(r: Record<string, unknown>, key: "notCreated" | "notUpdated" | "notDestroyed"): SetError | null {
  const errs = r[key] as Record<string, SetError> | null | undefined;
  return (errs && Object.values(errs)[0]) || null;
}

function setFailure(where: string, err: SetError): never {
  logError(`FileNode/set ${where}`, `${err.type ?? "error"}${err.description ? `: ${err.description}` : ""}`);
  const text = `${err.type} ${err.description}`;
  const code = /exist|duplicate|conflict/i.test(text) ? "exists" : /forbidden|permission|rights|denied/i.test(text) ? "forbidden" : "failed";
  throw new DriveError(err.description || err.type || "FileNode/set failed", code);
}

/** Picks a name that doesn't collide with siblings: "a.txt" → "a (1).txt". */
export async function uniqueName(parentId: string | null, name: string, accountId?: string | null): Promise<string> {
  const taken = new Set(
    (await listChildren(parentId, accountId).catch(() => [] as DriveNode[])).map((n) => n.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (candidate.length <= 255 && !taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

async function create(props: Record<string, unknown>, accountId?: string | null): Promise<DriveNode> {
  const acc = await resolveAccount(accountId);
  // Stalwart rejects explicit nulls on create, so empty fields are omitted.
  const clean: Record<string, unknown> = {
    // Stalwart requires `@type` on creation: "Directory" for folders, "File" (with blobId) for files.
    "@type": props.blobId ? "File" : "Directory",
    ...Object.fromEntries(
      Object.entries(props)
        .filter(([, v]) => v != null)
        // Stalwart calls the MIME type `mediaType` and rejects `type`.
        .map(([k, v]) => [k === "type" ? "mediaType" : k, v]),
    ),
  };
  const r = await jmap([["FileNode/set", { accountId: acc.id, create: { n: clean } }, "s"]], USING);
  const err = firstError(r.s, "notCreated");
  if (err) setFailure("create", err);
  const created = (r.s.created as Record<string, RawNode> | undefined)?.n;
  if (!created?.id) throw new DriveError("FileNode/set create returned no id");
  return (
    normalize({ ...(clean as RawNode), ...created }, acc.id, acc.isPrimary) ?? {
      id: created.id,
      accountId: acc.id,
      parentId: (clean.parentId as string) ?? null,
      name: String(clean.name),
      isFolder: !clean.blobId,
      blobId: (clean.blobId as string) ?? null,
      type: String(clean.mediaType ?? ""),
      size: 0,
      created: null,
      modified: null,
      role: null,
      rights: acc.isPrimary ? FULL_RIGHTS : READ_RIGHTS,
      shared: false,
    }
  );
}

async function effectiveParent(parentId: string | null, accountId?: string | null): Promise<string | null> {
  return parentId ?? (await getRootId(accountId));
}

export async function createFolder(parentId: string | null, name: string, accountId?: string | null): Promise<DriveNode> {
  const parent = await effectiveParent(parentId, accountId);
  return create({ parentId: parent, name: await uniqueName(parentId, name, accountId) }, accountId);
}

export async function createFile(
  parentId: string | null,
  name: string,
  blob: { blobId: string; type: string; size?: number },
  accountId?: string | null,
): Promise<DriveNode> {
  const parent = await effectiveParent(parentId, accountId);
  const node = await create(
    {
      parentId: parent,
      name: await uniqueName(parentId, name, accountId),
      blobId: blob.blobId,
      type: blob.type,
    },
    accountId,
  );
  return { ...node, isFolder: false, blobId: node.blobId ?? blob.blobId, size: node.size || blob.size || 0 };
}

export async function updateNode(
  id: string,
  patch: { name?: string; parentId?: string | null },
  accountId?: string | null,
): Promise<void> {
  const acc = await account(accountId);
  const p: Record<string, unknown> = { ...patch };
  if ("parentId" in patch) p.parentId = patch.parentId ?? (await rootIdOf(acc));
  const r = await jmap([["FileNode/set", { accountId: acc, update: { [id]: p } }, "s"]], USING);
  const err = firstError(r.s, "notUpdated");
  if (err) setFailure("update", err);
}

/** Moves nodes into `target` (null = root). Refuses moving a folder into itself or a descendant. */
export async function moveNodes(ids: string[], target: string | null, accountId?: string | null): Promise<void> {
  const acc = await account(accountId);
  const all = await allNodes(acc);
  if (target) {
    const dest = all.find((n) => n.id === target);
    if (!dest?.isFolder) throw new DriveError("Target is not a folder", "invalid");
    for (const id of ids) {
      if (id === target || descendantsOf(all, id).has(target)) throw new DriveError("Cannot move into itself", "cycle");
    }
  }
  const parent = target ?? (await rootIdOf(acc));
  const update = Object.fromEntries(ids.map((id) => [id, { parentId: parent }]));
  const r = await jmap([["FileNode/set", { accountId: acc, update }, "s"]], USING);
  const err = firstError(r.s, "notUpdated");
  if (err) setFailure("move", err);
}

/**
 * Permanently destroys nodes. Non-empty folders: retry with onDestroyRemoveChildren, and if the
 * server doesn't know that argument, destroy the descendants explicitly (deepest first).
 */
export async function destroyNodes(ids: string[], accountId?: string | null): Promise<void> {
  const acc = await account(accountId);
  const r = await jmap([["FileNode/set", { accountId: acc, destroy: ids }, "s"]], USING);
  const err = firstError(r.s, "notDestroyed");
  if (!err) return;
  logError("FileNode/set destroy (retrying with children)", `${err.type}: ${err.description ?? ""}`);
  const failed = Object.keys((r.s.notDestroyed as Record<string, unknown>) ?? {});
  try {
    const r2 = await jmap(
      [["FileNode/set", { accountId: acc, destroy: failed, onDestroyRemoveChildren: true }, "s"]],
      USING,
    );
    const err2 = firstError(r2.s, "notDestroyed");
    if (!err2) return;
  } catch (e) {
    logError("FileNode/set destroy onDestroyRemoveChildren", e);
  }
  const all = await getAllNodes(acc);
  const depth = (id: string) => {
    let d = 0;
    let cur = all.find((n) => n.id === id);
    while (cur?.parentId && d < 64) {
      cur = all.find((n) => n.id === cur!.parentId);
      d++;
    }
    return d;
  };
  const everything = [...new Set(failed.flatMap((id) => [...descendantsOf(all, id), id]))].sort(
    (a, b) => depth(b) - depth(a),
  );
  const r3 = await jmap([["FileNode/set", { accountId: acc, destroy: everything }, "s"]], USING);
  const err3 = firstError(r3.s, "notDestroyed");
  if (err3) setFailure("destroy", err3);
}

/* ------------------------------------------------------------------ blobs */

/** Streams `body` to the JMAP upload endpoint of `accountId`, aborting past `max` bytes. */
export async function uploadStream(
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  type: string,
  expected: number | null = null,
  opts: { max?: number; accountId?: string | null } = {},
): Promise<{ blobId: string; type: string; size: number }> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  const acc = await account(opts.accountId);
  const max = opts.max ?? MAX_UPLOAD_BYTES;
  let total = 0;
  if (body instanceof ArrayBuffer && body.byteLength > max) throw new DriveError("File too large", "too_large");
  const limited = body instanceof ArrayBuffer ? body : body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        total += chunk.byteLength;
        if (total > max) ctl.error(new DriveError("File too large", "too_large"));
        else ctl.enqueue(chunk);
      },
      flush(ctl) {
        // A short body means the request was cut off (e.g. a proxy/middleware body limit).
        if (expected != null && total !== expected) ctl.error(new DriveError("Body truncated", "truncated"));
      },
    }),
  );
  const url = s.uploadUrl.replace("{accountId}", encodeURIComponent(acc));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}`, "Content-Type": MIME.test(type) ? type : "application/octet-stream" },
      body: limited,
      cache: "no-store",
      // Required by Node's fetch for streaming request bodies.
      ...(body instanceof ArrayBuffer ? {} : { duplex: "half" }),
    } as RequestInit);
  } catch (e) {
    if (total > max) throw new DriveError("File too large", "too_large");
    if (expected != null && total !== expected) throw new DriveError("Body truncated", "truncated");
    throw e;
  }
  if (!res.ok) {
    logError("upload", `HTTP ${res.status}`);
    throw new DriveError(`Upload failed: ${res.status}`, res.status === 413 ? "too_large" : res.status === 403 ? "forbidden" : "failed");
  }
  const out = (await res.json()) as { blobId: string; type?: string; size?: number };
  return { blobId: out.blobId, type: out.type || type, size: out.size ?? (body instanceof ArrayBuffer ? body.byteLength : total) };
}

/**
 * Replaces a file's content: uploads a new blob and points the node at it (FileNode/set update
 * { blobId }). Mirrors FilesClient.replaceContent in lib/wopi: when the server doesn't derive
 * size/modified from the new blob, they're patched best effort. Returns the refreshed node.
 */
export async function replaceContent(
  id: string,
  body: ArrayBuffer,
  mediaType: string,
  accountId?: string | null,
): Promise<DriveNode> {
  if (!validId(id)) throw new DriveError("Invalid id", "invalid");
  const acc = await account(accountId);
  const before = await getNode(id, acc);
  if (!before || before.isFolder) throw new DriveError("Not found", "not_found");
  const { blobId, size } = await uploadStream(body, mediaType, null, { accountId: acc });
  const r = await jmap([["FileNode/set", { accountId: acc, update: { [id]: { blobId } } }, "s"]], USING);
  const err = firstError(r.s, "notUpdated");
  if (err) setFailure("update content", err);
  let next = (await getNode(id, acc)) ?? { ...before, blobId, size };
  const patch: Record<string, unknown> = {};
  if (next.size !== size) patch.size = size;
  if (!next.modified || next.modified === before.modified) patch.modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (Object.keys(patch).length) {
    const p = await jmapTry("FileNode/set size/modified", [["FileNode/set", { accountId: acc, update: { [id]: patch } }, "p"]], USING).catch(
      () => null,
    );
    if (p?.p?.ok) next = (await getNode(id, acc)) ?? next;
  }
  return { ...next, blobId: next.blobId ?? blobId };
}

/** Fetches a file's blob from the JMAP download endpoint (optionally forwarding a Range header). */
export async function fetchBlob(node: DriveNode, range?: string | null): Promise<Response> {
  const s = await getDriveSession();
  if (!s) throw new DriveError("Drive not available", "unavailable");
  if (!node.blobId) throw new DriveError("Not a file", "invalid");
  const url = s.downloadUrl
    .replace("{accountId}", encodeURIComponent(node.accountId || s.accountId))
    .replace("{blobId}", encodeURIComponent(node.blobId))
    .replace("{name}", encodeURIComponent(node.name || "file"))
    .replace("{type}", encodeURIComponent(MIME.test(node.type) ? node.type : "application/octet-stream"));
  const headers: Record<string, string> = { Authorization: `Bearer ${s.token}` };
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
  return fetch(url, { headers, cache: "no-store" });
}
