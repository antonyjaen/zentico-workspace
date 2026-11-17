// Voice clips sent from a call (see /api/meet/voice): push-to-talk commands of one user and, while
// their "assistant listens to the meeting" toggle is on, ~15 s chunks of the meeting's mixed audio.
// Server-only: pure functions plus small in-memory state (rate limits, language memory and the
// transcription queue). Single instance.
import type { TranscriptSegment } from "@/app/(apps)/meet/recording";
import { genericAgentName, stripWake, wakeRegex } from "./wake";

export type ClipKind = "command" | "context";

/** Wake prefix when the user's own isn't passed: the generic words. */
const DEFAULT_WAKE = wakeRegex({ name: genericAgentName("en") });
const LEADING_JUNK = /^[\s"'“”‘’¿¡.,;:!?\-–—…]+/;

const fold = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * A push-to-talk clip is the command as a whole: no wake word needed, but a leading "Codex, …" or
 * "oye asistente, …" (people say it out of habit; `wake` comes from src/lib/meetings/wake.ts) is
 * stripped. Null when there is nothing to run.
 */
export function commandText(segments: TranscriptSegment[] | string, wake: RegExp = DEFAULT_WAKE): string | null {
  const text = (typeof segments === "string" ? [segments] : segments.map((s) => s.text))
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .replace(LEADING_JUNK, "");
  const rest = stripWake(text, wake).replace(LEADING_JUNK, "").trim();
  return rest.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? rest.slice(0, 2000) : null;
}

const CONFIRM = /^(confirm|confirmed|confirm it|approve|approved|yes|yes please|do it|go ahead|confirmo|confirma|confirmalo|confirmar|aprueba|apruebalo|aprobar|apruebo|si|si por favor|adelante|hazlo|dale)$/;
const CANCEL = /^(cancel|cancel it|cancel that|reject|reject it|stop|no|never mind|nevermind|forget it|cancela|cancelalo|cancelar|cancelo|rechaza|rechazalo|rechazar|para|detente|olvidalo|no lo hagas)$/;

/** "confirm" / "cancel" said as a whole push-to-talk command. */
export function controlOf(rest: string): "confirm" | "cancel" | null {
  const t = fold(rest)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(please|por favor|now|ahora|thanks|gracias)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (CONFIRM.test(t)) return "confirm";
  if (CANCEL.test(t)) return "cancel";
  return null;
}

/* ------------------------------------------------------------- user state */

const g = globalThis as typeof globalThis & {
  __zwVoiceSlots?: Map<string, number>;
  __zwVoiceLang?: Map<string, LangState>;
  __zwClipQueue?: ClipQueue;
};
const lastClip = (g.__zwVoiceSlots ??= new Map());

/** ≤ 1 clip of this kind per `minIntervalMs` per user. Returns false when over the limit. */
export function takeClipSlot(email: string, kind: ClipKind, minIntervalMs: number): boolean {
  const key = `${email.toLowerCase()}\n${kind}`;
  const now = Date.now();
  // Small tolerance for timer jitter in the browser.
  if (now - (lastClip.get(key) ?? 0) < minIntervalMs - 250) return false;
  if (lastClip.size > 10_000) lastClip.clear();
  lastClip.set(key, now);
  return true;
}

/* --------------------------------------------------------- language memory */
// Detecting the language costs Whisper an extra encoder pass (~2x slower on CPU). The language of a
// user's commands, and separately of the meeting audio they send, is detected on the first clips
// and then reused; it is re-detected every REDETECT_EVERY clips so a switch is picked up.

const REDETECT_EVERY = 6;
const MIN_CHARS_TO_LEARN = 12;

type LangState = { lang: string | null; sinceDetect: number };
const langs = (g.__zwVoiceLang ??= new Map());

const langKey = (email: string, room: string, kind: ClipKind) => `${email.toLowerCase()}\n${room}\n${kind}`;

/** The language to pin for this user's next clip of this kind, or null to let Whisper detect it. */
export function clipLanguage(email: string, room: string, kind: ClipKind): string | null {
  const st = langs.get(langKey(email, room, kind));
  if (!st?.lang || st.sinceDetect >= REDETECT_EVERY) return null;
  st.sinceDetect++;
  return st.lang;
}

/** Records the language Whisper detected on a clip that had enough speech to trust it. */
export function learnLanguage(email: string, room: string, kind: ClipKind, detected: string | null, heardChars: number): void {
  if (!detected || heardChars < MIN_CHARS_TO_LEARN) return;
  if (langs.size > 5000) langs.clear();
  langs.set(langKey(email, room, kind), { lang: detected, sinceDetect: 0 });
}

/* ------------------------------------------------------------- clip queue */
// Whisper on CPU is slow (~11 s per clip whatever its length) and keeps working on requests we
// abandon, so clips wait in a queue instead of being sent all at once.
// - Commands go first: they are admitted before any waiting context chunk. Each user's commands
//   run one at a time in order (a later "confirm" never overtakes the command it confirms); a user
//   has at most MAX_COMMANDS_WAITING waiting (one more drops their oldest).
// - Context chunks are best effort: at most one per user in flight and one waiting (a newer chunk
//   replaces the waiting one), and at most MAX_CONTEXT_RUNNING across users, so a slot is always
//   left for commands.
// - At most MAX_CONCURRENT clips are transcribed at once overall.

const MAX_CONCURRENT = 2;
const MAX_CONTEXT_RUNNING = MAX_CONCURRENT - 1;
const MAX_COMMANDS_WAITING = 4;

type Waiter = { user: string; kind: ClipKind; admit: (ok: boolean) => void };
type ClipQueue = { lanes: Set<string>; waiting: Waiter[] };

const lane = (w: { user: string; kind: ClipKind }) => `${w.user}\n${w.kind}`;
const queue = (g.__zwClipQueue ??= { lanes: new Set<string>(), waiting: [] });

function pump() {
  for (const kind of ["command", "context"] as const) {
    for (let i = 0; i < queue.waiting.length && queue.lanes.size < MAX_CONCURRENT; ) {
      const w = queue.waiting[i];
      const contexts = [...queue.lanes].filter((l) => l.endsWith("\ncontext")).length;
      if (w.kind !== kind || queue.lanes.has(lane(w)) || (kind === "context" && contexts >= MAX_CONTEXT_RUNNING)) {
        i++;
        continue;
      }
      queue.waiting.splice(i, 1);
      queue.lanes.add(lane(w));
      w.admit(true);
    }
  }
}

function remove(w: Waiter): boolean {
  const i = queue.waiting.indexOf(w);
  if (i < 0) return false;
  queue.waiting.splice(i, 1);
  return true;
}

/**
 * Waits for this user's turn to transcribe a clip. Resolves to a `release` function (call it
 * exactly once when done), or null when the clip was superseded by newer ones or the client left.
 */
export function enterClipQueue(email: string, kind: ClipKind, signal?: AbortSignal): Promise<(() => void) | null> {
  const user = email.toLowerCase();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      queue.lanes.delete(lane(w));
      pump();
    };
    const onAbort = () => {
      if (remove(w)) w.admit(false);
    };
    const w: Waiter = {
      user,
      kind,
      admit: (ok) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(ok ? release : null);
      },
    };
    const mine = queue.waiting.filter((x) => x.user === user && x.kind === kind);
    const keep = kind === "context" ? 0 : MAX_COMMANDS_WAITING - 1;
    for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
      if (remove(old)) old.admit(false);
    }
    queue.waiting.push(w);
    signal?.addEventListener("abort", onAbort, { once: true });
    pump();
  });
}
