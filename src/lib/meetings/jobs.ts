// Background processing of finished recordings: an in-process queue (one meeting at a time) that
// transcribes every speaker segment with Whisper, builds the Markdown transcript and saves it to
// the starter's Drive. Server-only. On boot (first import) it resumes interrupted jobs and then
// periodically finalizes recordings whose recorder disappeared. A second loop follows video
// recordings (LiveKit egress): once an MP4 is complete it is streamed to the same Drive folder.
import { rm, stat } from "node:fs/promises";
import { runWithSession } from "../auth";
import { unseal } from "../crypto";
import { createFile, createFolder, DriveError, listChildren, uploadFile, uploadStream } from "../drive";
import { env } from "../env";
import { needsRefresh, type Session } from "../session";
import { chatMeetingTitle, postTranscriptReady } from "./chat-link";
import { egressConfig, getEgress, stopEgress, videoPath } from "./egress";
import {
  finalizeStale,
  jobMeeting,
  markFailed,
  markReady,
  pendingVideos,
  processingIds,
  saveTranscript,
  setTitle,
  setVideoEnding,
  setVideoFailed,
  setVideoReady,
  setVideoRetry,
  setVideoUploading,
  storedMarkdown,
  videoEgress,
  type JobMeeting,
  type PendingVideo,
} from "./store";
import { sweepStages } from "./stage";
import { saveStageOnClose } from "./stage-save";
import { formatWhen, mergeSegments, toMarkdown, transcribeFile, whisperConfig } from "./transcribe";
import type { TranscriptSegment } from "@/app/(apps)/meet/recording";

const DRIVE_FOLDER = "Meetings";

const VIDEO_POLL_MS = 15_000;
/** Drive upload retries back off from 30 s up to 30 min, then give up (retry from the page). */
const VIDEO_MAX_ATTEMPTS = 10;

type Queue = { pending: string[]; running: string | null; booted: boolean; videoBusy: boolean; stagesBusy?: boolean };
const g = globalThis as typeof globalThis & { __zwMeetQueue?: Queue };
const queue = (g.__zwMeetQueue ??= { pending: [], running: null, booted: false, videoBusy: false });

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
      for (const id of finalizeStale()) {
        enqueue(id);
        void stopVideo(id);
      }
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
  // Meeting stages: stop the assistant when its owner left; save to Drive and close empty rooms.
  setInterval(() => void sweepStageRooms(), 60_000).unref?.();
  setTimeout(pump, 0);
  if (egressConfig() || hasPendingVideos()) {
    setInterval(() => void pollVideos(), VIDEO_POLL_MS).unref?.();
    setTimeout(() => void pollVideos(), 1000);
  }
}

async function sweepStageRooms(): Promise<void> {
  if (queue.stagesBusy) return;
  queue.stagesBusy = true;
  try {
    for (const o of await sweepStages(saveStageOnClose)) if (o.action === "closed") console.info(`[stage] closed ${o.room}`);
  } catch (e) {
    log("stage sweep failed", e);
  } finally {
    queue.stagesBusy = false;
  }
}

const hasPendingVideos = () => {
  try {
    return pendingVideos().length > 0;
  } catch {
    return false;
  }
};

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
        const bytes = new TextEncoder().encode(markdown);
        drive = await saveToDrive(session, fileName(m, "md"), "text/markdown", () =>
          uploadStream(bytes.buffer as ArrayBuffer, "text/markdown"),
        );
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

function fileName(m: JobMeeting, ext: "md" | "mp4"): string {
  const { date, time } = formatWhen(m.summary.startedAt, m.timeZone);
  // Stalwart rejects ':' (and other reserved characters) in FileNode names: "14:05" → "14.05".
  const title = m.summary.title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return `${date} ${time.replace(/:/g, ".")} ${title || m.summary.room}.${ext}`;
}

/**
 * The starter's stored access token while it is still valid, else null ("drive_session_expired":
 * Retry on the recording page stores the starter's current one). Never refreshed here: a refresh
 * token copy presented after the browser rotated it makes Stalwart revoke the user's whole grant.
 * The copy is kept fresh by recording uploads, stop, Retry and the open recording page.
 */
async function starterSession(m: JobMeeting): Promise<Session | null> {
  const session = await unseal<Session>(m.sealedSession ?? undefined);
  if (!session || needsRefresh(session)) return null;
  return { ...session, refreshToken: undefined };
}

/** Uploads a blob (via `upload`) into the starter's "Meetings" folder as `name`. */
async function saveToDrive(
  session: Session,
  name: string,
  type: string,
  upload: () => Promise<{ blobId: string; size: number }>,
): Promise<{ fileId: string; folderId: string }> {
  return runWithSession(session, async () => {
    const top = await listChildren(null);
    const folder =
      top.find((n) => n.isFolder && n.name.trim().toLowerCase() === DRIVE_FOLDER.toLowerCase()) ??
      (await createFolder(null, DRIVE_FOLDER));
    const blob = await upload();
    const file = await createFile(folder.id, name, { ...blob, type });
    return { fileId: file.id, folderId: folder.id };
  });
}

/* ------------------------------------------------------------------- video */

/** Asks LiveKit to stop a recording's video egress (no-op without one). Never throws. */
export async function stopVideo(id: string): Promise<void> {
  const v = videoEgress(id);
  if (!v || v.videoStatus !== "recording") return;
  setVideoEnding(id);
  const cfg = egressConfig();
  if (!cfg) return;
  try {
    await stopEgress(cfg, v.egressId);
  } catch (e) {
    // The poller sees the egress still active and tries again.
    log(`stopping the video egress of ${id} failed`, e);
  }
}

/** One poll: follow every pending egress, then upload finished MP4s (one at a time). */
async function pollVideos(): Promise<void> {
  if (queue.videoBusy) return;
  queue.videoBusy = true;
  try {
    for (const v of pendingVideos()) {
      try {
        if (v.videoStatus === "uploading") await uploadVideo(v);
        else await followEgress(v);
      } catch (e) {
        log(`video of ${v.id}`, e);
      }
    }
  } catch (e) {
    log("video poll failed", e);
  } finally {
    queue.videoBusy = false;
  }
}

async function followEgress(v: PendingVideo): Promise<void> {
  if (!v.egressId) return setVideoFailed(v.id, "egress_missing");
  const cfg = egressConfig();
  if (!cfg) return setVideoFailed(v.id, "not_configured");
  const info = await getEgress(cfg, v.egressId);
  if (!info) return setVideoFailed(v.id, "egress_lost");
  switch (info.state) {
    case "starting":
    case "active":
      // The recording ended (stop, stale sweep, replaced) but the egress is still running.
      if (v.meetingStatus !== "recording") {
        setVideoEnding(v.id);
        await stopEgress(cfg, v.egressId);
      }
      return;
    case "ending":
      return setVideoEnding(v.id);
    case "complete":
    case "limit_reached": {
      const size = await stat(videoPath(v.id)).then(
        (s) => s.size,
        () => -1,
      );
      if (size <= 0) return setVideoFailed(v.id, "video_file_missing");
      return setVideoUploading(v.id, size);
    }
    case "failed":
    case "aborted":
      return setVideoFailed(v.id, info.error ? `egress_${info.state}: ${info.error}` : `egress_${info.state}`);
  }
}

async function uploadVideo(v: PendingVideo): Promise<void> {
  if (Date.now() < v.nextAt) return;
  // One Drive upload per meeting at a time: wait for its transcript job.
  if (queue.running === v.id) return;
  const loaded = jobMeeting(v.id);
  if (!loaded) return;
  const m = withTitle(loaded);
  const path = videoPath(v.id);
  const present = await stat(path).then(
    () => true,
    () => false,
  );
  if (!present) return setVideoFailed(v.id, "video_file_missing");
  const session = await starterSession(m);
  if (!session) return setVideoFailed(v.id, "drive_session_expired");
  try {
    const drive = await saveToDrive(session, fileName(m, "mp4"), "video/mp4", () => uploadFile(path, "video/mp4"));
    setVideoReady(v.id, drive);
    await rm(path, { force: true }).catch((e) => log(`removing the local video of ${v.id} failed`, e));
  } catch (e) {
    log(`saving the video of ${v.id} to Drive failed`, e);
    const tooLarge = e instanceof DriveError && e.code === "too_large";
    const attempts = v.attempts + 1;
    if (tooLarge || attempts >= VIDEO_MAX_ATTEMPTS) return setVideoFailed(v.id, tooLarge ? "drive_too_large" : "drive_failed");
    setVideoRetry(v.id, "drive_failed", attempts, Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** (attempts - 1)));
  }
}
