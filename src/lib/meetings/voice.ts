// "Claude, …" detection in short transcribed windows of one user's own microphone. Server-only,
// pure functions plus a small per-user in-memory state (rate limit and a command that continues
// into the next window). Single instance.
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

/** The command after the first wake phrase in the window, or null. */
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

/**
 * Joins the text of two consecutive windows that overlap by ~1 s: the longest run of words that
 * ends `prev` and starts `next` (up to 8 words) is kept once.
 */
export function mergeOverlap(prev: string, next: string): string {
  const a = prev.trim().split(/\s+/).filter(Boolean);
  const b = next.trim().split(/\s+/).filter(Boolean);
  if (!a.length) return b.join(" ");
  if (!b.length) return a.join(" ");
  const key = (w: string) => fold(w).replace(/[^\p{L}\p{N}]/gu, "");
  for (let k = Math.min(8, a.length, b.length); k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = key(a[a.length - k + i]) === key(b[i]);
    if (same && a.slice(a.length - k).some((w) => key(w))) return [...a, ...b.slice(k)].join(" ");
  }
  return [...a, ...b].join(" ");
}

/** True when speech runs into the end of the window, i.e. the command probably continues. */
export function speechReachesEnd(segments: TranscriptSegment[], durationSeconds: number): boolean {
  const last = segments[segments.length - 1];
  return !!last && durationSeconds > 0 && last.end >= durationSeconds - 0.8;
}

/* ------------------------------------------------------------- user state */

export type PendingCapture = {
  room: string;
  text: string;
  windows: number;
  timeZone: string | null;
  timer: ReturnType<typeof setTimeout>;
};

type VoiceState = { lastWindow: number; pending: PendingCapture | null };

const g = globalThis as typeof globalThis & { __zwVoiceState?: Map<string, VoiceState> };
const states = (g.__zwVoiceState ??= new Map());

export function voiceState(email: string): VoiceState {
  const key = email.toLowerCase();
  let st = states.get(key);
  if (!st) {
    if (states.size > 5000) states.clear();
    st = { lastWindow: 0, pending: null };
    states.set(key, st);
  }
  return st;
}

/** ≤ 1 window per `minIntervalMs` per user. Returns false when over the limit. */
export function takeWindowSlot(email: string, minIntervalMs: number): boolean {
  const st = voiceState(email);
  const now = Date.now();
  // Small tolerance for timer jitter in the browser.
  if (now - st.lastWindow < minIntervalMs - 250) return false;
  st.lastWindow = now;
  return true;
}
