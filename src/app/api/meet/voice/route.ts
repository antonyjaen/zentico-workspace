// Voice clips from a call, transcribed in memory (never written to disk or logged) and dropped.
// - kind=command: one push-to-talk clip (≤ 20 s) of the signed-in user's OWN voice. The whole
//   transcript is the command (an optional leading "Claude, …" is stripped) for their own bridge;
//   "confirm" / "cancel" act on pending items.
// - kind=context: ~15 s of the meeting's mixed audio, sent while the user's "Claude listens to the
//   meeting" toggle is on (announced to everyone in the call). Only stored as prompt context for
//   that user's commands; never parsed for commands.
// CPU Whisper takes ~11 s per clip, so clips wait in a queue where commands go first (see
// enterClipQueue in src/lib/meetings/voice.ts).
// Multipart fields: kind, room, file, mime, duration (ms), timeZone.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { createCommand, cleanTimeZone, hasWriteToken } from "@/lib/meetings/claude-commands";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { transcribeAudio, whisperConfig } from "@/lib/meetings/transcribe";
import { clipLanguage, commandText, controlOf, enterClipQueue, learnLanguage, takeClipSlot, type ClipKind } from "@/lib/meetings/voice";
import {
  addUtterance,
  cancelCommand,
  decideConfirmation,
  latestActiveCommand,
  latestPendingConfirmation,
  toView,
} from "@/lib/mcp/agent";
import type { Session } from "@/lib/session";
import {
  CONTEXT_CHUNK_MS,
  CONTEXT_MIN_INTERVAL_MS,
  VOICE_MAX_BYTES,
  VOICE_MAX_CLIP_MS,
  VOICE_MIN_INTERVAL_MS,
  type VoiceResponse,
} from "@/app/(apps)/meet/claude";
import { AUDIO_MIMES } from "@/app/(apps)/meet/recording";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WHISPER_TIMEOUT_MS = 60_000;
/** The browser stops recorders at these lengths; allow for stop latency. */
const MAX_DURATION_MS: Record<ClipKind, number> = { command: VOICE_MAX_CLIP_MS + 2000, context: CONTEXT_CHUNK_MS + 3000 };
const MIN_INTERVAL_MS: Record<ClipKind, number> = { command: VOICE_MIN_INTERVAL_MS, context: CONTEXT_MIN_INTERVAL_MS };

const respond = (body: VoiceResponse) => NextResponse.json(body, { headers: NO_STORE });

/** Queues a voice command; "confirm" / "cancel" act on pending items. */
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
  // Required: clients from before push-to-talk sent every utterance without a kind.
  const kindField = field("kind");
  if (kindField !== "command" && kindField !== "context") return jsonError("invalid", 400);
  const kind: ClipKind = kindField;
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
    durationMs > MAX_DURATION_MS[kind] ||
    !(file instanceof Blob) ||
    file.size === 0
  ) {
    return jsonError("invalid", 400);
  }
  if (file.size > VOICE_MAX_BYTES) return jsonError("too_large", 413);
  if (!takeClipSlot(session.email, kind, MIN_INTERVAL_MS[kind])) return jsonError("rate_limited", 429);

  // Commands first; a waiting context chunk is replaced by a newer one.
  const release = await enterClipQueue(session.email, kind, req.signal);
  if (!release) return jsonError("superseded", 429);

  // Pinned after the first clips of each kind in this room (detection doubles Whisper's time).
  const pinned = clipLanguage(session.email, room, kind);
  let result;
  try {
    let audio: Uint8Array | null = new Uint8Array(await file.arrayBuffer());
    try {
      result = await transcribeAudio(cfg, audio, mime, {
        timeoutMs: WHISPER_TIMEOUT_MS,
        // Biases recognition towards "Claude" in commands; not for meeting audio (it invents it on noise).
        prompt: kind === "command" ? "Claude," : undefined,
        language: pinned,
      });
    } finally {
      audio = null; // drop the clip right away
    }
  } catch (e) {
    // Only the status/summary, never the audio.
    console.error(`[voice] ${kind} transcription:`, e instanceof Error ? e.message.slice(0, 200) : "failed");
    return jsonError("transcription_failed", 502);
  } finally {
    release();
  }

  const segments = result.segments;
  const heardChars = segments.reduce((n, x) => n + x.text.length, 0);
  if (!pinned) learnLanguage(session.email, room, kind, result.language, heardChars);
  console.info(`[voice] ${kind} lang=${result.language ?? "?"}${pinned ? " (pinned)" : ""} heard=${heardChars}ch`);
  const heard = segments
    .map((s) => s.text)
    .join(" ")
    .trim();

  if (kind === "context") {
    // Meeting audio is context only: never a command, and nothing is echoed back.
    if (heard) addUtterance(session.email, room, heard, "meeting");
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  if (heard) addUtterance(session.email, room, heard, "command");
  try {
    const command = commandText(segments);
    if (!command) return respond({ ok: true, heard });
    return respond(handleCommand(session, room, command, timeZone, heard));
  } catch (e) {
    console.error("[voice] command:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
