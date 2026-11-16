// One utterance (≤ 20 s clip, cut by voice activity detection in the browser) of the signed-in
// user's OWN microphone, sent while their "Claude commands" toggle is on. The audio is transcribed
// in memory (never written to disk or logged) and dropped; "Claude, …" at the start of an utterance
// queues a command for that user's own bridge. Clips wait in a per-user FIFO queue (see
// enterClipQueue) because CPU Whisper takes ~20 s per clip.
// Multipart fields: room, file, mime, duration (ms), timeZone.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { createCommand, cleanTimeZone, hasWriteToken } from "@/lib/meetings/claude-commands";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { transcribeAudio, whisperConfig } from "@/lib/meetings/transcribe";
import { clipLanguage, controlOf, enterClipQueue, findCommand, learnLanguage, takeClipSlot } from "@/lib/meetings/voice";
import {
  addUtterance,
  cancelCommand,
  decideConfirmation,
  latestActiveCommand,
  latestPendingConfirmation,
  toView,
} from "@/lib/mcp/agent";
import type { Session } from "@/lib/session";
import { VOICE_MAX_BYTES, VOICE_MAX_CLIP_MS, VOICE_MIN_INTERVAL_MS, type VoiceResponse } from "@/app/(apps)/meet/claude";
import { AUDIO_MIMES } from "@/app/(apps)/meet/recording";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WHISPER_TIMEOUT_MS = 60_000;
/** The browser stops the recorder at VOICE_MAX_CLIP_MS; allow for stop latency. */
const MAX_DURATION_MS = VOICE_MAX_CLIP_MS + 2000;

const respond = (body: VoiceResponse) => NextResponse.json(body, { headers: NO_STORE });

/** Queues a voice command; "Claude confirm/cancel" act on pending items. */
function handleCommand(session: Session, room: string, text: string, timeZone: string | null, heard: string): VoiceResponse {
  const control = controlOf(text);
  if (control) {
    const pending = latestPendingConfirmation(session.email);
    if (pending) {
      decideConfirmation(pending.id, session.email, control === "confirm");
      return { ok: true, heard, action: control === "confirm" ? "approved" : "rejected" };
    }
    if (control === "cancel") {
      const active = latestActiveCommand(session.email, room);
      if (active && cancelCommand(active.id, session.email)) return { ok: true, heard, action: "cancelled" };
    }
    return { ok: true, heard };
  }
  const { command } = createCommand(session, { room, text, source: "voice", timeZone });
  return { ok: true, heard, command: toView(command) };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > VOICE_MAX_BYTES + 16 * 1024) return jsonError("too_large", 413);
  if (!takeClipSlot(session.email, VOICE_MIN_INTERVAL_MS)) return jsonError("rate_limited", 429);
  if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
  const cfg = whisperConfig();
  if (!cfg) return jsonError("not_configured", 503);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("invalid", 400);
  }
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const room = field("room");
  const mime = field("mime").split(";")[0].trim().toLowerCase();
  const durationMs = Number(field("duration"));
  const timeZone = cleanTimeZone(field("timeZone"));
  const file = form.get("file");
  if (
    !ROOM_PATTERN.test(room) ||
    !(AUDIO_MIMES as readonly string[]).includes(mime) ||
    !Number.isFinite(durationMs) ||
    durationMs < 500 ||
    durationMs > MAX_DURATION_MS ||
    !(file instanceof Blob) ||
    file.size === 0
  ) {
    return jsonError("invalid", 400);
  }
  if (file.size > VOICE_MAX_BYTES) return jsonError("too_large", 413);

  // Wait for this user's earlier clips (FIFO) and a free transcription slot.
  const release = await enterClipQueue(session.email, req.signal);
  if (!release) return jsonError("superseded", 429);

  // Pinned after the speaker's first clips in this room (detection doubles Whisper's time).
  const pinned = clipLanguage(session.email, room);
  let result;
  try {
    let audio: Uint8Array | null = new Uint8Array(await file.arrayBuffer());
    try {
      result = await transcribeAudio(cfg, audio, mime, { timeoutMs: WHISPER_TIMEOUT_MS, prompt: "Claude,", language: pinned });
    } finally {
      audio = null; // drop the clip right away
    }
  } catch (e) {
    // Only the status/summary, never the audio.
    console.error("[voice] transcription:", e instanceof Error ? e.message.slice(0, 200) : "failed");
    return jsonError("transcription_failed", 502);
  } finally {
    release();
  }

  const segments = result.segments;
  const heardChars = segments.reduce((n, x) => n + x.text.length, 0);
  if (!pinned) learnLanguage(session.email, room, result.language, heardChars);
  console.info(`[voice] lang=${result.language ?? "?"}${pinned ? " (pinned)" : ""} heard=${heardChars}ch`);
  const heard = segments.map((s) => s.text).join(" ").trim();
  if (heard) addUtterance(session.email, room, heard);

  try {
    const command = heard ? findCommand(segments) : null;
    if (!command) return respond({ ok: true, heard });
    return respond(handleCommand(session, room, command, timeZone, heard));
  } catch (e) {
    console.error("[voice] command:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
