// Server-side state of Zentico UI, in dashboard.sqlite (tables created by src/lib/dashboard/store.ts):
// the last valid compiled UI and its files (so every app can read the rail/keys without Drive),
// undo snapshots, per-mod permission grants and key/value storage, the workspace gallery, and which
// Claude requests came from which mod. Server-only; every query is scoped by the user's email
// (except the gallery, which is shared by the whole workspace).
import { randomBytes } from "node:crypto";
import { dashboardDb, type DashboardRow } from "../dashboard/store";
import { isMcpScopeKey, isPermission, type CompiledUi, type ModGrant, type UiError } from "./schema";

const norm = (email: string) => email.trim().toLowerCase();
const s = (v: unknown) => (v == null ? "" : String(v));
const db = dashboardDb;

function parse<T>(text: unknown, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ state */

export type UiStateRow = {
  folderId: string | null;
  sig: string;
  validSig: string;
  compiled: CompiledUi | null;
  files: Record<string, string> | null;
  errors: UiError[];
  updated: number;
};

export function getUiState(email: string): UiStateRow | null {
  const r = db().prepare("SELECT * FROM ui_state WHERE user_email = ?").get(norm(email));
  if (!r) return null;
  return {
    folderId: r.folder_id == null ? null : s(r.folder_id),
    sig: s(r.sig),
    validSig: s(r.valid_sig),
    compiled: parse<CompiledUi | null>(r.compiled, null),
    files: parse<Record<string, string> | null>(r.files, null),
    errors: parse<UiError[]>(r.errors, []),
    updated: Number(r.updated),
  };
}

export function saveUiState(email: string, patch: Partial<UiStateRow>): void {
  const cur = getUiState(email);
  const next = { folderId: null, sig: "", validSig: "", compiled: null, files: null, errors: [], ...cur, ...patch, updated: Date.now() } as UiStateRow;
  db()
    .prepare(
      `INSERT INTO ui_state (user_email, folder_id, sig, valid_sig, compiled, files, errors, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email) DO UPDATE SET folder_id = excluded.folder_id, sig = excluded.sig, valid_sig = excluded.valid_sig,
         compiled = excluded.compiled, files = excluded.files, errors = excluded.errors, updated = excluded.updated`,
    )
    .run(
      norm(email),
      next.folderId,
      next.sig,
      next.validSig,
      next.compiled ? JSON.stringify(next.compiled) : null,
      next.files ? JSON.stringify(next.files) : null,
      JSON.stringify(next.errors),
      next.updated,
    );
}

/* ---------------------------------------------------------------- history */

export const HISTORY_KEPT = 20;

export function pushHistory(email: string, files: Record<string, string>, reason: string): void {
  const key = norm(email);
  const d = db();
  d.prepare("INSERT INTO ui_history (user_email, files, reason, created) VALUES (?, ?, ?, ?)").run(key, JSON.stringify(files), reason.slice(0, 100), Date.now());
  d.prepare("DELETE FROM ui_history WHERE user_email = ? AND id NOT IN (SELECT id FROM ui_history WHERE user_email = ? ORDER BY id DESC LIMIT ?)").run(key, key, HISTORY_KEPT);
}

export function popHistory(email: string): Record<string, string> | null {
  const key = norm(email);
  const r = db().prepare("SELECT id, files FROM ui_history WHERE user_email = ? ORDER BY id DESC LIMIT 1").get(key);
  if (!r) return null;
  db().prepare("DELETE FROM ui_history WHERE id = ?").run(Number(r.id));
  return parse<Record<string, string> | null>(r.files, null);
}

export const historyCount = (email: string) => Number(db().prepare("SELECT COUNT(*) AS n FROM ui_history WHERE user_email = ?").get(norm(email))?.n ?? 0);

/* ----------------------------------------------------------------- grants */

const cleanGrants = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x) => isPermission(x) || isMcpScopeKey(x)))] : []);

export function listGrants(email: string): Record<string, ModGrant> {
  const out: Record<string, ModGrant> = {};
  for (const r of db().prepare("SELECT * FROM ui_grants WHERE user_email = ?").all(norm(email))) {
    out[s(r.mod_id)] = { perms: cleanGrants(parse(r.perms, [])), always: parse<string[]>(r.always, []).filter((a) => typeof a === "string") };
  }
  return out;
}

export function setGrant(email: string, modId: string, grant: ModGrant): void {
  db()
    .prepare(
      `INSERT INTO ui_grants (user_email, mod_id, perms, always, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_email, mod_id) DO UPDATE SET perms = excluded.perms, always = excluded.always, updated = excluded.updated`,
    )
    .run(norm(email), modId, JSON.stringify(cleanGrants(grant.perms)), JSON.stringify([...new Set(grant.always)].slice(0, 50)), Date.now());
}

export function revokeGrant(email: string, modId: string): void {
  db().prepare("DELETE FROM ui_grants WHERE user_email = ? AND mod_id = ?").run(norm(email), modId);
}

/* ---------------------------------------------------------------- storage */

export const STORAGE_KEY_MAX = 100;
export const STORAGE_VALUE_MAX = 64 * 1024;
export const STORAGE_MOD_MAX = 512 * 1024;
export const STORAGE_KEYS_MAX = 500;

export class StorageError extends Error {}

export function storageGet(email: string, modId: string, key: string): unknown {
  const r = db().prepare("SELECT value FROM ui_storage WHERE user_email = ? AND mod_id = ? AND key = ?").get(norm(email), modId, key);
  return r ? parse(r.value, null) : null;
}

export function storageKeys(email: string, modId: string): string[] {
  return db()
    .prepare("SELECT key FROM ui_storage WHERE user_email = ? AND mod_id = ? ORDER BY key")
    .all(norm(email), modId)
    .map((r: DashboardRow) => s(r.key));
}

export function storageSet(email: string, modId: string, key: string, value: unknown): void {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json);
  if (bytes > STORAGE_VALUE_MAX) throw new StorageError(`Value is larger than ${STORAGE_VALUE_MAX / 1024} KB`);
  const k = norm(email);
  const d = db();
  const totals = d
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS b FROM ui_storage WHERE user_email = ? AND mod_id = ? AND key != ?")
    .get(k, modId, key);
  if (Number(totals?.n ?? 0) >= STORAGE_KEYS_MAX) throw new StorageError(`A mod can store at most ${STORAGE_KEYS_MAX} keys`);
  if (Number(totals?.b ?? 0) + bytes > STORAGE_MOD_MAX) throw new StorageError(`A mod can store at most ${STORAGE_MOD_MAX / 1024} KB`);
  d.prepare(
    `INSERT INTO ui_storage (user_email, mod_id, key, value, updated) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_email, mod_id, key) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
  ).run(k, modId, key, json, Date.now());
}

export function storageRemove(email: string, modId: string, key: string): void {
  db().prepare("DELETE FROM ui_storage WHERE user_email = ? AND mod_id = ? AND key = ?").run(norm(email), modId, key);
}

/* ---------------------------------------------------------------- gallery */

export type GalleryKind = "page" | "mod";
export type GalleryPayload = { page?: Record<string, unknown>; mods: Record<string, Record<string, string>> };
export type GalleryItem = {
  id: string;
  kind: GalleryKind;
  name: string;
  description: string;
  icon: string | null;
  author: { email: string; name: string };
  /** Permissions and MCP scope keys its mods request. */
  permissions: string[];
  installs: number;
  created: number;
};

const toItem = (r: DashboardRow): GalleryItem => ({
  id: s(r.id),
  kind: s(r.kind) === "mod" ? "mod" : "page",
  name: s(r.name),
  description: s(r.description),
  icon: r.icon == null ? null : s(r.icon),
  author: { email: s(r.author_email), name: s(r.author_name) },
  permissions: cleanGrants(parse(r.permissions, [])),
  installs: Number(r.installs ?? 0),
  created: Number(r.created),
});

export const GALLERY_MAX = 500;

export function listGallery(limit = 200): GalleryItem[] {
  return db().prepare("SELECT id, kind, name, description, icon, author_email, author_name, permissions, installs, created FROM ui_gallery ORDER BY created DESC LIMIT ?").all(limit).map(toItem);
}

export function getGalleryItem(id: string): (GalleryItem & { payload: GalleryPayload }) | null {
  const r = db().prepare("SELECT * FROM ui_gallery WHERE id = ?").get(id);
  if (!r) return null;
  return { ...toItem(r), payload: parse<GalleryPayload>(r.payload, { mods: {} }) };
}

export function addGalleryItem(input: Omit<GalleryItem, "id" | "installs" | "created"> & { payload: GalleryPayload }): GalleryItem {
  const count = Number(db().prepare("SELECT COUNT(*) AS n FROM ui_gallery").get()?.n ?? 0);
  if (count >= GALLERY_MAX) throw new StorageError("The gallery is full");
  const id = `g_${randomBytes(8).toString("hex")}`;
  const now = Date.now();
  db()
    .prepare(
      "INSERT INTO ui_gallery (id, kind, name, description, icon, author_email, author_name, payload, permissions, installs, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .run(id, input.kind, input.name, input.description, input.icon, norm(input.author.email), input.author.name, JSON.stringify(input.payload), JSON.stringify(input.permissions), now);
  return { ...input, id, installs: 0, created: now };
}

export function countInstall(id: string): void {
  db().prepare("UPDATE ui_gallery SET installs = installs + 1 WHERE id = ?").run(id);
}

/** Removes a gallery item; only its author may. */
export function removeGalleryItem(id: string, email: string): boolean {
  return Number(db().prepare("DELETE FROM ui_gallery WHERE id = ? AND author_email = ?").run(id, norm(email)).changes) > 0;
}

/* ----------------------------------------------------------- mod requests */

export function recordModAsk(email: string, commandId: string, modId: string, modName: string): void {
  const d = db();
  d.prepare("INSERT OR REPLACE INTO ui_mod_asks (command_id, user_email, mod_id, mod_name, created) VALUES (?, ?, ?, ?, ?)").run(commandId, norm(email), modId, modName, Date.now());
  d.prepare("DELETE FROM ui_mod_asks WHERE created < ?").run(Date.now() - 7 * 24 * 3600_000);
}

export function modAskOf(email: string, commandId: string): { modId: string; modName: string } | null {
  const r = db().prepare("SELECT mod_id, mod_name FROM ui_mod_asks WHERE command_id = ? AND user_email = ?").get(commandId, norm(email));
  return r ? { modId: s(r.mod_id), modName: s(r.mod_name) } : null;
}
