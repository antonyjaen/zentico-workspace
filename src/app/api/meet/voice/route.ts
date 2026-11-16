// Voice clips from a call, transcribed in memory (never written to disk or logged) and dropped.
// - kind=command: one push-to-talk clip (≤ 20 s) of the signed-in user's OWN voice. The whole
//   transcript is the command (an optional leading "Claude, …" is stripped) for their own bridge;
//   "confirm" / "cancel" act on pending items. With contextMs > 0 the clip starts with the meeting
//   audio from just before the press (not yet sent as context): segments before that boundary are
//   stored as meeting context first, the rest is the command (one Whisper pass for both).
// - kind=context: ~15 s of the meeting's mixed audio, sent while the user's "Claude listens to the
//   meeting" toggle is on (announced to everyone in the call). Only stored as prompt context for
//   that user's commands; never parsed for commands.
// - JSON { kind: "command-text" | "context-text", ... } (VoiceTextRequest): the same two, already
//   transcribed in the user's browser (local Whisper on their GPU), so only text arrives: the
//   command's meeting tail (`context`) is stored first, then the command is handled as above.
// CPU Whisper takes ~11 s per clip, so clips wait in a queue where commands go first (see
// enterClipQueue in src/lib/meetings/voice.ts).
// Multipart fields: kind, room, file, mime, duration (ms), timeZone, contextMs (command only).
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
  COMMAND_MAX_CHARS,
  CONTEXT_CHUNK_MS,
  CONTEXT_MIN_INTERVAL_MS,
  CONTEXT_TAIL_MAX_MS,
  VOICE_MAX_BYTES,
  VOICE_MAX_CLIP_MS,
  VOICE_MAX_TOTAL_MS,
  VOICE_MIMES,
  VOICE_CONTEXT_MAX_CHARS,
  VOICE_MIN_INTERVAL_MS,
  type VoiceResponse,
} from "@/app/(apps)/meet/claude";
import type { TranscriptSegment } from "@/app/(apps)/meet/recording";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WHISPER_TIMEOUT_MS = 60_000;
/** The browser stops recorders at these lengths; allow for stop latency. */
const MAX_DURATION_MS: Record<ClipKind, number> = {
  command: Math.max(VOICE_MAX_CLIP_MS, VOICE_MAX_TOTAL_MS) + 2000,
  context: CONTEXT_CHUNK_MS + 5000,
};
const MIN_INTERVAL_MS: Record<ClipKind, number> = { command: VOICE_MIN_INTERVAL_MS, context: CONTEXT_MIN_INTERVAL_MS };

const respond = (body: VoiceResponse) => NextResponse.json(body, { headers: NO_STORE });

const joinText = (segments: TranscriptSegment[]) =>
  segments
    .map((s) => s.text)
    .join(" ")
    .trim();

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

/* ------------------------------------------------- text from the browser */

const TEXT_MAX_BYTES = 32 * 1024;
const LANG = /^[a-z]{2,3}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Untrusted transcript text: control characters out, whitespace collapsed; null when too long or not a string. */
function cleanTranscript(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || v.length > max) return null;
  return v.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Stores text as utterances of ≤ 2000 chars (addUtterance's limit). */
function storeText(email: string, room: string, text: string, source: "meeting" | "command") {
  for (let at = 0; at < text.length; at += 2000) addUtterance(email, room, text.slice(at, at + 2000), source);
}

async function handleText(req: NextRequest, session: Session) {
  if (Number(req.headers.get("content-length") ?? "0") > TEXT_MAX_BYTES) return jsonError("too_large", 413);
  let body: Record<string, unknown>;
  try {
    // Bounded even without a Content-Length header.
    const raw = await req.text();
    if (raw.length > TEXT_MAX_BYTES) return jsonError("too_large", 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonError("invalid", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("invalid", 400);
  }
  const kind = body.kind;
  const room = typeof body.room === "string" ? body.room : "";
  const command = kind === "command-text" ? cleanTranscript(body.command, COMMAND_MAX_CHARS) : "";
  const context = cleanTranscript(body.context, VOICE_CONTEXT_MAX_CHARS);
  const lang = typeof body.lang === "string" && LANG.test(body.lang) ? body.lang : null;
  if ((kind !== "command-text" && kind !== "context-text") || !ROOM_PATTERN.test(room) || command == null || context == null) {
    return jsonError("invalid", 400);
  }
  const clip: ClipKind = kind === "command-text" ? "command" : "context";
  if (!takeClipSlot(session.email, clip, MIN_INTERVAL_MS[clip])) return jsonError("rate_limited", 429);
  console.info(`[voice] ${clip} (local) lang=${lang ?? "?"} heard=${command.length + context.length}ch${clip === "command" && context ? " +tail" : ""}`);

  // The meeting tail first, so the command's prompt context includes it (never searched for commands).
  if (context) storeText(session.email, room, context, "meeting");
  if (clip === "context") return NextResponse.json({ ok: true }, { headers: NO_STORE });
  if (command) storeText(session.email, room, command, "command");
  try {
    const text = commandText(command);
    if (!text) return respond({ ok: true, heard: command });
    return respond(handleCommand(session, room, text, cleanTimeZone(body.timeZone), command));
  } catch (e) {
    console.error("[voice] command:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > VOICE_MAX_BYTES + 16 * 1024) return jsonError("too_large", 413);
  if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
  // Transcribed in the browser: no Whisper needed here.
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return handleText(req, session);
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
  // Where the meeting tail ends and the command starts (ms from the start of the clip); 0 = no tail.
  const contextMs = kind === "command" && field("contextMs") ? Number(field("contextMs")) : 0;
  if (
    !ROOM_PATTERN.test(room) ||
    !(VOICE_MIMES as readonly string[]).includes(mime) ||
    !Number.isFinite(durationMs) ||
    durationMs < 500 ||
    durationMs > MAX_DURATION_MS[kind] ||
    !Number.isFinite(contextMs) ||
    contextMs < 0 ||
    contextMs > CONTEXT_TAIL_MAX_MS + 1000 ||
    (contextMs > 0 && contextMs >= durationMs) ||
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
        // Biases recognition towards "Claude" in a bare command; not for meeting audio (it invents it on noise).
        prompt: kind === "command" && !contextMs ? "Claude," : undefined,
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
  console.info(`[voice] ${kind} lang=${result.language ?? "?"}${pinned ? " (pinned)" : ""} heard=${heardChars}ch${contextMs ? " +tail" : ""}`);

  if (kind === "context") {
    // Meeting audio is context only: never a command, and nothing is echoed back.
    const text = joinText(segments);
    if (text) addUtterance(session.email, room, text, "meeting");
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  // A segment belongs to the side of the boundary its midpoint is on. The meeting tail is stored
  // first (never searched for commands), so the command's prompt context includes it.
  const boundary = contextMs / 1000;
  const isTail = (s: TranscriptSegment) => contextMs > 0 && (s.start + s.end) / 2 < boundary;
  const tail = joinText(segments.filter(isTail));
  if (tail) addUtterance(session.email, room, tail, "meeting");
  const own = segments.filter((s) => !isTail(s));
  const heard = joinText(own);
  if (heard) addUtterance(session.email, room, heard, "command");
  try {
    const command = commandText(own);
    if (!command) return respond({ ok: true, heard });
    return respond(handleCommand(session, room, command, timeZone, heard));
  } catch (e) {
    console.error("[voice] command:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}
