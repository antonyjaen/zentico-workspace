"use server";

// Drive mutations. Every argument is untrusted: ids, names and account ids are validated here
// (account ids must also be one of the session's FileNode accounts, checked in lib/drive).
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { INIT_COOKIE, type Grant, type PrincipalOption } from "./shared";
import {
  createFile,
  createFolder,
  destroyNodes,
  DriveError,
  getAllNodes,
  getDriveSession,
  getNode,
  getPrincipals,
  getRootId,
  getSharing,
  getTrashId,
  listChildren,
  listFolders,
  listPrincipals,
  moveNodes,
  resolveAccount,
  ROLE_RIGHTS,
  roleOf,
  setShare,
  updateNode,
  uploadStream,
  validId,
  validName,
  type FolderEntry,
  type ShareRole,
} from "@/lib/drive";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

const MAX_BATCH = 500;

async function run<T>(fn: () => Promise<T>, mutates = true): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (mutates) revalidatePath("/drive");
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof DriveError) return { ok: false, error: e.code };
    console.error("[drive] action:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function parent(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (!validId(v)) throw new DriveError("Invalid folder", "invalid");
  return v;
}

/** Account id from the client (null = primary); membership is checked by resolveAccount. */
async function acct(v: unknown): Promise<string | null> {
  if (v == null || v === "") return null;
  if (!validId(v)) throw new DriveError("Invalid account", "invalid");
  return (await resolveAccount(v)).id;
}

function ids(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH || !v.every(validId)) {
    throw new DriveError("Invalid selection", "invalid");
  }
  return [...new Set(v as string[])];
}

function name(v: unknown): string {
  const n = validName(v);
  if (!n) throw new DriveError("Invalid name", "invalid_name");
  return n;
}

export async function newFolderAction(parentId: unknown, folderName: unknown, accountId?: unknown) {
  return run(async () => {
    const node = await createFolder(parent(parentId), name(folderName), await acct(accountId));
    return node.id;
  });
}

export async function renameAction(id: unknown, newName: unknown, accountId?: unknown) {
  return run(async () => {
    if (!validId(id)) throw new DriveError("Invalid id", "invalid");
    const account = await acct(accountId);
    const n = name(newName);
    const node = await getNode(id, account);
    if (!node) throw new DriveError("Not found", "not_found");
    if (!node.rights.mayRename) throw new DriveError("Not allowed", "forbidden");
    const siblings = await listChildren(node.parentId, account).catch(() => []);
    if (siblings.some((s) => s.id !== id && s.name.toLowerCase() === n.toLowerCase())) {
      throw new DriveError("Name taken", "exists");
    }
    await updateNode(id, { name: n }, account);
  });
}

export async function moveAction(nodeIds: unknown, target: unknown, accountId?: unknown) {
  return run(async () => moveNodes(ids(nodeIds), parent(target), await acct(accountId)));
}

/** Moves to the trash folder when the account has one (and the items aren't already there); else destroys. */
export async function deleteAction(nodeIds: unknown, permanent: unknown, accountId?: unknown) {
  return run(async () => {
    const list = ids(nodeIds);
    const account = await acct(accountId);
    const trashId = await getTrashId(account);
    if (trashId && permanent !== true) {
      await moveNodes(list, trashId, account);
      return "trashed" as const;
    }
    await destroyNodes(list, account);
    return "destroyed" as const;
  });
}

export async function folderTreeAction(accountId?: unknown) {
  return run<{ rootId: string | null; folders: FolderEntry[] }>(async () => listFolders(await acct(accountId)), false);
}

/**
 * Creates (or reuses) the folder chains for a folder upload. `paths` are relative folder paths
 * like "Photos/2024"; returns a map path → folder id.
 */
export async function ensureFoldersAction(parentId: unknown, paths: unknown, accountId?: unknown) {
  return run(async () => {
    const base = parent(parentId);
    const account = await acct(accountId);
    if (!Array.isArray(paths) || paths.length > MAX_BATCH) throw new DriveError("Invalid paths", "invalid");
    const clean = paths.map((p) => {
      if (typeof p !== "string" || p.length > 4096) throw new DriveError("Invalid path", "invalid");
      return p.split("/").filter(Boolean).map(name);
    });
    const [all, rootId] = await Promise.all([getAllNodes(account).catch(() => []), getRootId(account)]);
    const out: Record<string, string> = {};
    // Shortest paths first so parents exist before children.
    for (const segs of clean.sort((a, b) => a.length - b.length)) {
      let current = base;
      for (let i = 0; i < segs.length; i++) {
        const key = segs.slice(0, i + 1).join("/");
        if (out[key]) {
          current = out[key];
          continue;
        }
        const existing = all.find(
          (n) => n.isFolder && (n.parentId ?? null) === (current ?? rootId) && n.name.toLowerCase() === segs[i].toLowerCase(),
        );
        const id = existing?.id ?? (await createFolder(current, segs[i], account)).id;
        out[key] = id;
        current = id;
      }
    }
    return out;
  });
}

const BLANK: Record<string, { name: string; type: string }> = {
  document: { name: "Untitled document.odt", type: "application/vnd.oasis.opendocument.text" },
  spreadsheet: { name: "Untitled spreadsheet.ods", type: "application/vnd.oasis.opendocument.spreadsheet" },
  presentation: { name: "Untitled presentation.odp", type: "application/vnd.oasis.opendocument.presentation" },
};

/** Creates an empty office file (zero-byte placeholder) and returns its id for /docs/edit/<id>. */
export async function newDocAction(parentId: unknown, kind: unknown) {
  return run(async () => {
    const spec = typeof kind === "string" ? BLANK[kind] : undefined;
    if (!spec) throw new DriveError("Invalid kind", "invalid");
    const p = parent(parentId);
    const blob = await uploadStream(new ArrayBuffer(0), spec.type);
    const node = await createFile(p, spec.name, { ...blob, type: spec.type });
    return node.id;
  });
}

/* --------------------------------------------------------------- sharing */

export type SharingData = {
  supported: boolean;
  canShare: boolean;
  grants: Grant[];
  /** People and groups to pick from; null when the server doesn't expose principals. */
  principals: PrincipalOption[] | null;
};

/** Current grants of a node plus the principal directory for the picker. */
export async function sharingAction(id: unknown, accountId?: unknown) {
  return run<SharingData>(async () => {
    if (!validId(id)) throw new DriveError("Invalid id", "invalid");
    const account = await acct(accountId);
    const [sharing, principals, session] = await Promise.all([getSharing(id, account), listPrincipals(), getDriveSession()]);
    if (!sharing.supported) return { supported: false, canShare: false, grants: [], principals: null };
    const known = new Map((principals ?? []).map((p) => [p.id, p]));
    const missing = Object.keys(sharing.shareWith).filter((pid) => !known.has(pid));
    for (const p of await getPrincipals(missing)) known.set(p.id, p);
    const grants: Grant[] = Object.entries(sharing.shareWith)
      .map(([pid, rights]) => {
        const role = roleOf(rights);
        const p = known.get(pid);
        return role ? { principalId: pid, name: p?.name ?? pid, email: p?.email ?? null, type: p?.type ?? ("unknown" as const), role } : null;
      })
      .filter((g): g is Grant => !!g);
    const self = session?.selfPrincipalId;
    return {
      supported: true,
      canShare: sharing.node?.rights.mayShare ?? false,
      grants,
      principals: principals
        ? principals.filter((p) => p.id !== self).map(({ id, name, email, type }) => ({ id, name, email, type }))
        : null,
    };
  }, false);
}

const ROLES = new Set<ShareRole>(["viewer", "editor", "manager"]);

/** Grants `role` to a principal on a node, or revokes access with role null. */
export async function shareAction(id: unknown, principalId: unknown, role: unknown, accountId?: unknown) {
  return run(async () => {
    if (!validId(id) || !validId(principalId)) throw new DriveError("Invalid id", "invalid");
    if (role !== null && !ROLES.has(role as ShareRole)) throw new DriveError("Invalid role", "invalid");
    const account = await acct(accountId);
    const session = await getDriveSession();
    if (session?.selfPrincipalId && principalId === session.selfPrincipalId) throw new DriveError("Self", "invalid");
    await setShare(id, principalId, role === null ? null : ROLE_RIGHTS[role as ShareRole], account);
  });
}

/* -------------------------------------------------------------- defaults */

const DEFAULT_FOLDERS: Record<string, string[]> = {
  en: ["Documents", "Pictures", "Shared"],
  es: ["Documentos", "Imágenes", "Compartido"],
};

/**
 * First visit: creates the default folders when My Drive is completely empty (nothing at the
 * root nor in the trash) and the init cookie is absent. Always sets the cookie, so folders the
 * user deletes later are never re-created. Returns whether anything was created.
 */
export async function initDefaultsAction() {
  return run(async () => {
    const jar = await cookies();
    if (jar.get(INIT_COOKIE)) return false;
    jar.set(INIT_COOKIE, "1", { path: "/", maxAge: 60 * 60 * 24 * 365 * 5, sameSite: "lax" });
    const all = await getAllNodes();
    if (all.some((n) => n.role == null)) return false;
    const names = DEFAULT_FOLDERS[(await getLocale()).slice(0, 2)] ?? DEFAULT_FOLDERS.en;
    for (const n of names) await createFolder(null, n);
    return true;
  });
}
