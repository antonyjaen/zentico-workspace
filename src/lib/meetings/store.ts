// Meeting recordings: metadata, access control and audio files. Server-only.
//
// Public contract (used by the MCP server):
//   listMeetings(userEmail, { limit })  → recordings the user may read, newest first
//   getTranscript(id, userEmail)        → { meeting, segments, markdown } or null (missing / no access)
//
// Who may read a recording: the person who started it plus every speaker whose audio was
// uploaded (LiveKit identities are the users' emails). Only the starter uploads audio.
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomToken } from "../crypto";
import { sealSession, type Session } from "../session";

/**
 * Seals the starter's credentials for the background jobs: the access token only. The refresh
 * token stays with the browser session: Stalwart rotates it and revokes the whole grant (signing
 * the user out) when a superseded copy is presented, so jobs must never refresh a copy.
 */
const sealForJobs = (session: Session) => sealSession({ ...session, refreshToken: undefined });
import { all, get, meetingsDir, num, numOrNull, run, str, strOrNull, tx, type Row } from "./db";
import {
  AUDIO_MIMES,
  MAX_SEGMENTS,
  MEETING_ID,
  MEETING_MAX_BYTES,
  recordingHref,
  type AudioSegment,
  type MeetingDetail,
  type MeetingPerson,
  type MeetingStatus,
  type MeetingSummary,
  type MeetingVideo,
  type TranscriptSegment,
  type VideoStatus,
} from "@/app/(apps)/meet/recording";
import { videoPath } from "./egress";

export type { MeetingDetail, MeetingStatus, MeetingSummary, TranscriptSegment };

export class RecordingError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "busy" | "not_recording" | "too_large" | "out_of_order" | "invalid",
  ) {
    super(code);
  }
}

/** A recording whose recorder went silent this long is considered abandoned (and finalized). */
export const STALE_MS = 3 * 60_000;
/** Re-seal the starter's session on uploads at most this often. */
const SESSION_REFRESH_MS = 5 * 60_000;

const norm = (email: string) => email.trim().toLowerCase();

function parsePeople(v: unknown): MeetingPerson[] {
  try {
    const list: unknown = JSON.parse(typeof v === "string" ? v : "[]");
    return Array.isArray(list)
      ? list.filter((p): p is MeetingPerson => !!p && typeof p.email === "string" && typeof p.name === "string")
      : [];
  } catch {
    return [];
  }
}

/** Video states still owned by the background poller. */
const VIDEO_PENDING = "('recording', 'processing', 'uploading')";

function toVideo(r: Row): MeetingVideo | null {
  const raw = strOrNull(r.video_status);
  if (!raw) return null;
  const status: VideoStatus = raw === "uploading" ? "processing" : (raw as VideoStatus);
  return {
    status,
    error: strOrNull(r.video_error),
    fileId: strOrNull(r.video_file_id),
    folderId: strOrNull(r.video_folder_id),
    bytes: numOrNull(r.video_bytes),
  };
}

function toSummary(r: Row): MeetingSummary {
  const startedAt = num(r.started_at);
  const endedAt = numOrNull(r.ended_at);
  const id = str(r.id);
  return {
    id,
    room: str(r.room),
    title: str(r.title) || str(r.room),
    startedBy: str(r.started_by),
    startedByName: str(r.started_by_name) || str(r.started_by),
    startedAt: new Date(startedAt).toISOString(),
    endedAt: endedAt ? new Date(endedAt).toISOString() : null,
    durationSeconds: endedAt ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : null,
    status: str(r.status) as MeetingStatus,
    error: strOrNull(r.error),
    participants: parsePeople(r.participants),
    driveFileId: strOrNull(r.drive_file_id),
    driveFolderId: strOrNull(r.drive_folder_id),
    video: toVideo(r),
    url: recordingHref(id),
  };
}

function parseTranscript(v: unknown): TranscriptSegment[] {
  if (typeof v !== "string") return [];
  try {
    const list: unknown = JSON.parse(v);
    return Array.isArray(list) ? (list as TranscriptSegment[]) : [];
  } catch {
    return [];
  }
}

const canRead = (id: string, email: string) =>
  !!get("SELECT 1 AS x FROM meeting_people WHERE meeting_id = ? AND email = ?", id, norm(email));

function readable(id: string, email: string): Row | null {
  if (!MEETING_ID.test(id) || !canRead(id, email)) return null;
  return get("SELECT * FROM meetings WHERE id = ?", id) ?? null;
}

/* ------------------------------------------------------------ public contract */

/** Recordings the user started or spoke in, newest first. */
export async function listMeetings(userEmail: string, opts: { limit?: number } = {}): Promise<MeetingSummary[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 500);
  return all(
    `SELECT m.* FROM meetings m JOIN meeting_people p ON p.meeting_id = m.id
     WHERE p.email = ? ORDER BY m.started_at DESC LIMIT ?`,
    norm(userEmail),
    limit,
  ).map(toSummary);
}

/**
 * The transcript of one recording, or null when it doesn't exist or the user may not read it.
 * While the recording is still being recorded/processed (or failed), `segments` is empty and
 * `markdown` is "" — check `meeting.status`.
 */
export async function getTranscript(
  id: string,
  userEmail: string,
): Promise<{ meeting: MeetingSummary; segments: TranscriptSegment[]; markdown: string } | null> {
  const r = readable(id, userEmail);
  if (!r) return null;
  return { meeting: toSummary(r), segments: parseTranscript(r.transcript), markdown: str(r.markdown) };
}

/* ----------------------------------------------------------------- app reads */

export function getMeetingDetail(id: string, userEmail: string): MeetingDetail | null {
  const r = readable(id, userEmail);
  if (!r) return null;
  const audio: AudioSegment[] = all("SELECT * FROM segments WHERE meeting_id = ? AND bytes > 0 ORDER BY offset_ms, id", id).map(
    (s) => ({
      id: num(s.id),
      identity: str(s.identity),
      name: str(s.name) || str(s.identity),
      offsetSeconds: num(s.offset_ms) / 1000,
      mime: str(s.mime),
      bytes: num(s.bytes),
    }),
  );
  return {
    meeting: toSummary(r),
    segments: parseTranscript(r.transcript),
    markdown: str(r.markdown),
    audio,
    isStarter: norm(str(r.started_by)) === norm(userEmail),
  };
}

const extOf = (mime: string) => (mime === "audio/ogg" ? "ogg" : mime === "audio/mp4" ? "m4a" : "webm");
const segmentPath = (meetingId: string, segId: number, mime: string) =>
  join(meetingsDir(), meetingId, `${segId}.${extOf(mime)}`);

/** An audio segment on disk (auth-checked), or null. */
export async function audioFile(
  id: string,
  segId: number,
  userEmail: string,
): Promise<{ path: string; size: number; mime: string } | null> {
  if (!readable(id, userEmail)) return null;
  const s = get("SELECT * FROM segments WHERE meeting_id = ? AND id = ?", id, segId);
  if (!s) return null;
  const path = segmentPath(id, segId, str(s.mime));
  try {
    return { path, size: (await stat(path)).size, mime: str(s.mime) };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- recording */

const activeIn = (room: string) =>
  get("SELECT * FROM meetings WHERE room = ? AND status = 'recording' ORDER BY started_at DESC LIMIT 1", room);

/** Starts a recording. Fails with "busy" when someone else is already recording this room. */
export async function startRecording(input: {
  room: string;
  title: string;
  timeZone: string | null;
  session: Session;
}): Promise<{ id: string; startedAt: number; replaced: string | null }> {
  const { session } = input;
  const now = Date.now();
  let replaced: string | null = null;
  const current = activeIn(input.room);
  if (current && now - num(current.last_activity) < STALE_MS) {
    if (norm(str(current.started_by)) !== norm(session.email)) throw new RecordingError("busy");
    // The same person starting again (e.g. after a reload): close the previous one.
    replaced = str(current.id);
  } else if (current) {
    replaced = str(current.id);
  }
  if (replaced) finalize(replaced);

  const id = randomToken(18);
  const sealed = await sealForJobs(session);
  const me: MeetingPerson = { email: session.email, name: session.name || session.email };
  tx(() => {
    run(
      `INSERT INTO meetings (id, room, title, started_by, started_by_name, started_at, last_activity, time_zone,
        participants, status, starter_session, session_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?)`,
      id,
      input.room,
      input.title,
      session.email,
      me.name,
      now,
      now,
      input.timeZone,
      JSON.stringify([me]),
      sealed,
      now,
    );
    run("INSERT INTO meeting_people (meeting_id, email) VALUES (?, ?)", id, norm(session.email));
  });
  return { id, startedAt: now, replaced };
}

// One upload at a time per segment: the sequence check and the file append must not interleave.
const g = globalThis as typeof globalThis & { __zwMeetLocks?: Map<string, Promise<unknown>> };
const locks = (g.__zwMeetLocks ??= new Map());
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

export type ChunkInput = {
  id: string;
  session: Session;
  segment: { clientId: string; identity: string; name: string; offsetMs: number; mime: string };
  seq: number;
  data: Uint8Array;
};

/**
 * Appends one chunk to a speaker segment. Chunks of a segment must arrive in order (seq 0, 1, …);
 * a repeated chunk (client retry) is acknowledged without being written twice.
 */
export async function addChunk(input: ChunkInput): Promise<{ duplicate: boolean }> {
  const { id, session, segment, seq, data } = input;
  if (!(AUDIO_MIMES as readonly string[]).includes(segment.mime)) throw new RecordingError("invalid");
  return withLock(`${id}:${segment.clientId}`, async () => {
    const m = get("SELECT * FROM meetings WHERE id = ?", id);
    if (!m) throw new RecordingError("not_found");
    if (norm(str(m.started_by)) !== norm(session.email)) throw new RecordingError("forbidden");
    if (str(m.status) !== "recording") throw new RecordingError("not_recording");
    if (num(m.bytes) + data.byteLength > MEETING_MAX_BYTES) throw new RecordingError("too_large");

    let s = get("SELECT * FROM segments WHERE meeting_id = ? AND client_id = ?", id, segment.clientId);
    if (!s) {
      if (seq !== 0) throw new RecordingError("out_of_order");
      const count = num(get("SELECT count(*) AS n FROM segments WHERE meeting_id = ?", id)?.n);
      if (count >= MAX_SEGMENTS) throw new RecordingError("too_large");
      s = tx(() => {
        run(
          `INSERT INTO segments (meeting_id, client_id, identity, name, offset_ms, mime, created) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          segment.clientId,
          segment.identity,
          segment.name,
          Math.max(0, Math.round(segment.offsetMs)),
          segment.mime,
          Date.now(),
        );
        const people = parsePeople(m.participants);
        const email = norm(segment.identity);
        if (!people.some((p) => norm(p.email) === email)) {
          people.push({ email: segment.identity, name: segment.name || segment.identity });
          run("UPDATE meetings SET participants = ? WHERE id = ?", JSON.stringify(people), id);
        }
        run("INSERT OR IGNORE INTO meeting_people (meeting_id, email) VALUES (?, ?)", id, email);
        return get("SELECT * FROM segments WHERE meeting_id = ? AND client_id = ?", id, segment.clientId)!;
      });
    }
    const expected = num(s.next_seq);
    if (seq < expected) return { duplicate: true };
    if (seq > expected) throw new RecordingError("out_of_order");

    const segId = num(s.id);
    await mkdir(join(meetingsDir(), id), { recursive: true });
    await appendFile(segmentPath(id, segId, str(s.mime)), data);
    const now = Date.now();
    run("UPDATE segments SET next_seq = ?, bytes = bytes + ? WHERE id = ?", seq + 1, data.byteLength, segId);
    run("UPDATE meetings SET bytes = bytes + ?, last_activity = ? WHERE id = ?", data.byteLength, now, id);
    // Keep a recent copy of the starter's credentials for the background job.
    if (now - num(m.session_at) > SESSION_REFRESH_MS) {
      run("UPDATE meetings SET starter_session = ?, session_at = ? WHERE id = ?", await sealForJobs(session), now, id);
    }
    return { duplicate: false };
  });
}

/** Keeps an active recording alive while no audio is being uploaded (starter only). */
export function touchRecording(id: string, userEmail: string): void {
  const m = MEETING_ID.test(id) ? get("SELECT started_by, status FROM meetings WHERE id = ?", id) : undefined;
  if (!m) throw new RecordingError("not_found");
  if (norm(str(m.started_by)) !== norm(userEmail)) throw new RecordingError("forbidden");
  if (str(m.status) !== "recording") throw new RecordingError("not_recording");
  run("UPDATE meetings SET last_activity = ? WHERE id = ?", Date.now(), id);
}

/** Marks a recording finished (status → processing). Returns false if it wasn't recording. */
function finalize(id: string, endedAt = Date.now()): boolean {
  const r = run(
    "UPDATE meetings SET status = 'processing', error = NULL, ended_at = coalesce(ended_at, ?) WHERE id = ? AND status = 'recording'",
    endedAt,
    id,
  );
  return Number(r.changes) > 0;
}

/** Stops a recording (starter only) and stores their latest session for the Drive upload. */
export async function stopRecording(id: string, session: Session): Promise<{ stopped: boolean }> {
  const m = MEETING_ID.test(id) ? get("SELECT * FROM meetings WHERE id = ?", id) : undefined;
  if (!m) throw new RecordingError("not_found");
  if (norm(str(m.started_by)) !== norm(session.email)) throw new RecordingError("forbidden");
  if (str(m.status) !== "recording") return { stopped: false };
  run("UPDATE meetings SET starter_session = ?, session_at = ? WHERE id = ?", await sealForJobs(session), Date.now(), id);
  return { stopped: finalize(id) };
}

/** Re-queues a failed transcription or Drive upload (any reader may ask). */
export async function retryMeeting(id: string, userEmail: string, session: Session | null): Promise<void> {
  const m = readable(id, userEmail);
  if (!m) throw new RecordingError("not_found");
  // Failed transcriptions, and finished ones whose Drive copy couldn't be saved.
  const driveMissing = str(m.status) === "ready" && !strOrNull(m.drive_file_id) && !!strOrNull(m.error);
  const transcriptRetry = str(m.status) === "failed" || driveMissing;
  // A video whose Drive upload gave up (the MP4 is still on disk).
  const videoRetry =
    str(m.video_status) === "failed" &&
    ["drive_failed", "drive_session_expired"].includes(str(m.video_error)) &&
    (await exists(videoPath(id)));
  if (!transcriptRetry && !videoRetry) throw new RecordingError("invalid");
  // A fresh session from the starter helps when their stored one expired.
  if (session && norm(session.email) === norm(str(m.started_by))) {
    run("UPDATE meetings SET starter_session = ?, session_at = ? WHERE id = ?", await sealForJobs(session), Date.now(), id);
  }
  if (transcriptRetry) run("UPDATE meetings SET status = 'processing', error = NULL WHERE id = ?", id);
  if (videoRetry) {
    run(
      "UPDATE meetings SET video_status = 'uploading', video_error = NULL, video_attempts = 0, video_next_at = 0 WHERE id = ?",
      id,
    );
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Deletes a recording and its audio (starter only). Copies already saved to Drive stay. */
export async function deleteMeeting(id: string, userEmail: string): Promise<void> {
  const m = readable(id, userEmail);
  if (!m) throw new RecordingError("not_found");
  if (norm(str(m.started_by)) !== norm(userEmail)) throw new RecordingError("forbidden");
  if (str(m.status) === "processing") throw new RecordingError("invalid");
  if (["recording", "processing", "uploading"].includes(str(m.video_status))) throw new RecordingError("invalid");
  run("DELETE FROM meetings WHERE id = ?", id);
  await rm(join(meetingsDir(), id), { recursive: true, force: true });
  await rm(videoPath(id), { force: true });
}

/* ------------------------------------------------------------- job helpers */

export type JobMeeting = {
  id: string;
  summary: MeetingSummary;
  timeZone: string | null;
  sealedSession: string | null;
  driveFileId: string | null;
  segments: { id: number; identity: string; name: string; offsetMs: number; mime: string; bytes: number; path: string }[];
};

export function jobMeeting(id: string): JobMeeting | null {
  const m = get("SELECT * FROM meetings WHERE id = ?", id);
  if (!m) return null;
  return {
    id,
    summary: toSummary(m),
    timeZone: strOrNull(m.time_zone),
    sealedSession: strOrNull(m.starter_session),
    driveFileId: strOrNull(m.drive_file_id),
    segments: all("SELECT * FROM segments WHERE meeting_id = ? AND bytes > 0 ORDER BY offset_ms, id", id).map((s) => ({
      id: num(s.id),
      identity: str(s.identity),
      name: str(s.name) || str(s.identity),
      offsetMs: num(s.offset_ms),
      mime: str(s.mime),
      bytes: num(s.bytes),
      path: segmentPath(id, num(s.id), str(s.mime)),
    })),
  };
}

export const setTitle = (id: string, title: string) => run("UPDATE meetings SET title = ? WHERE id = ?", title, id);

export const storedMarkdown = (id: string): string => str(get("SELECT markdown FROM meetings WHERE id = ?", id)?.markdown);

export function saveTranscript(id: string, segments: TranscriptSegment[], markdown: string) {
  run("UPDATE meetings SET transcript = ?, markdown = ? WHERE id = ?", JSON.stringify(segments), markdown, id);
}

export function markReady(id: string, drive: { fileId: string; folderId: string | null } | null, error: string | null) {
  run(
    `UPDATE meetings SET status = 'ready', error = ?, drive_file_id = coalesce(?, drive_file_id),
       drive_folder_id = coalesce(?, drive_folder_id),
       starter_session = CASE WHEN ? IS NULL OR video_status IN ${VIDEO_PENDING} THEN starter_session ELSE NULL END
     WHERE id = ?`,
    error,
    drive?.fileId ?? null,
    drive?.folderId ?? null,
    drive?.fileId ?? null,
    id,
  );
}

export function markFailed(id: string, error: string) {
  run("UPDATE meetings SET status = 'failed', error = ? WHERE id = ?", error.slice(0, 200), id);
}

/**
 * While the starter has the recording page open and Drive work is still pending (transcript or
 * video), keeps the jobs' copy of their access token fresh (the page polls; throttled).
 */
export async function refreshStarterSession(id: string, session: Session): Promise<void> {
  const m = MEETING_ID.test(id)
    ? get("SELECT started_by, status, drive_file_id, video_status, session_at FROM meetings WHERE id = ?", id)
    : undefined;
  if (!m || norm(str(m.started_by)) !== norm(session.email)) return;
  const pending =
    ["recording", "processing"].includes(str(m.status)) ||
    (str(m.status) === "ready" && !strOrNull(m.drive_file_id)) ||
    ["recording", "processing", "uploading"].includes(str(m.video_status));
  if (!pending || Date.now() - num(m.session_at) < SESSION_REFRESH_MS) return;
  run("UPDATE meetings SET starter_session = ?, session_at = ? WHERE id = ?", await sealForJobs(session), Date.now(), id);
}

/** Recordings whose recorder vanished (tab crash, network loss): finalize them. Returns their ids. */
export function finalizeStale(): string[] {
  const cutoff = Date.now() - STALE_MS;
  const ids = all("SELECT id, last_activity FROM meetings WHERE status = 'recording' AND last_activity < ?", cutoff);
  return ids.filter((r) => finalize(str(r.id), num(r.last_activity))).map((r) => str(r.id));
}

export const processingIds = () => all("SELECT id FROM meetings WHERE status = 'processing' ORDER BY started_at").map((r) => str(r.id));

/* --------------------------------------------------------------- video */

/** The egress of a recording's video, if any (for stopping it). */
export function videoEgress(id: string): { egressId: string; videoStatus: string } | null {
  const r = get("SELECT egress_id, video_status FROM meetings WHERE id = ?", id);
  const egressId = strOrNull(r?.egress_id);
  return egressId ? { egressId, videoStatus: str(r?.video_status) } : null;
}

export function setVideoStarted(id: string, egressId: string) {
  run("UPDATE meetings SET egress_id = ?, video_status = 'recording', video_error = NULL WHERE id = ?", egressId, id);
}

/** recording → processing (egress asked to stop / ended); other states are left alone. */
export function setVideoEnding(id: string) {
  run("UPDATE meetings SET video_status = 'processing' WHERE id = ? AND video_status = 'recording'", id);
}

export function setVideoUploading(id: string, bytes: number) {
  run(
    "UPDATE meetings SET video_status = 'uploading', video_bytes = ?, video_error = NULL, video_attempts = 0, video_next_at = 0 WHERE id = ?",
    bytes,
    id,
  );
}

export function setVideoFailed(id: string, error: string) {
  run("UPDATE meetings SET video_status = 'failed', video_error = ? WHERE id = ?", error.slice(0, 200), id);
}

/** A failed Drive upload attempt: keeps the video queued, retried at `nextAt`. */
export function setVideoRetry(id: string, error: string, attempts: number, nextAt: number) {
  run(
    "UPDATE meetings SET video_error = ?, video_attempts = ?, video_next_at = ? WHERE id = ?",
    error.slice(0, 200),
    attempts,
    nextAt,
    id,
  );
}

/** The MP4 is in Drive. Drops the starter's session once the transcript no longer needs it. */
export function setVideoReady(id: string, drive: { fileId: string; folderId: string }) {
  run(
    `UPDATE meetings SET video_status = 'ready', video_error = NULL, video_file_id = ?, video_folder_id = ?,
       starter_session = CASE WHEN status = 'ready' AND drive_file_id IS NOT NULL THEN NULL ELSE starter_session END
     WHERE id = ?`,
    drive.fileId,
    drive.folderId,
    id,
  );
}

export type PendingVideo = {
  id: string;
  meetingStatus: string;
  videoStatus: "recording" | "processing" | "uploading";
  egressId: string | null;
  attempts: number;
  nextAt: number;
};

/** Videos the poller still has to follow (egress running/finishing, or waiting for Drive). */
export function pendingVideos(): PendingVideo[] {
  return all(
    `SELECT id, status, video_status, egress_id, video_attempts, video_next_at FROM meetings
     WHERE video_status IN ${VIDEO_PENDING} ORDER BY started_at`,
  ).map((r) => ({
    id: str(r.id),
    meetingStatus: str(r.status),
    videoStatus: str(r.video_status) as PendingVideo["videoStatus"],
    egressId: strOrNull(r.egress_id),
    attempts: num(r.video_attempts),
    nextAt: num(r.video_next_at),
  }));
}
