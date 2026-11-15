// "Claude, …" detection in transcribed utterances of one user's own microphone. Server-only:
// pure functions plus small in-memory state (per-user rate limit and the transcription queue).
// Single instance.
import type { TranscriptSegment } from "@/app/(apps)/meet/recording";

/** Wake phrase at the start of an utterance (English/Spanish, common Whisper misspellings). */
const WAKE = /^(?:(?:hey|oye|ok|okay)[\s,]+)?(?:claude|cloud|clod|claud|cloth|klaud|klod|clow|clau|cloude)\b[,:.!]?\s*(.+)/i;
const LEADING_JUNK = /^[\s"'“”‘’¿¡.,;:!?\-–—…]+/;

const fold = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Splits Whisper segments into sentence-like units so a wake phrase mid-segment ("Okay. Claude, …") counts. */
function units(segments: TranscriptSegment[]): string[] {
  return segments.flatMap((s) =>
    s.text
      .split(/(?<=[.!?…])\s+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

/** The command after the first wake phrase in the utterance, or null. */
export function findCommand(segments: TranscriptSegment[]): string | null {
  const list = units(segments);
  for (let i = 0; i < list.length; i++) {
    const candidate = list.slice(i).join(" ").replace(LEADING_JUNK, "");
    const m = WAKE.exec(candidate);
    if (!m) continue;
    const rest = m[1].replace(LEADING_JUNK, "").trim();
    if (rest.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) return rest.slice(0, 2000);
  }
  return null;
}

const CONFIRM = /^(confirm|confirmed|confirm it|approve|approved|yes|yes please|do it|go ahead|confirmo|confirma|confirmalo|confirmar|aprueba|apruebalo|aprobar|apruebo|si|si por favor|adelante|hazlo|dale)$/;
const CANCEL = /^(cancel|cancel it|cancel that|reject|reject it|stop|no|never mind|nevermind|forget it|cancela|cancelalo|cancelar|cancelo|rechaza|rechazalo|rechazar|para|detente|olvidalo|no lo hagas)$/;

/** "Claude confirm" / "Claude cancel" (the remainder after the wake phrase). */
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

type VoiceState = { lastClip: number };

const g = globalThis as typeof globalThis & {
  __zwVoiceState?: Map<string, VoiceState>;
  __zwVoiceQueue?: { running: Set<string>; waiting: Waiter[] };
};
const states = (g.__zwVoiceState ??= new Map());

function voiceState(email: string): VoiceState {
  const key = email.toLowerCase();
  let st = states.get(key);
  if (!st) {
    if (states.size > 5000) states.clear();
    st = { lastClip: 0 };
    states.set(key, st);
  }
  return st;
}

/** ≤ 1 clip per `minIntervalMs` per user. Returns false when over the limit. */
export function takeClipSlot(email: string, minIntervalMs: number): boolean {
  const st = voiceState(email);
  const now = Date.now();
  // Small tolerance for timer jitter in the browser.
  if (now - st.lastClip < minIntervalMs - 250) return false;
  st.lastClip = now;
  return true;
}

/* ------------------------------------------------------------- clip queue */
// Whisper on CPU is slow (~20 s per clip whatever its length) and keeps working on requests we
// abandon, so clips are queued instead of dropped: each user's clips are transcribed one at a
// time in order (a later "Claude, confirm" never overtakes the command it confirms), and at most
// MAX_CONCURRENT clips are transcribed at once across users (others wait, in arrival order).
// A user has at most MAX_WAITING clips waiting; one more drops their OLDEST waiting clip, so the
// newest speech wins.

const MAX_CONCURRENT = 2;
const MAX_WAITING = 4;

type Waiter = { user: string; admit: (ok: boolean) => void };

const queue = (g.__zwVoiceQueue ??= { running: new Set<string>(), waiting: [] });

function pump() {
  for (let i = 0; i < queue.waiting.length && queue.running.size < MAX_CONCURRENT; ) {
    const w = queue.waiting[i];
    if (queue.running.has(w.user)) {
      i++;
      continue;
    }
    queue.waiting.splice(i, 1);
    queue.running.add(w.user);
    w.admit(true);
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
export function enterClipQueue(email: string, signal?: AbortSignal): Promise<(() => void) | null> {
  const user = email.toLowerCase();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      queue.running.delete(user);
      pump();
    };
    const onAbort = () => {
      if (remove(w)) w.admit(false);
    };
    const w: Waiter = {
      user,
      admit: (ok) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(ok ? release : null);
      },
    };
    const mine = queue.waiting.filter((x) => x.user === user);
    if (mine.length >= MAX_WAITING && remove(mine[0])) mine[0].admit(false);
    queue.waiting.push(w);
    signal?.addEventListener("abort", onAbort, { once: true });
    pump();
  });
}
