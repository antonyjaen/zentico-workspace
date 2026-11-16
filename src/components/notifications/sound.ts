// A short synthesized chime (WebAudio, no assets). Browsers only allow audio after the page got
// a user gesture, so the context is created/resumed on the first pointer or key press.

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx ??= new AC();
  } catch {
    return null;
  }
  return ctx;
}

/** Call from a user gesture so later chimes may play. */
export function unlockAudio() {
  const c = context();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

/** Two soft notes for messages; three rising notes for a meeting starting. */
export function playChime(kind: "message" | "meeting") {
  const c = context();
  if (!c) return;
  if (c.state === "running") play(c, kind);
  else void c.resume().then(() => c.state === "running" && play(c, kind)).catch(() => {});
}

function play(c: AudioContext, kind: "message" | "meeting") {
  const notes = kind === "meeting" ? [659.25, 880, 1174.66] : [880, 1318.5];
  const t0 = c.currentTime + 0.01;
  notes.forEach((freq, i) => {
    const start = t0 + i * 0.11;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.35);
  });
}
