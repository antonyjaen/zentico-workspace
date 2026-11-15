// Drive files in Chat: browsing for the picker, access checks against conversation members,
// granting access, per-viewer resolution of posted cards / pasted links and the "open" target.
// Every Drive call runs with the signed-in user's own token and rights. Server-only.
import { unstable_rethrow } from "next/navigation";
import { NATIVE, nativeKind } from "@/app/(apps)/docs/shared";
import { driveHref, isOffice } from "@/app/(apps)/drive/shared";
import {
  DRIVE_LINK_HOSTS,
  isDriveId,
  type ChatUser,
  type DriveAccessCheck,
  type DriveBrowse,
  type DriveCardData,
  type DriveGrant,
  type DrivePick,
  type DrivePickItem,
  type DriveRef,
} from "@/app/(apps)/chat/shared";
import {
  getAllNodes,
  getDriveSession,
  getNode,
  getPath,
  getRootId,
  getShareWithMany,
  getTrashId,
  listChildren,
  listPrincipals,
  recentFiles,
  resolveAccount,
  ROLE_RIGHTS,
  setShare,
  type DriveNode,
  type PrincipalEntry,
  type Rights,
  type SessionAccount,
} from "../drive";
import { env } from "../env";
import { readers } from "./store";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const localPart = (email: string) => email.slice(0, email.lastIndexOf("@")).toLowerCase();

/* ------------------------------------------------------------- browsing */

/** "Projects / 2026" for a node (its folders below the root), null at the top level. */
function locationOf(node: DriveNode, byId: Map<string, DriveNode>, rootId: string | null): string | null {
  const names: string[] = [];
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  const seen = new Set<string>();
  while (cur && cur.id !== rootId && !seen.has(cur.id) && names.length < 32) {
    seen.add(cur.id);
    if (cur.role == null) names.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return names.length ? names.join(" / ") : null;
}

function pickItem(n: DriveNode, location: string | null, owner: string | null): DrivePickItem {
  return { id: n.id, accountId: n.accountId, name: n.name, isFolder: n.isFolder, type: n.type, size: n.size, modified: n.modified, location, owner };
}

const sortFoldersFirst = (a: DrivePickItem, b: DrivePickItem) =>
  a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Picker tabs: recent files, My Drive (one folder) and Shared with me (account roots or one folder). */
export async function browse(view: "recent" | "my" | "shared", accountId: string | null, folderId: string | null): Promise<DriveBrowse> {
  const s = await getDriveSession();
  if (!s) return { items: [], path: [] };
  const primary = s.accountId;

  if (view === "recent") {
    const [nodes, all, rootId] = await Promise.all([recentFiles(50), getAllNodes(), getRootId()]);
    const byId = new Map(all.map((n) => [n.id, n]));
    return { items: nodes.filter((n) => n.role == null).map((n) => pickItem(n, locationOf(n, byId, rootId), null)), path: [] };
  }

  if (view === "my") {
    const [nodes, path, trashId] = await Promise.all([
      listChildren(folderId, primary),
      folderId ? getPath(folderId, primary) : Promise.resolve([] as DriveNode[]),
      getTrashId(primary).catch(() => null),
    ]);
    const location = path.length ? path.map((p) => p.name).join(" / ") : null;
    return {
      items: nodes.filter((n) => n.role == null && n.id !== trashId).map((n) => pickItem(n, location, null)).sort(sortFoldersFirst),
      path: path.map(({ id, name }) => ({ id, name })),
    };
  }

  // Shared with me: every non-primary FileNode account.
  if (accountId) {
    const acc = await resolveAccount(accountId);
    if (acc.isPrimary) return browse("my", null, folderId);
    const [nodes, path] = await Promise.all([
      listChildren(folderId, acc.id),
      folderId ? getPath(folderId, acc.id) : Promise.resolve([] as DriveNode[]),
    ]);
    const location = [acc.name, ...path.map((p) => p.name)].join(" / ");
    return {
      items: nodes.filter((n) => n.role == null).map((n) => pickItem(n, location, acc.name)).sort(sortFoldersFirst),
      path: path.map(({ id, name }) => ({ id, name })),
    };
  }
  const others = s.accounts.filter((a) => !a.isPrimary);
  const lists = await Promise.all(
    others.map((a) =>
      listChildren(null, a.id)
        .then((nodes) => nodes.filter((n) => n.role == null).map((n) => pickItem(n, a.name, a.name)))
        .catch((e) => {
          console.error(`[chat] drive shared roots of ${a.id}:`, errText(e));
          return [] as DrivePickItem[];
        }),
    ),
  );
  return { items: lists.flat().sort(sortFoldersFirst), path: [] };
}

/* ---------------------------------------------------------- resolution */

type Located = { node: DriveNode; account: SessionAccount };

/**
 * Finds a node for the signed-in user. With an account id it must be one of their session's
 * accounts; without one (links like /docs/edit/<id>) every account is tried, primary first.
 */
export async function locate(accountId: string | null, fileId: string): Promise<Located | null> {
  if (!isDriveId(fileId) || (accountId !== null && !isDriveId(accountId))) return null;
  const s = await getDriveSession();
  if (!s) return null;
  const candidates = accountId ? s.accounts.filter((a) => a.id === accountId) : s.accounts;
  for (const account of candidates) {
    try {
      const node = await getNode(fileId, account.id);
      if (node && node.rights.mayRead !== false) return { node, account };
    } catch (e) {
      unstable_rethrow(e);
      // Not visible in this account.
    }
  }
  return null;
}

/** Where "Open" goes for this viewer: the Docs editor (own office/whiteboard/Markdown files), the folder, or a Drive preview. */
export async function openTarget({ node, account }: Located): Promise<string> {
  const acct = account.isPrimary ? null : account.id;
  if (node.isFolder) return driveHref({ folder: node.id, account: acct });
  const native = nativeKind(node.name);
  if (account.isPrimary && (native || isOffice(node.name))) {
    return `/docs/${native ? NATIVE[native].route : "edit"}/${encodeURIComponent(node.id)}`;
  }
  // Preview in Drive, inside its folder when that folder is visible to the viewer.
  let folder: string | null = null;
  if (node.parentId) {
    const [all, rootId] = await Promise.all([getAllNodes(account.id).catch(() => [] as DriveNode[]), getRootId(account.id).catch(() => null)]);
    const parent = all.find((n) => n.id === node.parentId);
    if (parent && parent.id !== rootId && parent.role == null) folder = parent.id;
  }
  const base = driveHref({ folder, account: acct });
  return `${base}${base.includes("?") ? "&" : "?"}preview=${encodeURIComponent(node.id)}`;
}

export function refOf({ node, account }: Located, me: ChatUser): DriveRef {
  return {
    source: "drive",
    accountId: account.id,
    fileId: node.id,
    name: node.name,
    mediaType: node.type,
    size: node.isFolder ? 0 : node.size,
    isFolder: node.isFolder,
    owner: account.isPrimary ? me.name : account.name,
  };
}

/** Parses a Drive/Docs link of this app into an account (or null = unknown) and node id. */
export function parseDriveLink(url: string): { accountId: string | null; fileId: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let appHost = "";
  try {
    appHost = new URL(env.appUrl).host;
  } catch {}
  if (u.host !== appHost && !DRIVE_LINK_HOSTS.includes(u.host)) return null;
  const account = u.searchParams.get("account");
  const accountId = account && isDriveId(account) ? account : null;
  const p = u.pathname;
  let id: string | null = null;
  if (p === "/drive") id = u.searchParams.get("preview") || u.searchParams.get("folder");
  else if (p === "/api/chat/drive/open") id = u.searchParams.get("id");
  else {
    const m = /^\/(?:docs\/(?:edit|md|draw)|api\/drive\/file)\/([^/]+)$/.exec(p);
    if (m) {
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        id = null;
      }
    }
  }
  return id && isDriveId(id) ? { accountId, fileId: id } : null;
}

/** Cards for posted refs / pasted links, as this viewer sees them. */
export async function resolveCards(me: ChatUser, targets: { accountId: string | null; fileId: string }[]): Promise<DriveCardData[]> {
  return Promise.all(
    targets.map(async (t): Promise<DriveCardData> => {
      const found = await locate(t.accountId, t.fileId).catch(() => null);
      if (!found) return { ok: false, reason: "noAccess" };
      return { ok: true, ref: refOf(found, me), mine: found.account.isPrimary, modified: found.node.modified };
    }),
  );
}

/* --------------------------------------------------------------- access */

/** Principal id for each chat user, matched by address (then by an unambiguous local part). */
function principalMap(users: ChatUser[], principals: PrincipalEntry[]): Map<number, string> {
  const individuals = principals.filter((p) => p.type === "individual" && p.email);
  const byEmail = new Map(individuals.map((p) => [p.email!.toLowerCase(), p.id]));
  const byLocal = new Map<string, string[]>();
  for (const p of individuals) {
    const l = localPart(p.email!);
    byLocal.set(l, [...(byLocal.get(l) ?? []), p.id]);
  }
  const out = new Map<number, string>();
  for (const u of users) {
    const email = u.email.toLowerCase();
    const exact = byEmail.get(email);
    const local = byLocal.get(localPart(email));
    const pid = exact ?? (local?.length === 1 ? local[0] : undefined);
    if (pid) out.set(u.id, pid);
  }
  return out;
}

type Checked = {
  check: DriveAccessCheck;
  located: Located[];
  /** Principal ids to grant, per file (same order as `located`). */
  grantTo: string[][];
};

/**
 * Which readers of the conversation can't open each picked node: no read grant on the node or
 * any ancestor (folder grants cover their contents), and not the owner of the node's account.
 * Group grants can't be expanded, so their members count as missing (granting is additive).
 */
export async function checkAccess(me: ChatUser, convId: string, picks: DrivePick[]): Promise<Checked> {
  const others = readers(convId, me.id).filter((u) => u.id !== me.id);
  const located: Located[] = [];
  for (const p of picks) {
    const found = await locate(p.accountId, p.fileId);
    if (!found) throw new DriveAccessError("driveNotFound");
    if (!located.some((l) => l.account.id === found.account.id && l.node.id === found.node.id)) located.push(found);
  }
  const principals = others.length ? ((await listPrincipals()) ?? []) : [];
  const pids = principalMap(others, principals);
  const session = await getDriveSession();

  let supported = true;
  const check: DriveAccessCheck = { supported: true, files: [] };
  const grantTo: string[][] = [];
  for (const { node, account } of located) {
    const all = await getAllNodes(account.id).catch(() => [] as DriveNode[]);
    const byId = new Map(all.map((n) => [n.id, n]));
    const chain = [node.id];
    for (let cur = byId.get(node.parentId ?? ""); cur && chain.length < 64 && !chain.includes(cur.id); cur = byId.get(cur.parentId ?? ""))
      chain.push(cur.id);
    const grants = others.length ? await getShareWithMany(chain, account.id).catch(() => null) : new Map<string, Record<string, Rights>>();
    if (!grants) supported = false;
    const readersOf = new Set<string>();
    for (const g of grants?.values() ?? []) for (const [pid, r] of Object.entries(g)) if (r.mayRead) readersOf.add(pid);
    const owner =
      account.isPrimary
        ? session?.selfPrincipalId
        : (account.ownerPrincipalId ?? principals.find((p) => p.accounts.includes(account.id))?.id ?? null);
    if (owner) readersOf.add(owner);

    const missing: { id: number; name: string }[] = [];
    const unknown: { id: number; name: string }[] = [];
    const to: string[] = [];
    for (const u of others) {
      const pid = pids.get(u.id);
      if (pid && readersOf.has(pid)) continue;
      if (pid) {
        missing.push({ id: u.id, name: u.name });
        if (!to.includes(pid)) to.push(pid);
      } else unknown.push({ id: u.id, name: u.name });
    }
    grantTo.push(to);
    check.files.push({
      accountId: account.id,
      fileId: node.id,
      name: node.name,
      isFolder: node.isFolder,
      canShare: node.rights.mayShare,
      missing,
      unknown,
    });
  }
  if (!supported) {
    // Without grants we can't tell who's missing: no access step.
    check.supported = false;
    for (const f of check.files) {
      f.missing = [];
      f.unknown = [];
    }
    return { check, located, grantTo: grantTo.map(() => []) };
  }
  return { check, located, grantTo };
}

export class DriveAccessError extends Error {}

/** Grants `role` to everyone missing on the files the sender may share. Never touches existing grants. */
export async function grantMissing(checked: Checked, role: Exclude<DriveGrant, "none">): Promise<number> {
  let failed = 0;
  for (let i = 0; i < checked.located.length; i++) {
    const { node, account } = checked.located[i];
    if (!node.rights.mayShare) continue;
    for (const pid of checked.grantTo[i]) {
      try {
        await setShare(node.id, pid, ROLE_RIGHTS[role], account.id);
      } catch (e) {
        unstable_rethrow(e);
        console.error(`[chat] drive grant ${node.id} → ${pid}:`, errText(e));
        failed++;
      }
    }
  }
  return failed;
}
