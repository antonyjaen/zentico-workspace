// Per-meeting spoken-language lock for live voice commands. Whisper's auto-detection on 6 s
// windows flips between languages (seen live: en 0.37 / ur 0.33 / es 0.96 for one speaker), which
// garbles the transcript and hides the "Claude, …" wake phrase. So the meeting's language is
// detected first from the opening windows, then every later window is transcribed in it.

const LOCK_VOTES = 2; // agreeing detections needed to lock
const MIN_CHARS = 12; // ignore detections from near-empty windows
const TTL_MS = 6 * 60 * 60 * 1000;

type State = { votes: Map<string, number>; locked: string | null; at: number };
const rooms = new Map<string, State>();

function state(room: string): State {
  const now = Date.now();
  for (const [k, v] of rooms) if (now - v.at > TTL_MS) rooms.delete(k);
  let s = rooms.get(room);
  if (!s) rooms.set(room, (s = { votes: new Map(), locked: null, at: now }));
  s.at = now;
  return s;
}

const LANG = /^[a-z]{2,3}$/;

/** The locked language of a meeting, or null while it is still being detected. */
export function meetingLanguage(room: string): string | null {
  return state(room).locked;
}

/** Records one auto-detected window; locks the language once it is clear. Returns the lock. */
export function noteDetection(room: string, language: string | null | undefined, text: string): string | null {
  const s = state(room);
  if (s.locked) return s.locked;
  const lang = (language ?? "").toLowerCase();
  if (!LANG.test(lang) || text.trim().length < MIN_CHARS) return null;
  const n = (s.votes.get(lang) ?? 0) + 1;
  s.votes.set(lang, n);
  if (n >= LOCK_VOTES) s.locked = lang;
  return s.locked;
}

/** Sets the meeting language explicitly (e.g. chosen by a participant). */
export function setMeetingLanguage(room: string, language: string): void {
  if (LANG.test(language)) state(room).locked = language;
}
