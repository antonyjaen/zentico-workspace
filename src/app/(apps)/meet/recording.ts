// Client-safe recording types, limits and formatting (shared by the in-call recorder, the
// recordings pages and src/lib/meetings).

export type MeetingStatus = "recording" | "processing" | "ready" | "failed";

export type MeetingPerson = { email: string; name: string };

/** Video (room-composite MP4) of a recording; "processing" covers encoding and the Drive upload. */
export type VideoStatus = "recording" | "processing" | "ready" | "failed";
export type MeetingVideo = {
  status: VideoStatus;
  /** Machine-readable reason (failed, or a Drive upload that is being retried). */
  error: string | null;
  /** The MP4 in the starter's Drive once uploaded. */
  fileId: string | null;
  folderId: string | null;
  bytes: number | null;
};

export type MeetingSummary = {
  id: string;
  /** LiveKit room code the recording was made in. */
  room: string;
  title: string;
  /** Email of the participant who started the recording (the transcript goes to their Drive). */
  startedBy: string;
  startedByName: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601; null while recording. */
  endedAt: string | null;
  durationSeconds: number | null;
  status: MeetingStatus;
  /** Machine-readable reason when status is "failed" (e.g. "not_configured", "transcription_failed"). */
  error: string | null;
  participants: MeetingPerson[];
  driveFileId: string | null;
  driveFolderId: string | null;
  /** Null when only audio was recorded. */
  video: MeetingVideo | null;
  /** App-relative link to the recording page. */
  url: string;
};

export type TranscriptSegment = { start: number; end: number; speaker: string; text: string };

export type AudioSegment = { id: number; identity: string; name: string; offsetSeconds: number; mime: string; bytes: number };

export type MeetingDetail = {
  meeting: MeetingSummary;
  segments: TranscriptSegment[];
  markdown: string;
  audio: AudioSegment[];
  isStarter: boolean;
};

/** Recording state travels over the reliable data channel under this topic. */
export const REC_TOPIC = "zw-rec";
export type RecSignal =
  | { type: "state"; recording: true; id: string; elapsedMs: number; video?: boolean }
  | { type: "state"; recording: false; id: string };

export const MEETING_ID = /^[A-Za-z0-9_-]{16,40}$/;
export const SEGMENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** How often recorders hand over audio (and thus the most a crash or reload can lose). */
export const CHUNK_INTERVAL_MS = 15_000;
export const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const MEETING_MAX_BYTES = 200 * 1024 * 1024;
export const MAX_SEGMENTS = 400;
export const AUDIO_BITRATE = 32_000;
export const AUDIO_MIMES = ["audio/webm", "audio/ogg", "audio/mp4"] as const;

export const recordingHref = (id: string) => `/meet/recordings/${id}`;

/** 75 → "01:15", 3725 → "1:02:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
