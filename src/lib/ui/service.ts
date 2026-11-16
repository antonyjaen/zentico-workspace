// Zentico UI service: keeps the user's `Zentico UI/` files (Drive) and what their dashboards render
// in sync. syncUi() reads the folder, validates it with checkUi() and, when valid, stores it as the
// new UI (the previous valid files become an undo snapshot); invalid files keep the last valid UI
// and record the errors. Every change is published to the user's open dashboards. Writes made
// through the app (dashboard edits, ui_* tools, templates, gallery installs) go through
// writeUiFiles(), which re-syncs right away; edits made elsewhere (drive_* tools, the Drive app)
// are picked up when an open dashboard polls. Server-only; runs with the current session.
import { legacyDashboard, publish } from "../dashboard/store";
import type { Session } from "../session";
import { createUiFolder, findUiFolder, readTexts, readTree, treeSignature, writeTexts, type UiTree } from "./files";
import { buildGuide, guideVersionOf, GUIDE_VERSION } from "./guide";
import {
  applyPointerOps,
  checkUi,
  GUIDE_FILE,
  isContainer,
  KEYS_FILE,
  MOD_ID,
  PAGE_ID,
  requestedGrants,
  shellApps,
  THEME_FILE,
  UI_FILE,
  walk,
  type CheckResult,
  type PointerOp,
  type UiError,
  type UiShell,
  type UiView,
} from "./schema";
import { assertBuiltinsValid, defaultFiles, migratedFiles, modFiles, pretty, RECOMMENDED_MODS, templateById } from "./starter";
import { getUiState, historyCount, listGrants, popHistory, pushHistory, saveUiState, setGrant, type UiStateRow } from "./store";

export class UiServiceError extends Error {
  constructor(
    message: string,
    public code: "conflict" | "invalid" | "has_errors" | "not_found" | "unavailable" = "invalid",
    public errors: UiError[] = [],
  ) {
    super(message);
  }
}

const g = globalThis as typeof globalThis & { __zwUiChecked?: boolean; __zwUiSync?: Map<string, Promise<UiView>> };
if (!g.__zwUiChecked) {
  g.__zwUiChecked = true;
  // A broken built-in (default files, templates) must fail loudly, not ship silently.
  assertBuiltinsValid();
}
const inflight = (g.__zwUiSync ??= new Map());
const norm = (email: string) => email.trim().toLowerCase();

/* ------------------------------------------------------------------- view */

export function viewOf(email: string, row: UiStateRow | null = getUiState(email)): UiView {
  return {
    ui: row?.compiled ?? null,
    errors: row?.errors ?? [],
    sig: row?.sig ?? "",
    folderId: row?.folderId ?? null,
    grants: listGrants(email),
    undo: historyCount(email),
    updated: row?.updated ?? 0,
  };
}

/** Rail pages and key bindings from the stored state (no Drive call). */
export function shellOf(email: string): UiShell {
  const ui = getUiState(email)?.compiled;
  return {
    pages: (ui?.pages ?? []).map((p) => ({ id: p.id, title: p.title, icon: p.icon, pinned: p.pinned })),
    apps: shellApps(ui ?? null),
    keys: ui?.keys ?? [],
  };
}

/* ------------------------------------------------------------------- sync */

async function ensureFolder(email: string, locale: string): Promise<UiTree> {
  const row = getUiState(email);
  let folder = await findUiFolder(row?.folderId ?? null);
  let fresh = false;
  if (!folder) {
    folder = await createUiFolder();
    fresh = true;
  }
  if (row?.folderId !== folder.id) saveUiState(email, { folderId: folder.id });
  let tree = await readTree(folder.id);
  const has = (p: string) => tree.files.some((f) => f.path === p);
  const seed: Record<string, string> = {};
  if (fresh || !has(UI_FILE)) {
    // First use (or ui.json deleted): migrate a classic dashboard once, else the starter files.
    const legacy = row?.compiled ? null : legacyDashboard(email);
    const files = legacy ? migratedFiles(legacy, locale) : defaultFiles(locale);
    if (!has(UI_FILE)) seed[UI_FILE] = files[UI_FILE];
    if (!has(THEME_FILE) && fresh) seed[THEME_FILE] = files[THEME_FILE];
    if (!has(KEYS_FILE) && fresh) seed[KEYS_FILE] = files[KEYS_FILE];
    if (fresh) for (const [p, t] of Object.entries(files)) if (p.startsWith("mods/") && !has(p)) seed[p] = t;
  }
  const guide = tree.files.find((f) => f.path === GUIDE_FILE);
  if (!guide) seed[GUIDE_FILE] = buildGuide();
  else {
    const text = (await readTexts({ ...tree, files: [guide] }))[GUIDE_FILE] ?? "";
    if (guideVersionOf(text) < GUIDE_VERSION) seed[GUIDE_FILE] = buildGuide();
  }
  if (Object.keys(seed).length) {
    await writeTexts(tree, seed);
    tree = await readTree(folder.id);
  }
  return tree;
}

/** Texts that make up the UI (AGENTS.md is documentation, not validated). */
const uiTexts = (texts: Record<string, string>) => Object.fromEntries(Object.entries(texts).filter(([p]) => p !== GUIDE_FILE));

async function doSync(session: Session, opts: { force?: boolean; locale?: string; reason?: string; skipHistory?: boolean }): Promise<UiView> {
  const email = session.email;
  const tree = await ensureFolder(email, opts.locale ?? "es");
  const sig = treeSignature(tree);
  const row = getUiState(email);
  if (!opts.force && row && row.sig === sig && row.compiled) return viewOf(email, row);
  const texts = uiTexts(await readTexts(tree));
  const check = checkUi(texts);
  if (check.ok && check.ui) {
    if (row?.files && row.validSig && row.validSig !== sig && !opts.skipHistory) pushHistory(email, row.files, opts.reason ?? "change");
    saveUiState(email, { folderId: tree.folderId, sig, validSig: sig, compiled: check.ui, files: texts, errors: [] });
  } else {
    // Keep the last valid UI; with none yet (e.g. ui.json broken before the first sync), show what compiled.
    saveUiState(email, { folderId: tree.folderId, sig, errors: check.errors, ...(row?.compiled ? {} : { compiled: check.ui }) });
  }
  const changed = !row || row.sig !== sig || JSON.stringify(row.errors) !== JSON.stringify(check.errors);
  if (changed) publish(email, { type: "ui" });
  return viewOf(email);
}

/**
 * Syncs the user's UI with their Drive folder (creating it on first use). Without `force`, an
 * unchanged folder costs a few listing calls and no reads. Concurrent calls share one run.
 */
export function syncUi(session: Session, opts: { force?: boolean; locale?: string; reason?: string; skipHistory?: boolean } = {}): Promise<UiView> {
  const key = `${norm(session.email)}:${opts.force ? 1 : 0}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = doSync(session, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Current files of the folder (fresh from Drive, invalid ones included). */
export async function readUiFiles(session: Session, locale?: string) {
  const tree = await ensureFolder(session.email, locale ?? "es");
  const texts = await readTexts(tree);
  return { folderId: tree.folderId, files: tree.files.map((f) => ({ path: f.path, size: f.node.size, modified: f.node.modified })), texts };
}

/* ------------------------------------------------------------------ write */

/** Writes files (path → text, null = delete) and re-syncs. Returns the check of the new files. */
export async function writeUiFiles(
  session: Session,
  changes: Record<string, string | null>,
  opts: { reason: string; locale?: string; skipHistory?: boolean },
): Promise<{ view: UiView; check: CheckResult; written: string[] }> {
  const tree = await ensureFolder(session.email, opts.locale ?? "es");
  const written = await writeTexts(tree, changes);
  const view = await syncUi(session, { force: true, locale: opts.locale, reason: opts.reason, skipHistory: opts.skipHistory });
  const row = getUiState(session.email);
  const check: CheckResult = { ok: view.errors.length === 0, errors: view.errors, ui: row?.compiled ?? null };
  return { view, check, written };
}

/** The current (valid) files, refusing to edit on top of a broken UI or a stale view. */
async function currentFiles(session: Session, baseSig: string | null, locale?: string): Promise<Record<string, string>> {
  const view = await syncUi(session, { locale });
  if (view.errors.length) throw new UiServiceError("The UI files have errors; fix them first.", "has_errors", view.errors);
  if (baseSig && baseSig !== view.sig) throw new UiServiceError("The UI changed meanwhile; reload and try again.", "conflict");
  const files = getUiState(session.email)?.files;
  if (!files) throw new UiServiceError("The UI is not available yet", "unavailable");
  return files;
}

/** Validates a candidate file set before writing it (UI-made edits must never break the UI). */
function mustBeValid(files: Record<string, string>) {
  const check = checkUi(files);
  if (!check.ok) throw new UiServiceError("That change would make the UI invalid", "invalid", check.errors);
}

/** Edits ui.json by JSON pointer (dividers, grid moves, props pickers, add/remove blocks…). */
export async function patchUi(session: Session, baseSig: string | null, ops: PointerOp[], locale?: string): Promise<UiView> {
  const files = await currentFiles(session, baseSig, locale);
  let next: unknown;
  try {
    next = applyPointerOps(JSON.parse(files[UI_FILE]), ops);
  } catch (e) {
    throw new UiServiceError(e instanceof Error ? e.message : "Invalid edit");
  }
  const text = pretty(next);
  mustBeValid({ ...files, [UI_FILE]: text });
  return (await writeUiFiles(session, { [UI_FILE]: text }, { reason: "edit", locale })).view;
}

/** Restores the previous valid version of the files. Null when there is nothing to undo. */
export async function undoUi(session: Session, locale?: string): Promise<UiView | null> {
  await syncUi(session, { locale });
  const snapshot = popHistory(session.email);
  if (!snapshot) return null;
  const current = getUiState(session.email)?.files ?? {};
  const changes: Record<string, string | null> = {};
  for (const [p, t] of Object.entries(snapshot)) if (current[p] !== t) changes[p] = t;
  for (const p of Object.keys(current)) if (!(p in snapshot)) changes[p] = null;
  if (!Object.keys(changes).length) return viewOf(session.email);
  return (await writeUiFiles(session, changes, { reason: "undo", locale, skipHistory: true })).view;
}

/** Back to the default ui.json / theme.json / keys.json (mods are kept; undoable). */
export async function resetUi(session: Session, locale = "es"): Promise<UiView> {
  await syncUi(session, { locale });
  const files = defaultFiles(locale);
  const current = getUiState(session.email)?.files ?? {};
  const changes: Record<string, string> = { [UI_FILE]: files[UI_FILE], [THEME_FILE]: files[THEME_FILE], [KEYS_FILE]: files[KEYS_FILE] };
  for (const [p, t] of Object.entries(files)) if (p.startsWith("mods/") && !(p in current)) changes[p] = t;
  return (await writeUiFiles(session, changes, { reason: "reset", locale })).view;
}

/* ------------------------------------------------------- pages from outside */

type Raw = Record<string, unknown>;

const uniqueId = (base: string, taken: Set<string>, re: RegExp, max: number) => {
  let id = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max - 3) || "page";
  if (!re.test(id)) id = `p-${id}`.slice(0, max);
  if (!taken.has(id)) return id;
  for (let i = 2; i < 100; i++) if (!taken.has(`${id}-${i}`)) return `${id}-${i}`;
  return `${id}-${Date.now().toString(36)}`;
};

/** Mod files of `id` in a file set. */
const filesOfMod = (files: Record<string, string>, id: string) =>
  Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(`mods/${id}/`)).map(([p, t]) => [p.slice(`mods/${id}/`.length), t]));

/**
 * Adds a page (from a template or the gallery) plus the mods it needs. Never overwrites a page or
 * a different mod with the same id: the page gets a fresh id, a clashing mod is installed under a
 * new id and the page's references are rewritten. Returns the new page id and the installed mods.
 */
export async function addPage(
  session: Session,
  page: Raw,
  mods: Record<string, Record<string, string>>,
  opts: { reason: string; locale?: string; grantMods?: boolean },
): Promise<{ view: UiView; pageId: string; mods: string[] }> {
  const files = await currentFiles(session, null, opts.locale);
  const ui = JSON.parse(files[UI_FILE]) as { pages: Raw[] };
  const pages = Array.isArray(ui.pages) ? ui.pages : [];
  const changes: Record<string, string> = {};
  const rename = new Map<string, string>();
  const existingMods = new Set(Object.keys(files).filter((p) => p.startsWith("mods/")).map((p) => p.split("/")[1]));
  for (const [id, modTexts] of Object.entries(mods)) {
    if (!MOD_ID.test(id)) throw new UiServiceError(`Invalid mod id "${id}"`);
    let target = id;
    if (existingMods.has(id)) {
      const theirs = filesOfMod(files, id);
      // Already installed with the same files: reuse it.
      if (Object.entries(modTexts).every(([n, t]) => theirs[n] === t)) continue;
      target = uniqueId(id, existingMods, MOD_ID, 40);
      rename.set(id, target);
    }
    existingMods.add(target);
    for (const [name, text] of Object.entries(modTexts)) changes[`mods/${target}/${name}`] = text;
  }
  const taken = new Set(pages.map((p) => String(p.id)));
  const pageId = uniqueId(String(page.id ?? page.title ?? "page"), taken, PAGE_ID, 32);
  const copy = structuredClone(page) as Raw;
  copy.id = pageId;
  if (rename.size) {
    const fix = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      const node = n as Raw;
      if (node.type === "mod" && typeof node.mod === "string" && rename.has(node.mod)) node.mod = rename.get(node.mod);
      if (Array.isArray(node.children)) node.children.forEach(fix);
    };
    fix(copy.layout);
  }
  changes[UI_FILE] = pretty({ ...ui, pages: [...pages, copy] });
  mustBeValid({ ...files, ...changes });
  const installed = Object.keys(mods).map((id) => rename.get(id) ?? id);
  const { view } = await writeUiFiles(session, changes, { reason: opts.reason, locale: opts.locale });
  if (opts.grantMods) {
    for (const id of installed) {
      const m = view.ui?.mods[id];
      if (m) setGrant(session.email, id, { perms: requestedGrants(m), always: view.grants[id]?.always ?? [] });
    }
  }
  return { view: viewOf(session.email), pageId, mods: installed };
}

/**
 * Applies an entry of the recommended library: a layout or an app becomes a new page (with the
 * mods it needs); "mod:<id>" installs a recommended mod without placing it.
 */
export async function applyTemplate(
  session: Session,
  templateId: string,
  locale = "es",
  grantMods = false,
): Promise<{ view: UiView; pageId: string | null; mods: string[] }> {
  if (templateId.startsWith("mod:")) {
    const id = templateId.slice(4);
    if (!RECOMMENDED_MODS.some((m) => m.id === id)) throw new UiServiceError(`Unknown mod "${id}"`, "not_found");
    const texts = Object.fromEntries(Object.entries(modFiles([id])).map(([p, t]) => [p.slice(`mods/${id}/`.length), t]));
    const files = await currentFiles(session, null, locale);
    const theirs = filesOfMod(files, id);
    if (Object.keys(theirs).length && Object.entries(texts).every(([n, t]) => theirs[n] === t)) {
      const view = viewOf(session.email);
      const m = view.ui?.mods[id];
      if (grantMods && m) setGrant(session.email, id, { perms: requestedGrants(m), always: view.grants[id]?.always ?? [] });
      return { view: viewOf(session.email), pageId: null, mods: [id] };
    }
    const r = await addMod(session, id, texts, { locale, grant: grantMods });
    return { view: r.view, pageId: null, mods: [r.modId] };
  }
  const t = templateById(templateId);
  if (!t) throw new UiServiceError(`Unknown template "${templateId}"`, "not_found");
  const l = locale === "en" ? "en" : "es";
  const mods: Record<string, Record<string, string>> = {};
  for (const [p, text] of Object.entries(modFiles(t.mods))) {
    const [, id, name] = p.split("/");
    (mods[id] ??= {})[name] = text;
  }
  return addPage(session, { id: t.id, ...t.page(l) }, mods, { reason: `template ${t.id}`, locale, grantMods });
}

/** Installs a standalone mod (gallery) without placing it. */
export async function addMod(session: Session, id: string, modTexts: Record<string, string>, opts: { locale?: string; grant?: boolean }) {
  const files = await currentFiles(session, null, opts.locale);
  const existing = new Set(Object.keys(files).filter((p) => p.startsWith("mods/")).map((p) => p.split("/")[1]));
  const target = existing.has(id) ? uniqueId(id, existing, MOD_ID, 40) : id;
  const changes: Record<string, string> = {};
  for (const [name, text] of Object.entries(modTexts)) changes[`mods/${target}/${name}`] = text;
  mustBeValid({ ...files, ...changes });
  const { view } = await writeUiFiles(session, changes, { reason: `install ${target}`, locale: opts.locale });
  const m = view.ui?.mods[target];
  if (opts.grant && m) setGrant(session.email, target, { perms: requestedGrants(m), always: [] });
  return { view: viewOf(session.email), modId: target };
}

/** Turns a page into its own rail app (or updates its app settings); `null` turns it back into a page. */
export async function makeApp(
  session: Session,
  pageId: string,
  app: { name?: string; icon?: string; color?: string; path?: string; hidden?: boolean; order?: number } | null,
  locale?: string,
): Promise<UiView> {
  const files = await currentFiles(session, null, locale);
  const ui = JSON.parse(files[UI_FILE]) as { pages: Raw[] };
  const i = (ui.pages ?? []).findIndex((p) => p.id === pageId);
  if (i < 0) throw new UiServiceError(`No page "${pageId}"`, "not_found");
  const page = ui.pages[i];
  const current = (page.app && typeof page.app === "object" ? page.app : {}) as Raw;
  const value = app === null ? undefined : { ...current, ...Object.fromEntries(Object.entries(app).filter(([, v]) => v !== undefined)) };
  if (value && !value.name) value.name = String(page.title ?? pageId).slice(0, 24);
  return patchUi(session, null, [value === undefined ? { op: "remove", pointer: `/pages/${i}/app` } : { op: "set", pointer: `/pages/${i}/app`, value }], locale);
}

/** Raw page JSON and the files of the mods it uses (for publishing to the gallery). */
export async function exportPage(session: Session, pageId: string) {
  const files = await currentFiles(session, null);
  const ui = JSON.parse(files[UI_FILE]) as { pages: Raw[] };
  const page = ui.pages.find((p) => p.id === pageId);
  if (!page) throw new UiServiceError(`No page "${pageId}"`, "not_found");
  const compiled = getUiState(session.email)?.compiled?.pages.find((p) => p.id === pageId);
  const used = new Set<string>();
  if (compiled) walk(compiled.layout, (n) => n.type === "mod" && used.add(n.mod));
  const mods: Record<string, Record<string, string>> = {};
  for (const id of used) mods[id] = filesOfMod(files, id);
  return { page: { ...page, pinned: undefined } as Raw, mods };
}

export async function exportMod(session: Session, modId: string) {
  const files = await currentFiles(session, null);
  const mod = filesOfMod(files, modId);
  if (!Object.keys(mod).length) throw new UiServiceError(`No mod "${modId}"`, "not_found");
  return mod;
}

/** Ids of every node in the compiled UI (for tools that address nodes by id). */
export function nodeIndex(email: string) {
  const ui = getUiState(email)?.compiled;
  const out = new Map<string, { pageId: string; ptr: string; container: boolean }>();
  for (const p of ui?.pages ?? []) walk(p.layout, (n) => n.id && out.set(n.id, { pageId: p.id, ptr: n.ptr, container: isContainer(n) }));
  return out;
}

export { pretty };
