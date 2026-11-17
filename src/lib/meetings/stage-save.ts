// Saves a meeting stage to Drive: each whiteboard as a .excalidraw file and the cards as one
// Markdown document, in the meeting recording's folder when there is one (else Meetings/<date>),
// shared read-only with the people of the meeting. Saving again replaces the same files.
// Server-only. saveStageNow() runs as whoever is in the current session context (a browser user or
// an MCP token); saveStageOnClose() finds the stored credentials for the automatic save.
import { NATIVE } from "@/app/(apps)/docs/shared";
import { runWithSession } from "../auth";
import { unseal } from "../crypto";
import { createFile, createFolder, getNode, listChildren, listPrincipals, READ_RIGHTS, replaceContent, setShare, uploadStream } from "../drive";
import { activeTokenById } from "../mcp/db";
import { sessionForToken } from "../mcp/tokens";
import { needsRefresh, type Session } from "../session";
import { chatMeetingTitle } from "./chat-link";
import { audienceOf, exportStage, markSaved, recordingFolder, saveCredentials, savedFiles } from "./stage";

const DRIVE_FOLDER = "Meetings";
const enc = (s: string) => {
  const b = new TextEncoder().encode(s);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function folderFor(room: string, date: string): Promise<string> {
  const rec = recordingFolder(room);
  if (rec && (await getNode(rec).catch(() => null))?.isFolder) return rec;
  const top = await listChildren(null);
  const meetings = top.find((n) => n.isFolder && n.name.trim().toLowerCase() === DRIVE_FOLDER.toLowerCase()) ?? (await createFolder(null, DRIVE_FOLDER));
  const day = (await listChildren(meetings.id)).find((n) => n.isFolder && n.name === date) ?? (await createFolder(meetings.id, date));
  return day.id;
}

async function writeFile(existingId: string | undefined | null, folderId: string, name: string, body: string, type: string): Promise<string> {
  if (existingId) {
    const node = await getNode(existingId).catch(() => null);
    if (node && !node.isFolder && node.rights.mayModifyContent) return (await replaceContent(node.id, enc(body), type)).id;
  }
  const blob = await uploadStream(enc(body), type);
  return (await createFile(folderId, name, { ...blob, type })).id;
}

export type SavedStage = { folderId: string; boards: string[]; notes: string | null; sharedWith: number };

/** Writes the stage to the current user's Drive (session context required). */
export async function saveStageNow(room: string, me: string): Promise<SavedStage> {
  const title = chatMeetingTitle(room) ?? room;
  const when = new Date();
  const { boards, notes } = exportStage(room, title, when);
  if (!boards.length && !notes) throw new Error("The stage is empty");
  const prev = savedFiles(room);
  const folderId = prev.folder && (await getNode(prev.folder).catch(() => null))?.isFolder ? prev.folder : await folderFor(room, when.toISOString().slice(0, 10));
  const boardIds: Record<string, string> = {};
  for (const b of boards) boardIds[b.id] = await writeFile(prev.boards[b.id], folderId, b.name, b.json, NATIVE.whiteboard.mediaType);
  const notesId = notes ? await writeFile(prev.notes, folderId, notes.name, notes.markdown, "text/markdown") : null;
  markSaved(room, { boards: boardIds, notes: notesId, folder: folderId });

  // Read access for everyone in the meeting (best effort: the files are saved either way).
  let shared = 0;
  try {
    const principals = (await listPrincipals()) ?? [];
    const byEmail = new Map(principals.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p.id]));
    const files = [...Object.values(boardIds), ...(notesId ? [notesId] : [])];
    for (const email of await audienceOf(room)) {
      const pid = email !== me.toLowerCase() ? byEmail.get(email) : undefined;
      if (!pid) continue;
      for (const f of files) await setShare(f, pid, READ_RIGHTS).catch((e) => console.error("[stage] share:", e instanceof Error ? e.message : e));
      shared++;
    }
  } catch (e) {
    console.error("[stage] share:", e instanceof Error ? e.message : e);
  }
  return { folderId, boards: Object.values(boardIds), notes: notesId, sharedWith: shared };
}

/** The automatic save when a stage closes: as the agent's token owner, else the opener's stored session. */
export async function saveStageOnClose(room: string): Promise<void> {
  const { tokenId, sealed } = saveCredentials(room);
  let session: Session | null = null;
  const token = tokenId ? activeTokenById(tokenId) : null;
  if (token) session = await sessionForToken(token);
  else {
    const s = await unseal<Session>(sealed ?? undefined);
    // Never refreshed here (a refresh token presented after the browser rotated it revokes the grant).
    if (s && !needsRefresh(s)) session = { ...s, refreshToken: undefined };
  }
  if (!session) throw new Error("no valid credentials to save the stage (press Save in the call next time)");
  const s = session;
  await runWithSession(s, () => saveStageNow(room, s.email));
}
