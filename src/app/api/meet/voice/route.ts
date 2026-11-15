// One rolling window (~6 s) of the signed-in user's OWN microphone, sent while their "Claude
// commands" toggle is on. The audio is transcribed in memory (never written to disk or logged) and
// dropped; "Claude, …" at the start of an utterance queues a command for that user's own bridge.
// Multipart fields: room, file, mime, duration (ms), timeZone.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { createCommand, cleanTimeZone, hasWriteToken } from "@/lib/meetings/claude-commands";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { meetingLanguage, noteDetection } from "@/lib/meetings/language";
import { transcribeAudio, whisperConfig } from "@/lib/meetings/transcribe";
import {
  controlOf,
  findCommand,
  mergeOverlap,
  speechReachesEnd,
  takeWindowSlot,
  voiceState,
} from "@/lib/meetings/voice";
import {
  addUtterance,
  cancelCommand,
  decideConfirmation,
  latestActiveCommand,
  latestPendingConfirmation,
  toView,
} from "@/lib/mcp/agent";
import type { Session } from "@/lib/session";
import { VOICE_MAX_BYTES, VOICE_MIN_INTERVAL_MS, type VoiceResponse } from "@/app/(apps)/meet/claude";
import { AUDIO_MIMES } from "@/app/(apps)/meet/recording";
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WHISPER_TIMEOUT_MS = 30_000;
/** Whisper (CPU) works one request at a time and keeps working on requests we've abandoned, so
 * windows that pile up snowball into timeouts. Allow one window in flight per user, few overall. */
const MAX_IN_FLIGHT = 3;
const inFlight = new Set<string>();
/** A command that runs into the window's end waits for at most this many more windows. */
const MAX_CONTINUATIONS = 2;
const CONTINUE_WAIT_MS = 8000;

const respond = (body: VoiceResponse) => NextResponse.json(body, { headers: NO_STORE });

/** Queues (or keeps capturing) a voice command; "Claude confirm/cancel" act on pending items. */
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

function finishPending(session: Session) {
  const st = voiceState(session.email);
  const p = st.pending;
  if (!p) return null;
  clearTimeout(p.timer);
  st.pending = null;
  return p;
}

function holdPending(session: Session, room: string, text: string, windows: number, timeZone: string | null) {
  const st = voiceState(session.email);
  if (st.pending) clearTimeout(st.pending.timer);
  // If no further window arrives (toggle off, mic muted, tab closed), queue what we have.
  const timer = setTimeout(() => {
    const p = finishPending(session);
    if (!p) return;
    try {
      handleCommand(session, p.room, p.text, p.timeZone, "");
    } catch (e) {
      console.error("[voice] queue:", e instanceof Error ? e.message : e);
    }
  }, CONTINUE_WAIT_MS);
  timer.unref?.();
  st.pending = { room, text, windows, timeZone, timer };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > VOICE_MAX_BYTES + 16 * 1024) return jsonError("too_large", 413);
  if (!takeWindowSlot(session.email, VOICE_MIN_INTERVAL_MS)) return jsonError("rate_limited", 429);
  if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
  if (inFlight.has(session.email) || inFlight.size >= MAX_IN_FLIGHT) return respond({ ok: true, heard: "", busy: true } as VoiceResponse);
  inFlight.add(session.email);
  try {
    return await handleWindow(req, session);
  } finally {
    inFlight.delete(session.email);
  }
}

async function handleWindow(req: NextRequest, session: Session) {
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
    durationMs > 15_000 ||
    !(file instanceof Blob) ||
    file.size === 0
  ) {
    return jsonError("invalid", 400);
  }
  if (file.size > VOICE_MAX_BYTES) return jsonError("too_large", 413);

  let audio: Uint8Array | null = new Uint8Array(await file.arrayBuffer());
  let result;
  try {
    // Detect the meeting's language first, then transcribe every window in it (see language.ts).
    const locked = cfg.language ?? meetingLanguage(room);
    const hint = localeHint(req);
    result = await transcribeAudio(cfg, audio, mime, { timeoutMs: WHISPER_TIMEOUT_MS, prompt: "Claude,", language: locked });
    if (!locked) {
      const text = result.segments.map((s) => s.text).join(" ");
      const lock = noteDetection(room, result.language, text);
      // While undecided, a short window detected as a language other than the user's own is
      // usually a misdetection: redo it in the user's language.
      if (!lock && hint && result.language !== hint && text.trim().length < 40) {
        result = await transcribeAudio(cfg, audio, mime, { timeoutMs: WHISPER_TIMEOUT_MS, prompt: "Claude,", language: hint });
      }
    }
  } catch (e) {
    // Only the status/summary, never the audio.
    console.error("[voice] transcription:", e instanceof Error ? e.message.slice(0, 200) : "failed");
    return jsonError("transcription_failed", 502);
  } finally {
    audio = null; // drop the window right away
  }

  const segments = result.segments;
  console.info(`[voice] lang=${meetingLanguage(room) ?? `detecting(${result.language ?? "?"})`} heard=${segments.reduce((n, x) => n + x.text.length, 0)}ch`);
  const heard = segments.map((s) => s.text).join(" ").trim();
  const duration = result.duration ?? durationMs / 1000;
  if (heard) addUtterance(session.email, room, heard);

  try {
    // A command that started in the previous window continues here.
    const pending = voiceState(session.email).pending;
    if (pending && pending.room === room) {
      const text = heard ? mergeOverlap(pending.text, heard) : pending.text;
      if (heard && speechReachesEnd(segments, duration) && pending.windows < MAX_CONTINUATIONS) {
        holdPending(session, room, text, pending.windows + 1, pending.timeZone);
        return respond({ ok: true, heard, capturing: true });
      }
      finishPending(session);
      return respond(handleCommand(session, room, text, pending.timeZone, heard));
    }
    if (pending) {
      // Switched rooms: queue what was captured in the old one.
      const p = finishPending(session)!;
      handleCommand(session, p.room, p.text, p.timeZone, "");
    }

    const command = heard ? findCommand(segments) : null;
    if (!command) return respond({ ok: true, heard });
    if (!controlOf(command) && speechReachesEnd(segments, duration)) {
      holdPending(session, room, command, 1, timeZone);
      return respond({ ok: true, heard, capturing: true });
    }
    return respond(handleCommand(session, room, command, timeZone, heard));
  } catch (e) {
    console.error("[voice] command:", e instanceof Error ? e.message : e);
    return jsonError("failed", 500);
  }
}

/** The user's UI language (zw_locale cookie, else Accept-Language), as a Whisper language hint. */
function localeHint(req: NextRequest): string | null {
  const c = req.cookies.get("zw_locale")?.value ?? req.headers.get("accept-language") ?? "";
  const m = c.toLowerCase().match(/^(es|en)/);
  return m ? m[1] : null;
}
