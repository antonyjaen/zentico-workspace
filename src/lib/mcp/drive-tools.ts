// Drive and Docs tools: browse, read, write and edit files, manage folders, sharing and trash,
// create Docs documents and work with Excalidraw whiteboards. Every call runs with the user's
// own JMAP rights; accountId selects a shared space (omit for My Drive).
import { toDocs } from "@/app/(apps)/docs/list";
import { NATIVE, nativeKind, openHref } from "@/app/(apps)/docs/shared";
import { requireSession } from "../auth";
import {
  createFile,
  createFolder,
  destroyNodes,
  DriveError,
  fetchBlob,
  getAllNodes,
  getDriveAccounts,
  getDriveSession,
  getNode,
  getPath,
  getPrincipals as getPrincipalsById,
  getRootId,
  getSharing,
  getTrashId,
  descendantsOf,
  listChildren,
  listPrincipals,
  MAX_UPLOAD_BYTES,
  moveNodes,
  replaceContent,
  resolveAccount,
  RIGHT_KEYS,
  ROLE_RIGHTS,
  roleOf,
  searchNodes,
  setShare,
  updateNode,
  uploadStream,
  validName,
  type DriveNode,
  type PrincipalEntry,
  type ShareRole,
} from "../drive";
import { convertWithCollabora, docKind, MAX_CONVERT_BYTES, NEW_DOC } from "../wopi";
import { bool, id, idList, int, oneOf, str, strList, ToolError, type Args } from "./args";
import { extOf, extractText, isTextLike, readCapped, toArrayBuffer } from "./convert";
import { A, appUrl, B, fold, I, page, personName, S, type JsonSchema, type Tool } from "./kit";
import { markdownToHtml } from "./text";

/* ------------------------------------------------------------------ helpers */

const WRITE_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
};
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_TOOL_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  ics: "text/calendar",
  vcf: "text/vcard",
  excalidraw: NATIVE.whiteboard.mediaType,
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  rtf: "application/rtf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
};
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const mimeFor = (name: string) => MIME_BY_EXT[extOf(name)] ?? "application/octet-stream";

/** Link that opens a node for the user: Docs editors for their own documents, else Drive. */
function fileUrl(n: DriveNode, primary = true): string {
  const acct = primary ? "" : `account=${encodeURIComponent(n.accountId)}`;
  if (n.isFolder) return `${appUrl()}/drive?${acct ? `${acct}&` : ""}folder=${encodeURIComponent(n.id)}`;
  if (primary && (nativeKind(n.name) || docKind(n.name))) return `${appUrl()}${openHref(n.id, n.name)}`;
  return `${appUrl()}/api/drive/file/${encodeURIComponent(n.id)}${acct ? `?${acct}` : ""}`;
}

const compactNode = (n: DriveNode, primary = true) => ({
  id: n.id,
  name: n.name,
  folder: n.isFolder || undefined,
  type: n.isFolder ? undefined : n.type || undefined,
  size: n.isFolder ? undefined : n.size,
  modified: n.modified ?? undefined,
  parentId: n.parentId ?? undefined,
  accountId: primary ? undefined : n.accountId,
  readOnly: n.rights.mayModifyContent ? undefined : true,
});

/** The node or a ToolError; `kind` restricts it to a file or a folder. */
async function nodeArg(args: Args, key: string, accountId: string | undefined, kind?: "file" | "folder"): Promise<DriveNode> {
  const node = await getNode(id(args, key, { required: true }), accountId);
  if (!node) throw new ToolError(`${kind === "folder" ? "Folder" : "File"} not found`);
  if (kind === "file" && node.isFolder) throw new ToolError(`"${node.name}" is a folder`);
  if (kind === "folder" && !node.isFolder) throw new ToolError(`"${node.name}" is not a folder`);
  return node;
}

/** Validated account (null/undefined = My Drive), as its id plus whether it is the primary. */
async function accountArg(args: Args, key = "accountId"): Promise<{ accountId: string | undefined; primary: boolean }> {
  const v = id(args, key);
  if (!v) return { accountId: undefined, primary: true };
  const acc = await resolveAccount(v);
  return { accountId: acc.id, primary: acc.isPrimary };
}

/** Parent folder id from an argument (omitted, "", "root" = the root), checked to be a folder. */
async function folderArg(args: Args, key: string, accountId: string | undefined): Promise<string | null> {
  const v = id(args, key);
  if (!v || v === "root") return null;
  const folder = await getNode(v, accountId);
  if (!folder?.isFolder) throw new ToolError("Folder not found");
  if (!folder.rights.mayAddChildren) throw new ToolError(`You can't add files to "${folder.name}"`);
  return folder.id;
}

async function readNodeBytes(node: DriveNode, maxBytes: number) {
  const res = await fetchBlob(node);
  if (!res.ok) throw new ToolError(`Could not read the file (HTTP ${res.status})`);
  return readCapped(res, maxBytes);
}

const encode = (text: string) => toArrayBuffer(new TextEncoder().encode(text));

function encodeText(content: string, ext: string, max = MAX_TEXT_BYTES): ArrayBuffer {
  if (ext === "json" || ext === "excalidraw") {
    try {
      JSON.parse(content);
    } catch {
      throw new ToolError("Content is not valid JSON");
    }
  }
  const bytes = encode(content);
  if (bytes.byteLength > max) throw new ToolError(`Content is larger than ${Math.round(max / 1024 / 1024)} MB`);
  return bytes;
}

async function writeText(opts: {
  fileId?: string;
  name?: string;
  folderId?: string | null;
  content: string;
  overwrite: boolean;
  accountId?: string;
}): Promise<{ node: DriveNode; created: boolean }> {
  if (opts.fileId) {
    const node = await getNode(opts.fileId, opts.accountId);
    if (!node || node.isFolder) throw new ToolError("File not found");
    const ext = extOf(node.name);
    if (!WRITE_TYPES[ext]) throw new ToolError("Only .md, .txt and .json files can be written (use drive_upload for other files)");
    const next = await replaceContent(node.id, encodeText(opts.content, ext), WRITE_TYPES[ext], opts.accountId);
    return { node: next, created: false };
  }
  const name = validName(opts.name);
  if (!name) throw new ToolError('Provide "fileId" to overwrite, or a valid "name" to create a file');
  const ext = extOf(name);
  if (!WRITE_TYPES[ext]) throw new ToolError("The file name must end in .md, .txt or .json (use drive_upload for other files)");
  const body = encodeText(opts.content, ext);
  return storeFile({ name, folderId: opts.folderId ?? null, body, type: WRITE_TYPES[ext], overwrite: opts.overwrite, accountId: opts.accountId });
}

/** Creates a file (unique name in the folder), or replaces a same-named file when `overwrite`. */
async function storeFile(opts: {
  name: string;
  folderId: string | null;
  body: ArrayBuffer;
  type: string;
  overwrite: boolean;
  accountId?: string;
}): Promise<{ node: DriveNode; created: boolean }> {
  if (opts.folderId) {
    const folder = await getNode(opts.folderId, opts.accountId);
    if (!folder?.isFolder) throw new ToolError("Folder not found");
  }
  if (opts.overwrite) {
    const existing = (await listChildren(opts.folderId, opts.accountId)).find(
      (n) => !n.isFolder && n.name.toLowerCase() === opts.name.toLowerCase(),
    );
    if (existing) return { node: await replaceContent(existing.id, opts.body, opts.type, opts.accountId), created: false };
  }
  const blob = await uploadStream(opts.body, opts.type, null, { accountId: opts.accountId });
  const node = await createFile(opts.folderId, opts.name, { ...blob, type: opts.type }, opts.accountId);
  return { node, created: true };
}

/** Throws when the file changed since the caller read it (optimistic concurrency). */
function checkVersion(node: DriveNode, args: Args) {
  const modified = str(args, "expectedModified", { max: 64 });
  const blobId = str(args, "expectedBlobId", { max: 512 });
  if ((modified && node.modified !== modified) || (blobId && node.blobId !== blobId)) {
    throw new ToolError(
      `The file changed since you read it (now modified ${node.modified ?? "?"}, blobId ${node.blobId ?? "?"}). Read it again and redo the edit.`,
    );
  }
}

const VERSION_PROPS: Record<string, JsonSchema> = {
  expectedModified: S('Only write if the file\'s "modified" still equals this (from drive_read_text / drive_get_info).'),
  expectedBlobId: S('Only write if the file\'s "blobId" still equals this (from drive_read_text / drive_get_info).'),
};

function cleanTitle(v: string): string {
  const t = v.replace(/[\u0000-\u001f\u007f/\\]/g, " ").trim();
  if (!t || t === "." || t === "..") throw new ToolError('"title" is required');
  return t.slice(0, 200);
}

/* ------------------------------------------------------------------ sharing */

const ROLES = ["viewer", "editor", "manager"] as const;

/** Resolves "ana@x.com", "ana", "Ana García", a group name or a principal id to one principal. */
function findPrincipal(who: string, principals: PrincipalEntry[], myDomain: string): PrincipalEntry {
  const w = who.trim();
  const lw = w.toLowerCase();
  const byId = principals.find((p) => p.id === w);
  if (byId) return byId;
  const byEmail = principals.filter((p) => p.email?.toLowerCase() === lw);
  if (byEmail.length) return byEmail[0];
  const local = lw.includes("@") ? lw.slice(0, lw.indexOf("@")) : lw;
  const byLocal = principals.filter((p) => p.email && p.email.toLowerCase().slice(0, p.email.indexOf("@")) === local);
  const pick = (list: PrincipalEntry[]) =>
    list.length === 1 ? list[0] : (list.find((p) => p.email?.toLowerCase().endsWith(`@${myDomain}`)) ?? null);
  const local1 = byLocal.length ? pick(byLocal) : null;
  if (local1) return local1;
  const fw = fold(w);
  const byName = principals.filter((p) => fold(p.name) === fw || (p.email && fold(personName(p.name, p.email)) === fw));
  const name1 = byName.length ? pick(byName) : null;
  if (name1) return name1;
  if (byLocal.length + byName.length > 1) throw new ToolError(`"${who}" matches several people or groups; use their full email`);
  throw new ToolError(`No person or group "${who}" in the directory`);
}

async function grantsOf(node: DriveNode, accountId: string | undefined) {
  const sharing = await getSharing(node.id, accountId);
  if (!sharing.supported) return null;
  const principals = (await listPrincipals()) ?? [];
  const known = new Map(principals.map((p) => [p.id, p]));
  const missing = Object.keys(sharing.shareWith).filter((pid) => !known.has(pid));
  for (const p of await getPrincipalsById(missing)) known.set(p.id, p);
  return Object.entries(sharing.shareWith)
    .map(([pid, rights]) => {
      const role = roleOf(rights);
      const p = known.get(pid);
      if (!role) return null;
      return {
        principalId: pid,
        name: p ? (p.email ? personName(p.name, p.email) : p.name) : pid,
        email: p?.email ?? undefined,
        group: p?.type === "group" || undefined,
        role,
      };
    })
    .filter((g): g is NonNullable<typeof g> => !!g);
}

/* --------------------------------------------------------------------- edits */

type Edit =
  | { op: "replace"; find: string; replace: string; all: boolean; occurrence: number | null }
  | { op: "append"; text: string }
  | { op: "prepend"; text: string }
  | { op: "replace_lines"; startLine: number; endLine: number; text: string };

function parseEdits(v: unknown): Edit[] {
  if (!Array.isArray(v) || !v.length || v.length > 50) throw new ToolError('"edits" must be a list of 1–50 edits');
  return v.map((raw, i) => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Args;
    const where = `edits[${i}]`;
    const text = (key: string, required = true) => {
      const t = e[key];
      if (t == null && !required) return "";
      if (typeof t !== "string") throw new ToolError(`${where}.${key} must be a string`);
      if (t.length > MAX_EDIT_BYTES) throw new ToolError(`${where}.${key} is too long`);
      return t;
    };
    const op = String(e.op ?? "").replace("-", "_");
    if (op === "replace") {
      const find = text("find");
      if (!find) throw new ToolError(`${where}.find is empty`);
      const occurrence = e.occurrence == null ? null : Number(e.occurrence);
      if (occurrence !== null && (!Number.isInteger(occurrence) || occurrence < 1)) throw new ToolError(`${where}.occurrence must be a positive integer`);
      return { op, find, replace: text("replace", false), all: e.all === true, occurrence };
    }
    if (op === "append" || op === "prepend") return { op, text: text("text") };
    if (op === "replace_lines" || op === "replace_range") {
      const startLine = Number(e.startLine);
      const endLine = e.endLine == null ? startLine : Number(e.endLine);
      if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine - 1) {
        throw new ToolError(`${where}: startLine must be ≥ 1 and endLine ≥ startLine - 1 (endLine = startLine - 1 inserts before startLine)`);
      }
      return { op: "replace_lines", startLine, endLine, text: text("text", false) };
    }
    throw new ToolError(`${where}.op must be replace, append, prepend or replace_lines`);
  });
}

function applyEdits(content: string, edits: Edit[]): { content: string; changes: string[] } {
  let out = content;
  const changes: string[] = [];
  edits.forEach((e, i) => {
    if (e.op === "append") {
      out = out && !out.endsWith("\n") && !e.text.startsWith("\n") ? `${out}\n${e.text}` : out + e.text;
      changes.push(`#${i + 1} appended ${e.text.length} chars`);
    } else if (e.op === "prepend") {
      out = e.text + (e.text.endsWith("\n") || !out ? "" : "\n") + out;
      changes.push(`#${i + 1} prepended ${e.text.length} chars`);
    } else if (e.op === "replace") {
      const positions: number[] = [];
      for (let at = out.indexOf(e.find); at !== -1; at = out.indexOf(e.find, at + e.find.length)) positions.push(at);
      if (!positions.length) throw new ToolError(`Edit #${i + 1}: the text to find was not found (it must match exactly, including whitespace)`);
      if (e.all) {
        out = out.split(e.find).join(e.replace);
        changes.push(`#${i + 1} replaced ${positions.length} occurrence(s)`);
        return;
      }
      if (positions.length > 1 && e.occurrence === null) {
        throw new ToolError(`Edit #${i + 1}: the text appears ${positions.length} times; pass all=true, an occurrence number, or more context`);
      }
      const at = positions[(e.occurrence ?? 1) - 1];
      if (at === undefined) throw new ToolError(`Edit #${i + 1}: there are only ${positions.length} occurrence(s)`);
      out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
      changes.push(`#${i + 1} replaced 1 occurrence`);
    } else {
      const lines = out.split("\n");
      if (e.startLine > lines.length + 1) throw new ToolError(`Edit #${i + 1}: the file has only ${lines.length} lines`);
      const replacement = e.text === "" ? [] : e.text.replace(/\n$/, "").split("\n");
      const removed = Math.max(0, Math.min(e.endLine, lines.length) - e.startLine + 1);
      lines.splice(e.startLine - 1, removed, ...replacement);
      out = lines.join("\n");
      changes.push(`#${i + 1} replaced lines ${e.startLine}–${e.endLine} (${removed} removed, ${replacement.length} inserted)`);
    }
  });
  return { content: out, changes };
}

/* --------------------------------------------------------------- whiteboards */

type WbElement = Record<string, unknown> & { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean };
type Scene = { type?: string; elements: WbElement[]; [k: string]: unknown };

const MAX_WB_BYTES = 10 * 1024 * 1024;
const SHAPES = ["rectangle", "ellipse", "diamond"] as const;
const WB_TYPES = [...SHAPES, "text", "arrow", "line"] as const;

async function loadWhiteboard(args: Args) {
  const { accountId, primary } = await accountArg(args);
  const node = await nodeArg(args, "fileId", accountId, "file");
  if (nativeKind(node.name) !== "whiteboard") throw new ToolError(`"${node.name}" is not a whiteboard (.excalidraw)`);
  const { bytes, truncated } = node.blobId ? await readNodeBytes(node, MAX_WB_BYTES) : { bytes: new Uint8Array(), truncated: false };
  if (truncated) throw new ToolError("The whiteboard is too large");
  const text = new TextDecoder().decode(bytes).trim();
  let scene: Scene;
  try {
    scene = text ? (JSON.parse(text) as Scene) : (JSON.parse(NATIVE.whiteboard.blank) as Scene);
  } catch {
    throw new ToolError("The whiteboard file is not valid Excalidraw JSON");
  }
  if (!scene || typeof scene !== "object" || (scene.elements != null && !Array.isArray(scene.elements))) throw new ToolError("Unexpected whiteboard format");
  scene.elements ??= [];
  return { node, scene, accountId, primary };
}

const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
const rnd = () => Math.floor(Math.random() * 2 ** 31);
const newElementId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|[a-z]{3,20})$/;

function baseElement(type: string, x: number, y: number, width: number, height: number, style: Args): WbElement {
  const color = (k: string, def: string) => (typeof style[k] === "string" && COLOR.test(style[k] as string) ? (style[k] as string) : def);
  return {
    id: newElementId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: color("strokeColor", "#1e1e1e"),
    backgroundColor: color("backgroundColor", "transparent"),
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" || type === "diamond" ? { type: 3 } : type === "arrow" || type === "line" ? { type: 2 } : null,
    seed: rnd(),
    version: 1,
    versionNonce: rnd(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function textElement(text: string, x: number, y: number, fontSize: number, style: Args, containerId: string | null): WbElement {
  const lines = text.split("\n");
  const width = Math.max(10, Math.max(...lines.map((l) => l.length)) * fontSize * 0.6);
  const height = lines.length * fontSize * 1.25;
  return {
    ...baseElement("text", containerId ? x - width / 2 : x, containerId ? y - height / 2 : y, width, height, { strokeColor: style.strokeColor }),
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  };
}

/** Where the segment from the box's center toward (tx, ty) leaves the box. */
function edgePoint(el: WbElement, tx: number, ty: number): [number, number] {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const scale = Math.min(dx ? el.width / 2 / Math.abs(dx) : Infinity, dy ? el.height / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * Math.min(scale, 1), cy + dy * Math.min(scale, 1)];
}

const labelOf = (el: WbElement, byId: Map<string, WbElement>) => {
  const bound = (el.boundElements as { id: string; type: string }[] | null) ?? [];
  const t = bound.map((b) => byId.get(b.id)).find((b) => b && b.type === "text" && !b.isDeleted);
  return t ? String(t.text ?? "") : undefined;
};

/* -------------------------------------------------------------------- tools */

const ACCOUNT_PROP = S("Shared space / account id (omit for My Drive).");
const DOC_KINDS = ["document", "spreadsheet", "presentation", "markdown", "whiteboard"] as const;
type ToolDocKind = (typeof DOC_KINDS)[number];
const kindName = (k: string): ToolDocKind => (k === "text" ? "document" : (k as ToolDocKind));

export const DRIVE_TOOLS: Tool[] = [
  {
    name: "drive_list",
    description: "Lists a Drive folder (default: My Drive root). Folders first, then files by name.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: S("Folder id (omit for the root)."),
        accountId: ACCOUNT_PROP,
        limit: I("Max entries.", 1, 500, 100),
        position: I("Offset for pagination.", 0, 100_000, 0),
      },
    },
    async run(args) {
      const folderId = id(args, "folderId") ?? null;
      const { accountId, primary } = await accountArg(args);
      const limit = int(args, "limit", { min: 1, max: 500, def: 100 });
      const position = int(args, "position", { min: 0, max: 100_000, def: 0 });
      if (folderId) {
        const folder = await getNode(folderId, accountId);
        if (!folder?.isFolder) throw new ToolError("Folder not found");
      }
      const all = (await listChildren(folderId, accountId))
        .filter((n) => n.role !== "trash")
        .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
      const { total, nextPosition, items } = page(all, position, limit);
      return { folderId, total, nextPosition, entries: items.map((n) => compactNode(n, primary)) };
    },
  },
  {
    name: "drive_search",
    description: "Finds Drive files and folders whose name contains the text (case- and accent-insensitive).",
    inputSchema: {
      type: "object",
      properties: {
        query: S("Text contained in the name."),
        accountId: ACCOUNT_PROP,
        limit: I("Max results.", 1, 200, 50),
      },
      required: ["query"],
    },
    async run(args) {
      const q = str(args, "query", { required: true, max: 200 }).trim();
      if (!q) throw new ToolError('"query" is required');
      const limit = int(args, "limit", { min: 1, max: 200, def: 50 });
      const { accountId, primary } = await accountArg(args);
      const found = await searchNodes(q, accountId);
      found.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      return { total: found.length, results: found.slice(0, limit).map((n) => compactNode(n, primary)) };
    },
  },
  {
    name: "drive_get_info",
    description:
      "Details of a Drive file or folder: path, size, type, dates, your rights, who it is shared with (and their role), and its link. Returns modified/blobId for safe edits.",
    inputSchema: { type: "object", properties: { fileId: S("File or folder id."), accountId: ACCOUNT_PROP }, required: ["fileId"] },
    async run(args) {
      const { accountId, primary } = await accountArg(args);
      const node = await nodeArg(args, "fileId", accountId);
      const [path, shares] = await Promise.all([getPath(node.id, accountId).catch(() => [] as DriveNode[]), grantsOf(node, accountId).catch(() => null)]);
      const rights = RIGHT_KEYS.filter((k) => node.rights[k]).map((k) => k.replace(/^may/, "").replace(/^./, (c) => c.toLowerCase()));
      return {
        id: node.id,
        name: node.name,
        folder: node.isFolder || undefined,
        type: node.isFolder ? undefined : node.type,
        size: node.isFolder ? undefined : node.size,
        created: node.created ?? undefined,
        modified: node.modified ?? undefined,
        blobId: node.blobId ?? undefined,
        path: `/${path.slice(0, -1).map((p) => p.name).join("/")}`,
        parentId: node.parentId ?? undefined,
        accountId: primary ? undefined : node.accountId,
        docKind: node.isFolder ? undefined : (nativeKind(node.name) ?? (docKind(node.name) ? kindName(docKind(node.name)!) : undefined)),
        yourRights: rights,
        sharedWith: shares ?? undefined,
        sharingSupported: shares ? undefined : false,
        url: fileUrl(node, primary),
      };
    },
  },
  {
    name: "drive_read_text",
    description:
      "Reads a Drive file as text: Markdown, plain text, CSV, JSON, HTML (as text), Excalidraw JSON, transcripts…; office documents (docx, xlsx, pptx, odt…) are converted to text via Collabora when available. Other files return binary=true. Also returns modified/blobId for drive_edit_text.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("File id (from drive_list / drive_search)."),
        accountId: ACCOUNT_PROP,
        maxBytes: I("Read at most this many bytes of a text file.", 1, MAX_EDIT_BYTES, MAX_TEXT_BYTES),
        rawHtml: B("Return HTML files as HTML source instead of text."),
      },
      required: ["fileId"],
    },
    async run(args) {
      const { accountId } = await accountArg(args);
      const node = await nodeArg(args, "fileId", accountId, "file");
      const maxBytes = int(args, "maxBytes", { min: 1, max: MAX_EDIT_BYTES, def: MAX_TEXT_BYTES });
      const meta = { id: node.id, name: node.name, type: node.type, size: node.size, modified: node.modified ?? undefined, blobId: node.blobId ?? undefined };
      const textual = isTextLike(node.name, node.type);
      if (!textual && node.size > MAX_CONVERT_BYTES) return { ...meta, binary: true, reason: "file too large to convert to text" };
      const { bytes, truncated } = !node.blobId ? { bytes: new Uint8Array(), truncated: false } : await readNodeBytes(node, textual ? maxBytes : MAX_CONVERT_BYTES);
      const out = await extractText(bytes, node.name, node.type, { maxChars: Number.MAX_SAFE_INTEGER, partial: truncated, rawHtml: bool(args, "rawHtml") });
      if (!out.ok) return { ...meta, binary: true, reason: out.reason };
      return {
        ...meta,
        truncated: out.truncated || undefined,
        format: out.via === "html" ? "text (from HTML)" : out.via === "collabora" ? "text (converted with Collabora)" : undefined,
        content: out.text,
      };
    },
  },
  {
    name: "drive_write_text",
    description:
      "Creates or overwrites a .md, .txt or .json file in Drive (max 1 MB). Pass fileId to overwrite, or name (+ folderId) to create. Prefer drive_edit_text for changes to an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("Existing file to overwrite."),
        name: S('New file name ending in .md, .txt or .json, e.g. "notes.md".'),
        folderId: S("Folder for a new file (omit for the root)."),
        overwrite: B("When creating by name and a file with that name exists in the folder, overwrite it (default: create a numbered copy)."),
        content: S("Full file content."),
        accountId: ACCOUNT_PROP,
        ...VERSION_PROPS,
      },
      required: ["content"],
    },
    write: true,
    destructive: true,
    async run(args) {
      const content = str(args, "content", { max: MAX_TEXT_BYTES }) ?? "";
      const { accountId, primary } = await accountArg(args);
      const fileId = id(args, "fileId");
      if (fileId) {
        const current = await getNode(fileId, accountId);
        if (current) checkVersion(current, args);
      }
      const { node, created } = await writeText({
        fileId,
        name: str(args, "name", { max: 255 }),
        folderId: await folderArg(args, "folderId", accountId),
        overwrite: bool(args, "overwrite"),
        content,
        accountId,
      });
      return { created, id: node.id, name: node.name, size: node.size, modified: node.modified ?? undefined, url: fileUrl(node, primary) };
    },
  },
  {
    name: "drive_edit_text",
    description:
      'Edits a text file in place (Markdown, txt, CSV, JSON, HTML…) without resending it whole. Edits run in order: {op:"replace", find, replace, all?, occurrence?} (exact text), {op:"append", text}, {op:"prepend", text}, {op:"replace_lines", startLine, endLine, text} (1-based, inclusive; endLine = startLine-1 inserts). Pass expectedModified/expectedBlobId from drive_read_text so concurrent changes are not overwritten.',
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("File id."),
        accountId: ACCOUNT_PROP,
        edits: {
          type: "array",
          description: "Edits applied in order.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace", "append", "prepend", "replace_lines"] },
              find: { type: "string" },
              replace: { type: "string" },
              all: { type: "boolean" },
              occurrence: { type: "integer", minimum: 1 },
              text: { type: "string" },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 0 },
            },
            required: ["op"],
          },
        },
        dryRun: B("Return the result without saving."),
        ...VERSION_PROPS,
      },
      required: ["fileId", "edits"],
    },
    write: true,
    destructive: true,
    async run(args) {
      const { accountId, primary } = await accountArg(args);
      const node = await nodeArg(args, "fileId", accountId, "file");
      if (!isTextLike(node.name, node.type)) throw new ToolError(`"${node.name}" is not a text file`);
      if (!node.rights.mayModifyContent) throw new ToolError(`You can't edit "${node.name}"`);
      checkVersion(node, args);
      const edits = parseEdits(args.edits);
      const { bytes, truncated } = !node.blobId ? { bytes: new Uint8Array(), truncated: false } : await readNodeBytes(node, MAX_EDIT_BYTES);
      if (truncated) throw new ToolError("The file is larger than 5 MB and can't be edited here");
      const before = new TextDecoder().decode(bytes);
      const { content, changes } = applyEdits(before, edits);
      if (bool(args, "dryRun")) return { dryRun: true, changes, content };
      if (content === before) return { changed: false, changes };
      const body = encodeText(content, extOf(node.name), MAX_EDIT_BYTES);
      // Last check right before writing: someone may have saved while we edited.
      const latest = await getNode(node.id, accountId);
      if (latest && (latest.blobId !== node.blobId || latest.modified !== node.modified)) {
        throw new ToolError("The file changed while editing. Read it again and redo the edit.");
      }
      const type = MIME.test(node.type) && node.type !== "application/octet-stream" ? node.type : mimeFor(node.name);
      const next = await replaceContent(node.id, body, type, accountId);
      return { changed: true, changes, id: next.id, name: next.name, size: next.size, modified: next.modified ?? undefined, blobId: next.blobId ?? undefined, url: fileUrl(next, primary) };
    },
  },
  {
    name: "drive_upload",
    description:
      "Uploads a file to Drive from text (`text`) or base64 bytes (`contentBase64`), up to 10 MB. The media type is taken from the name's extension unless given.",
    inputSchema: {
      type: "object",
      properties: {
        name: S('File name with extension, e.g. "report.pdf".'),
        folderId: S("Folder id (omit for the root)."),
        accountId: ACCOUNT_PROP,
        text: S("File content as text (UTF-8)."),
        contentBase64: S("File content as base64."),
        mediaType: S('Media type, e.g. "application/pdf" (default: from the extension).'),
        overwrite: B("Replace a file with the same name in the folder (default: create a numbered copy)."),
      },
      required: ["name"],
    },
    write: true,
    async run(args) {
      const name = validName(str(args, "name", { required: true, max: 255 }));
      if (!name) throw new ToolError('"name" is not a valid file name');
      const { accountId, primary } = await accountArg(args);
      const text = str(args, "text", { max: MAX_UPLOAD_TOOL_BYTES });
      const b64 = str(args, "contentBase64", { max: Math.ceil((MAX_UPLOAD_TOOL_BYTES * 4) / 3) + 1024 });
      if ((text == null) === (b64 == null)) throw new ToolError('Pass exactly one of "text" or "contentBase64"');
      let body: ArrayBuffer;
      if (b64 != null) {
        const clean = b64.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new ToolError('"contentBase64" is not valid base64');
        body = toArrayBuffer(Buffer.from(clean, "base64"));
      } else body = encode(text ?? "");
      if (body.byteLength > MAX_UPLOAD_TOOL_BYTES || body.byteLength > MAX_UPLOAD_BYTES) throw new ToolError("The file is larger than 10 MB");
      const typeArg = str(args, "mediaType", { max: 255 });
      if (typeArg && !MIME.test(typeArg)) throw new ToolError('"mediaType" is not a valid media type');
      const type = typeArg ?? (text != null && mimeFor(name) === "application/octet-stream" ? "text/plain" : mimeFor(name));
      const { node, created } = await storeFile({
        name,
        folderId: await folderArg(args, "folderId", accountId),
        body,
        type,
        overwrite: bool(args, "overwrite"),
        accountId,
      });
      return { created, ...compactNode(node, primary), url: fileUrl(node, primary) };
    },
  },
  {
    name: "drive_create_folder",
    description: "Creates a folder in Drive (a numbered name is used if one with that name exists).",
    inputSchema: {
      type: "object",
      properties: { name: S("Folder name."), parentId: S("Parent folder id (omit for the root)."), accountId: ACCOUNT_PROP },
      required: ["name"],
    },
    write: true,
    async run(args) {
      const name = validName(str(args, "name", { required: true, max: 255 }));
      if (!name) throw new ToolError('"name" is not a valid folder name');
      const { accountId, primary } = await accountArg(args);
      const node = await createFolder(await folderArg(args, "parentId", accountId), name, accountId);
      return { id: node.id, name: node.name, url: fileUrl(node, primary) };
    },
  },
  {
    name: "drive_rename",
    description: "Renames a file or folder. A file keeps its extension when the new name has none (so it still opens in the same editor).",
    inputSchema: {
      type: "object",
      properties: { fileId: S("File or folder id."), name: S("New name."), accountId: ACCOUNT_PROP },
      required: ["fileId", "name"],
    },
    write: true,
    async run(args) {
      const { accountId } = await accountArg(args);
      const node = await nodeArg(args, "fileId", accountId);
      if (!node.rights.mayRename) throw new ToolError(`You can't rename "${node.name}"`);
      let name = validName(str(args, "name", { required: true, max: 255 }));
      if (!name) throw new ToolError('"name" is not a valid name');
      const oldExt = extOf(node.name);
      if (!node.isFolder && oldExt && !extOf(name)) name = validName(`${name}.${oldExt}`);
      if (!name) throw new ToolError('"name" is not a valid name');
      if (name === node.name) return { id: node.id, name, unchanged: true };
      const siblings = await listChildren(node.parentId, accountId).catch(() => [] as DriveNode[]);
      if (siblings.some((s) => s.id !== node.id && s.name.toLowerCase() === name!.toLowerCase())) {
        throw new ToolError(`"${name}" already exists in that folder`);
      }
      await updateNode(node.id, { name }, accountId);
      return { id: node.id, oldName: node.name, name };
    },
  },
  {
    name: "drive_move",
    description: "Moves files or folders into another folder of the same Drive/space (targetFolderId omitted or \"root\" = the root).",
    inputSchema: {
      type: "object",
      properties: {
        fileIds: A("File or folder ids to move."),
        targetFolderId: S('Destination folder id ("root" or omit for the root).'),
        accountId: ACCOUNT_PROP,
      },
      required: ["fileIds"],
    },
    write: true,
    async run(args) {
      const { accountId } = await accountArg(args);
      const ids = [...new Set(idList(args, "fileIds", 200))];
      if (!ids.length) throw new ToolError('"fileIds" is required');
      const target = await folderArg(args, "targetFolderId", accountId);
      try {
        await moveNodes(ids, target, accountId);
      } catch (e) {
        if (e instanceof DriveError && e.code === "cycle") throw new ToolError("A folder can't be moved into itself or one of its subfolders");
        throw e;
      }
      return { moved: ids.length, targetFolderId: target ?? "root" };
    },
  },
  {
    name: "drive_copy",
    description:
      "Copies a file (not folders) into a folder, possibly in another space, without re-uploading when it stays in the same Drive. The copy gets a numbered name if the name is taken.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("File id to copy."),
        accountId: ACCOUNT_PROP,
        targetFolderId: S("Destination folder (default: the same folder)."),
        targetAccountId: S("Destination space / account (default: the same as the source)."),
        name: S("Name of the copy (default: the original name)."),
      },
      required: ["fileId"],
    },
    write: true,
    async run(args) {
      const { accountId } = await accountArg(args);
      const node = await nodeArg(args, "fileId", accountId, "file");
      if (!node.blobId) throw new ToolError("This file has no content to copy");
      const dest = args.targetAccountId != null ? await accountArg(args, "targetAccountId") : { accountId, primary: !accountId };
      const sameAccount = (dest.accountId ?? null) === (accountId ?? null);
      const target = args.targetFolderId != null ? await folderArg(args, "targetFolderId", dest.accountId) : sameAccount ? node.parentId : null;
      const name = validName(str(args, "name", { max: 255 }) ?? node.name);
      if (!name) throw new ToolError('"name" is not a valid file name');
      let blob: { blobId: string; type: string; size: number };
      if (sameAccount) blob = { blobId: node.blobId, type: node.type, size: node.size };
      else {
        // Blob ids belong to one account: stream the bytes over to the destination.
        const res = await fetchBlob(node);
        if (!res.ok || !res.body) throw new ToolError(`Could not read the file (HTTP ${res.status})`);
        blob = await uploadStream(res.body, node.type, node.size || null, { accountId: dest.accountId });
      }
      const rootId = await getRootId(dest.accountId).catch(() => null);
      const copy = await createFile(target === rootId ? null : target, name, { ...blob, type: node.type }, dest.accountId);
      return { copied: true, ...compactNode(copy, dest.primary), url: fileUrl(copy, dest.primary) };
    },
  },
  {
    name: "drive_delete",
    description:
      "Moves files or folders to the Drive trash (or deletes them permanently when there is no trash, or with permanent=true). Requires confirm=true: ask the user first.",
    inputSchema: {
      type: "object",
      properties: {
        fileIds: A("File or folder ids."),
        accountId: ACCOUNT_PROP,
        permanent: B("Delete permanently instead of moving to the trash."),
        confirm: B("Must be true: the user confirmed the deletion."),
      },
      required: ["fileIds", "confirm"],
    },
    write: true,
    destructive: true,
    async run(args) {
      if (args.confirm !== true) throw new ToolError("Deleting needs confirm=true. Ask the user to confirm first.");
      const { accountId } = await accountArg(args);
      const ids = [...new Set(idList(args, "fileIds", 200))];
      if (!ids.length) throw new ToolError('"fileIds" is required');
      const nodes = await Promise.all(ids.map((i) => getNode(i, accountId)));
      const missing = ids.filter((_, i) => !nodes[i]);
      if (missing.length) throw new ToolError(`Not found: ${missing.join(", ")}`);
      const denied = nodes.filter((n) => n && !n.rights.mayDelete).map((n) => n!.name);
      if (denied.length) throw new ToolError(`You can't delete: ${denied.join(", ")}`);
      if (nodes.some((n) => n!.role != null)) throw new ToolError("System folders can't be deleted");
      const trashId = await getTrashId(accountId);
      const inTrash = trashId ? descendantsOf(await getAllNodes(accountId), trashId) : new Set<string>();
      const names = nodes.map((n) => n!.name);
      if (trashId && !bool(args, "permanent") && !ids.some((i) => inTrash.has(i))) {
        await moveNodes(ids, trashId, accountId);
        return { trashed: names };
      }
      await destroyNodes(ids, accountId);
      return { deletedPermanently: names };
    },
  },
  {
    name: "drive_share",
    description:
      'Shares a file or folder with people or groups of the organization (by email, name or group name) as viewer, editor or manager, or removes their access. Returns who has access afterwards.',
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("File or folder id."),
        accountId: ACCOUNT_PROP,
        add: A("People or groups to grant access to (emails, names or group names)."),
        role: S('Role for "add": "viewer" (default), "editor" or "manager".', { enum: [...ROLES] }),
        remove: A("People or groups whose access is removed."),
      },
      required: ["fileId"],
    },
    write: true,
    async run(args) {
      const { accountId } = await accountArg(args);
      const node = await nodeArg(args, "fileId", accountId);
      if (!node.rights.mayShare) throw new ToolError(`You can't change who has access to "${node.name}"`);
      const add = strList(args, "add", { max: 50 });
      const remove = strList(args, "remove", { max: 50 });
      if (!add.length && !remove.length) throw new ToolError('Pass "add" and/or "remove"');
      const role = oneOf(args, "role", ROLES, "viewer") as ShareRole;
      const principals = await listPrincipals();
      if (!principals) throw new ToolError("Sharing with people isn't available on this server");
      const [{ email }, session] = await Promise.all([requireSession(), getDriveSession()]);
      const myDomain = email.slice(email.indexOf("@") + 1).toLowerCase();
      const done: string[] = [];
      for (const [list, rights] of [
        [add, ROLE_RIGHTS[role]],
        [remove, null],
      ] as const) {
        for (const who of list) {
          const p = findPrincipal(who, principals, myDomain);
          if (session?.selfPrincipalId && p.id === session.selfPrincipalId) throw new ToolError("You can't change your own access");
          await setShare(node.id, p.id, rights, accountId);
          done.push(`${rights ? `${role}:` : "removed:"} ${p.email ? personName(p.name, p.email) : p.name}`);
        }
      }
      return { name: node.name, changes: done, sharedWith: (await grantsOf(node, accountId).catch(() => null)) ?? undefined };
    },
  },
  {
    name: "drive_list_shared_with_me",
    description:
      "Lists what others share with you: shared spaces (team drives) and people's shared folders/files. Pass accountId (and folderId) to browse inside one.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: S("Browse this shared space / account (from a previous call)."),
        folderId: S("Folder inside that account."),
        limit: I("Max entries.", 1, 500, 100),
        position: I("Offset for pagination.", 0, 100_000, 0),
      },
    },
    async run(args) {
      const limit = int(args, "limit", { min: 1, max: 500, def: 100 });
      const position = int(args, "position", { min: 0, max: 100_000, def: 0 });
      const accounts = (await getDriveAccounts()).filter((a) => a.kind !== "personal");
      const wanted = id(args, "accountId");
      const folderId = id(args, "folderId") ?? null;
      if (wanted && !accounts.some((a) => a.id === wanted)) throw new ToolError("Unknown shared account");
      const list = wanted ? accounts.filter((a) => a.id === wanted) : accounts;
      const entries = (
        await Promise.all(
          list.map(async (a) =>
            (await listChildren(wanted ? folderId : null, a.id).catch(() => [] as DriveNode[]))
              .filter((n) => n.role == null)
              .map((n) => ({ ...compactNode(n, false), owner: a.name, space: a.kind === "space" || undefined })),
          ),
        )
      )
        .flat()
        .sort((x, y) => Number(!!y.folder) - Number(!!x.folder) || x.name.localeCompare(y.name));
      const { total, nextPosition, items } = page(entries, position, limit);
      return {
        accounts: wanted ? undefined : accounts.map((a) => ({ accountId: a.id, name: a.name, kind: a.kind, readOnly: a.isReadOnly || undefined })),
        total,
        nextPosition,
        entries: items,
      };
    },
  },
  {
    name: "docs_list",
    description: "Lists Docs documents (office documents, spreadsheets, presentations, Markdown docs and whiteboards), newest first, optionally by kind or name.",
    inputSchema: {
      type: "object",
      properties: {
        kind: S("Only this kind.", { enum: [...DOC_KINDS] }),
        query: S("Name contains (case- and accent-insensitive)."),
        limit: I("Max results.", 1, 200, 50),
        position: I("Offset for pagination.", 0, 100_000, 0),
      },
    },
    async run(args) {
      const kind = args.kind == null ? null : oneOf(args, "kind", DOC_KINDS, "document");
      const q = fold(str(args, "query", { max: 200 })?.trim() ?? "");
      const limit = int(args, "limit", { min: 1, max: 200, def: 50 });
      const position = int(args, "position", { min: 0, max: 100_000, def: 0 });
      const [all, rootId, trashId] = await Promise.all([getAllNodes(), getRootId(), getTrashId()]);
      const docs = toDocs(all, rootId, trashId, null)
        .filter((d) => (!kind || kindName(d.kind) === kind) && (!q || fold(d.name).includes(q)))
        .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      const { total, nextPosition, items } = page(docs, position, limit);
      return {
        total,
        nextPosition,
        docs: items.map((d) => ({
          id: d.id,
          name: d.name,
          kind: kindName(d.kind),
          folder: d.location ?? undefined,
          modified: d.modified ?? undefined,
          size: d.size,
          url: `${appUrl()}${openHref(d.id, d.kind)}`,
        })),
      };
    },
  },
  {
    name: "docs_create",
    description:
      "Creates a Docs document and returns its link: document, spreadsheet, presentation (office files edited in Collabora), markdown or whiteboard. Optional initial content: Markdown for document/markdown, CSV for spreadsheet.",
    inputSchema: {
      type: "object",
      properties: {
        kind: S("Kind of document.", { enum: [...DOC_KINDS] }),
        title: S("Title (becomes the file name)."),
        content: S("Initial content: Markdown (document, markdown) or CSV (spreadsheet)."),
        folderId: S("Drive folder id (omit for the root)."),
      },
      required: ["kind", "title"],
    },
    write: true,
    async run(args) {
      const kind = oneOf(args, "kind", DOC_KINDS, "document");
      if (args.kind == null) throw new ToolError('"kind" is required');
      const title = cleanTitle(str(args, "title", { required: true, max: 200 }));
      const content = str(args, "content", { max: MAX_TEXT_BYTES });
      const folderId = await folderArg(args, "folderId", undefined);
      let name: string;
      let type: string;
      let body: ArrayBuffer;
      if (kind === "markdown" || kind === "whiteboard") {
        const spec = NATIVE[kind];
        if (kind === "whiteboard" && content) throw new ToolError("Whiteboards start empty; add shapes with whiteboard_add_elements");
        name = `${title.replace(new RegExp(`\\.(${spec.exts.join("|")})$`, "i"), "")}.${spec.ext}`;
        type = spec.mediaType;
        body = encode(kind === "markdown" ? (content ?? "") : spec.blank);
      } else {
        const spec = NEW_DOC[kind === "document" ? "text" : kind];
        name = `${title}.${spec.ext}`;
        type = spec.type;
        body = new ArrayBuffer(0);
        if (content) {
          if (kind === "presentation") throw new ToolError("Presentations can't start with content; create it empty");
          // Collabora turns HTML (from the Markdown) into a Writer file and CSV into a Calc file.
          const source = kind === "document"
            ? `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, "")}</title></head><body>${markdownToHtml(content)}</body></html>`
            : content;
          let converted: ArrayBuffer | null;
          try {
            converted = await convertWithCollabora(new TextEncoder().encode(source), kind === "document" ? "content.html" : "content.csv", spec.ext);
          } catch (e) {
            console.error("[mcp] docs_create convert:", e instanceof Error ? e.message : e);
            throw new ToolError("Could not convert the content into an office document; create it empty or as a markdown doc");
          }
          if (!converted) throw new ToolError("Initial content for office documents needs Collabora (COLLABORA_URL is not set)");
          body = converted;
        }
      }
      const { node } = await storeFile({ name, folderId, body, type, overwrite: false });
      return { id: node.id, name: node.name, kind, url: `${appUrl()}${openHref(node.id, node.name)}` };
    },
  },
  {
    name: "docs_create_markdown",
    description: "Creates a Markdown document (opens in the Docs Markdown editor) and returns its link. Good for meeting notes, summaries and plans.",
    inputSchema: {
      type: "object",
      properties: {
        title: S('Document title (becomes "<title>.md").'),
        content: S("Markdown content."),
        folderId: S("Drive folder id (omit for the root)."),
      },
      required: ["title", "content"],
    },
    write: true,
    async run(args) {
      const title = cleanTitle(str(args, "title", { required: true, max: 200 }).replace(/\.(md|markdown)$/i, ""));
      const { node } = await writeText({
        name: `${title}.md`,
        folderId: await folderArg(args, "folderId", undefined),
        overwrite: false,
        content: str(args, "content", { max: MAX_TEXT_BYTES }) ?? "",
      });
      return { id: node.id, name: node.name, url: fileUrl(node) };
    },
  },
  {
    name: "whiteboard_read",
    description:
      "Summarizes an Excalidraw whiteboard: element counts, the drawing's bounds and each element (id, type, position, size, text or label, arrow endpoints). Returns modified for whiteboard_add_elements.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("Whiteboard (.excalidraw) file id."),
        accountId: ACCOUNT_PROP,
        limit: I("Max elements listed.", 1, 1000, 200),
        position: I("Offset for pagination.", 0, 100_000, 0),
      },
      required: ["fileId"],
    },
    async run(args) {
      const { node, scene } = await loadWhiteboard(args);
      const live = scene.elements.filter((e) => e && !e.isDeleted);
      const byId = new Map(live.map((e) => [e.id, e]));
      const counts: Record<string, number> = {};
      for (const e of live) counts[e.type] = (counts[e.type] ?? 0) + 1;
      // Labels inside shapes are listed with their shape, not separately.
      const listed = live.filter((e) => !(e.type === "text" && e.containerId && byId.has(String(e.containerId))));
      const xs = live.flatMap((e) => [num(e.x, 0), num(e.x, 0) + num(e.width, 0)]);
      const ys = live.flatMap((e) => [num(e.y, 0), num(e.y, 0) + num(e.height, 0)]);
      const limit = int(args, "limit", { min: 1, max: 1000, def: 200 });
      const position = int(args, "position", { min: 0, max: 100_000, def: 0 });
      const { total, nextPosition, items } = page(listed, position, limit);
      const r = Math.round;
      return {
        id: node.id,
        name: node.name,
        modified: node.modified ?? undefined,
        counts,
        bounds: live.length ? { x: r(Math.min(...xs)), y: r(Math.min(...ys)), width: r(Math.max(...xs) - Math.min(...xs)), height: r(Math.max(...ys) - Math.min(...ys)) } : null,
        total,
        nextPosition,
        elements: items.map((e) => {
          const sb = e.startBinding as { elementId?: string } | null | undefined;
          const eb = e.endBinding as { elementId?: string } | null | undefined;
          return {
            id: e.id,
            type: e.type,
            x: r(num(e.x, 0)),
            y: r(num(e.y, 0)),
            width: r(num(e.width, 0)),
            height: r(num(e.height, 0)),
            text: e.type === "text" ? String(e.text ?? "") : labelOf(e, byId),
            from: sb?.elementId,
            to: eb?.elementId,
            color: e.strokeColor !== "#1e1e1e" ? e.strokeColor : undefined,
            fill: e.backgroundColor && e.backgroundColor !== "transparent" ? e.backgroundColor : undefined,
          };
        }),
      };
    },
  },
  {
    name: "whiteboard_add_elements",
    description:
      'Adds simple elements to an Excalidraw whiteboard: rectangles/ellipses/diamonds (optional `label` text inside), free text, and arrows/lines. Arrows connect elements with from/to (an existing element id, or the `ref` of an element added in the same call), or use x,y + endX,endY. Elements without x/y are laid out in a row below the drawing.',
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("Whiteboard (.excalidraw) file id."),
        accountId: ACCOUNT_PROP,
        elements: {
          type: "array",
          description: "Elements to add (max 200).",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...WB_TYPES] },
              ref: { type: "string", description: "Your name for this element, to connect arrows to it." },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              text: { type: "string", description: "Text of a text element." },
              label: { type: "string", description: "Text inside a shape (or on an arrow)." },
              fontSize: { type: "number" },
              from: { type: "string", description: "Arrow start: element id or ref." },
              to: { type: "string", description: "Arrow end: element id or ref." },
              endX: { type: "number" },
              endY: { type: "number" },
              strokeColor: { type: "string", description: 'e.g. "#1971c2".' },
              backgroundColor: { type: "string", description: 'e.g. "#a5d8ff" or "transparent".' },
            },
            required: ["type"],
          },
        },
        ...VERSION_PROPS,
      },
      required: ["fileId", "elements"],
    },
    write: true,
    async run(args) {
      const { node, scene, accountId, primary } = await loadWhiteboard(args);
      if (!node.rights.mayModifyContent) throw new ToolError(`You can't edit "${node.name}"`);
      checkVersion(node, args);
      if (!Array.isArray(args.elements) || !args.elements.length || args.elements.length > 200) throw new ToolError('"elements" must be a list of 1–200 elements');
      const live = scene.elements.filter((e) => e && !e.isDeleted);
      const byId = new Map(scene.elements.map((e) => [e.id, e]));
      const refs = new Map<string, WbElement>();
      const added: WbElement[] = [];
      const bottom = live.length ? Math.max(...live.map((e) => num(e.y, 0) + num(e.height, 0))) : 0;
      const left = live.length ? Math.min(...live.map((e) => num(e.x, 0))) : 0;
      let cursorX = left;
      const rowY = live.length ? bottom + 80 : 0;
      const place = (w: number) => {
        const x = cursorX;
        cursorX += w + 60;
        return x;
      };
      const arrows: { input: Args; el: WbElement }[] = [];

      for (const [i, raw] of (args.elements as unknown[]).entries()) {
        const e = (raw && typeof raw === "object" ? raw : {}) as Args;
        const type = String(e.type ?? "");
        if (!(WB_TYPES as readonly string[]).includes(type)) throw new ToolError(`elements[${i}].type must be one of ${WB_TYPES.join(", ")}`);
        const textOf = (k: string) => (typeof e[k] === "string" ? (e[k] as string).slice(0, 2000) : "");
        const fontSize = Math.min(Math.max(num(e.fontSize, 20), 8), 120);
        let el: WbElement;
        if (type === "text") {
          const text = textOf("text") || textOf("label");
          if (!text) throw new ToolError(`elements[${i}] (text) needs "text"`);
          const t = textElement(text, 0, 0, fontSize, e, null);
          t.x = num(e.x, NaN);
          t.y = num(e.y, NaN);
          if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) [t.x, t.y] = [place(t.width), rowY];
          el = t;
          added.push(el);
        } else if (type === "arrow" || type === "line") {
          el = baseElement(type, num(e.x, 0), num(e.y, 0), 0, 0, e);
          Object.assign(el, {
            points: [[0, 0], [0, 0]],
            lastCommittedPoint: null,
            startBinding: null,
            endBinding: null,
            startArrowhead: null,
            endArrowhead: type === "arrow" ? "arrow" : null,
            elbowed: false,
          });
          arrows.push({ input: e, el });
          added.push(el);
        } else {
          const dw = type === "rectangle" ? 200 : 160;
          const dh = type === "diamond" ? 100 : 80;
          const w = Math.min(Math.max(num(e.width, dw), 10), 5000);
          const h = Math.min(Math.max(num(e.height, dh), 10), 5000);
          const x = num(e.x, NaN);
          const y = num(e.y, NaN);
          el = baseElement(type, Number.isFinite(x) ? x : place(w), Number.isFinite(y) ? y : rowY, w, h, e);
          added.push(el);
          const label = textOf("label") || textOf("text");
          if (label) {
            const t = textElement(label, el.x + w / 2, el.y + h / 2, fontSize, e, el.id);
            el.boundElements = [{ type: "text", id: t.id }];
            added.push(t);
          }
        }
        const ref = typeof e.ref === "string" ? e.ref.trim() : "";
        if (ref) refs.set(ref, el);
      }

      // Arrows: connect to existing elements (by id) or new ones (by ref), edge to edge.
      for (const { input, el } of arrows) {
        const target = (k: string) => {
          const v = typeof input[k] === "string" ? (input[k] as string).trim() : "";
          if (!v) return null;
          const hit = refs.get(v) ?? byId.get(v);
          if (!hit || hit.isDeleted) throw new ToolError(`Arrow ${k} "${v}" is not an element id or ref`);
          return hit;
        };
        const a = target("from");
        const b = target("to");
        const ac: [number, number] = a ? [a.x + a.width / 2, a.y + a.height / 2] : [num(input.x, NaN), num(input.y, NaN)];
        const bc: [number, number] = b ? [b.x + b.width / 2, b.y + b.height / 2] : [num(input.endX, NaN), num(input.endY, NaN)];
        if (![...ac, ...bc].every(Number.isFinite)) throw new ToolError("Each arrow/line needs from/to elements or x, y, endX, endY");
        const start = a ? edgePoint(a, bc[0], bc[1]) : ac;
        const end = b ? edgePoint(b, ac[0], ac[1]) : bc;
        Object.assign(el, {
          x: start[0],
          y: start[1],
          width: Math.abs(end[0] - start[0]),
          height: Math.abs(end[1] - start[1]),
          points: [[0, 0], [end[0] - start[0], end[1] - start[1]]],
          startBinding: a ? { elementId: a.id, focus: 0, gap: 4 } : null,
          endBinding: b ? { elementId: b.id, focus: 0, gap: 4 } : null,
        });
        for (const s of [a, b]) {
          if (!s) continue;
          const bound = ((s.boundElements as { id: string; type: string }[] | null) ?? []).filter((x) => x.id !== el.id);
          s.boundElements = [...bound, { type: "arrow", id: el.id }];
          if (byId.has(s.id)) {
            s.version = num(s.version, 1) + 1;
            s.versionNonce = rnd();
            s.updated = Date.now();
          }
        }
        const label = typeof input.label === "string" ? input.label.slice(0, 500) : "";
        if (label) {
          const t = textElement(label, (start[0] + end[0]) / 2, (start[1] + end[1]) / 2, 16, input, el.id);
          el.boundElements = [{ type: "text", id: t.id }];
          added.push(t);
        }
      }

      scene.elements = [...scene.elements, ...added];
      const json = JSON.stringify(scene);
      const body = encodeText(json, "excalidraw", MAX_WB_BYTES);
      const latest = await getNode(node.id, accountId);
      if (latest && (latest.blobId !== node.blobId || latest.modified !== node.modified)) {
        throw new ToolError("The whiteboard changed while editing. Try again.");
      }
      const next = await replaceContent(node.id, body, NATIVE.whiteboard.mediaType, accountId);
      return {
        added: added.filter((e) => !(e.type === "text" && e.containerId)).length,
        ids: Object.fromEntries([...refs].map(([ref, e]) => [ref, e.id])),
        modified: next.modified ?? undefined,
        url: fileUrl(next, primary),
      };
    },
  },
];
