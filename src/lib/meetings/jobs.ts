// Background processing of finished recordings: an in-process queue (one meeting at a time) that
// transcribes every speaker segment with Whisper, builds the Markdown transcript and saves it to
// the starter's Drive. Server-only. On boot (first import) it resumes interrupted jobs and then
// periodically finalizes recordings whose recorder disappeared.
import { runWithSession } from "../auth";
import { unseal } from "../crypto";
import { createFile, createFolder, listChildren, uploadStream } from "../drive";
import { env } from "../env";
import { refreshTokens } from "../oidc";
import { needsRefresh, sealSession, type Session } from "../session";
import { chatMeetingTitle, postTranscriptReady } from "./chat-link";
import {
  finalizeStale,
  jobMeeting,
  markFailed,
  markReady,
  processingIds,
  saveTranscript,
  setTitle,
  storedMarkdown,
  updateSealedSession,
  type JobMeeting,
} from "./store";
import { formatWhen, mergeSegments, toMarkdown, transcribeFile, whisperConfig } from "./transcribe";
import type { TranscriptSegment } from "@/app/(apps)/meet/recording";

const DRIVE_FOLDER = "Meetings";

type Queue = { pending: string[]; running: string | null; booted: boolean };
const g = globalThis as typeof globalThis & { __zwMeetQueue?: Queue };
const queue = (g.__zwMeetQueue ??= { pending: [], running: null, booted: false });

const log = (msg: string, e?: unknown) =>
  console.error(`[meetings] ${msg}${e ? `: ${e instanceof Error ? e.message : String(e)}` : ""}`);

/** Queues a recording for processing (no-op if already queued or running). */
export function enqueue(id: string): void {
  boot();
  if (queue.running === id || queue.pending.includes(id)) return;
  queue.pending.push(id);
  // Detach from the calling request so its lifetime doesn't matter.
  setTimeout(pump, 0);
}

function pump(): void {
  if (queue.running) return;
  const id = queue.pending.shift();
  if (!id) return;
  queue.running = id;
  processMeeting(id)
    .catch((e) => {
      log(`job ${id} crashed`, e);
      markFailed(id, "internal_error");
    })
    .finally(() => {
      queue.running = null;
      setTimeout(pump, 0);
    });
}

/** Resumes jobs cut short by a restart and starts the stale-recording sweep (once per process). */
export function boot(): void {
  if (queue.booted) return;
  queue.booted = true;
  const sweep = () => {
    try {
      for (const id of finalizeStale()) enqueue(id);
    } catch (e) {
      log("stale sweep failed", e);
    }
  };
  try {
    for (const id of processingIds()) if (!queue.pending.includes(id)) queue.pending.push(id);
  } catch (e) {
    log("resume failed", e);
  }
  sweep();
  setInterval(sweep, 60_000).unref?.();
  setTimeout(pump, 0);
}

async function processMeeting(id: string): Promise<void> {
  const loaded = jobMeeting(id);
  if (!loaded || loaded.summary.status !== "processing") return;
  const m = withTitle(loaded);

  // 1. Transcript (kept from an earlier run when only the Drive upload failed).
  let markdown = "";
  const existing = storedMarkdown(id);
  if (existing) {
    markdown = existing;
  } else {
    const cfg = whisperConfig();
    if (!cfg) return markFailed(id, "not_configured");
    if (!m.segments.length) {
      markdown = toMarkdown(m.summary, [], m.timeZone);
      saveTranscript(id, [], markdown);
    } else {
      const parts: { speaker: string; offsetSeconds: number; segments: TranscriptSegment[] }[] = [];
      for (const s of m.segments) {
        try {
          parts.push({ speaker: s.name, offsetSeconds: s.offsetMs / 1000, segments: await transcribeFile(cfg, s.path, s.mime) });
        } catch (e) {
          log(`transcription of ${id}/${s.id} failed`, e);
          return markFailed(id, "transcription_failed");
        }
      }
      const segments = mergeSegments(parts);
      markdown = toMarkdown(m.summary, segments, m.timeZone);
      saveTranscript(id, segments, markdown);
    }
  }

  // 2. Drive (the starter's "Meetings" folder), with the starter's stored credentials.
  let drive: { fileId: string; folderId: string | null } | null = null;
  let driveError: string | null = null;
  if (m.driveFileId) {
    drive = { fileId: m.driveFileId, folderId: null };
  } else {
    const session = await starterSession(m);
    if (!session) driveError = "drive_session_expired";
    else {
      try {
        drive = await saveToDrive(session, fileName(m), markdown);
      } catch (e) {
        log(`saving ${id} to Drive failed`, e);
        driveError = "drive_failed";
      }
    }
  }
  markReady(id, drive, driveError);

  // 3. Optional: tell the Chat thread of the meeting card (once, not on Drive retries).
  if (!existing) postTranscriptReady(m.summary.room, m.summary.startedBy, m.summary.title, `${appUrl()}${m.summary.url}`);
}

const appUrl = () => {
  try {
    return env.appUrl;
  } catch {
    return "";
  }
};

/** Prefers the Chat meeting's title over the bare room code (and remembers it). */
function withTitle(m: JobMeeting): JobMeeting {
  if (m.summary.title !== m.summary.room) return m;
  const title = chatMeetingTitle(m.summary.room)?.slice(0, 200);
  if (!title) return m;
  setTitle(m.id, title);
  return { ...m, summary: { ...m.summary, title } };
}

function fileName(m: JobMeeting): string {
  const { date, time } = formatWhen(m.summary.startedAt, m.timeZone);
  const title = m.summary.title.replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
  return `${date} ${time} ${title || m.summary.room}.md`;
}

/** The starter's stored session, refreshed through OIDC when its access token has expired. */
async function starterSession(m: JobMeeting): Promise<Session | null> {
  const session = await unseal<Session>(m.sealedSession ?? undefined);
  if (!session) return null;
  if (!needsRefresh(session)) return session;
  if (!session.refreshToken) return null;
  try {
    const tokens = await refreshTokens(session.refreshToken);
    const next: Session = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    };
    updateSealedSession(m.id, await sealSession(next));
    return next;
  } catch (e) {
    log(`refreshing the session for ${m.id} failed`, e);
    return null;
  }
}

async function saveToDrive(session: Session, name: string, markdown: string): Promise<{ fileId: string; folderId: string }> {
  return runWithSession(session, async () => {
    const top = await listChildren(null);
    const folder =
      top.find((n) => n.isFolder && n.name.trim().toLowerCase() === DRIVE_FOLDER.toLowerCase()) ??
      (await createFolder(null, DRIVE_FOLDER));
    const bytes = new TextEncoder().encode(markdown);
    const blob = await uploadStream(bytes.buffer as ArrayBuffer, "text/markdown");
    const file = await createFile(folder.id, name, { ...blob, type: "text/markdown" });
    return { fileId: file.id, folderId: folder.id };
  });
}
