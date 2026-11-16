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

/**
 * Loops a pattern every `period` seconds through its own gain node until the returned stop()
 * runs. The context may still be locked (no gesture yet in this tab): it then starts once resumed.
 */
function loop(period: number, pattern: (c: AudioContext, out: AudioNode, t0: number) => void): () => void {
  const c = context();
  if (!c) return () => {};
  const master = c.createGain();
  master.connect(c.destination);
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const begin = () => {
    if (stopped) return;
    let next = c.currentTime + 0.02;
    const tick = () => {
      // Schedule a little ahead so timer jitter (or a throttled background tab) never leaves gaps.
      while (next < c.currentTime + period + 0.5) {
        pattern(c, master, next);
        next += period;
      }
    };
    tick();
    timer = setInterval(tick, 500);
  };
  if (c.state === "running") begin();
  else void c.resume().then(begin).catch(() => {});
  return () => {
    stopped = true;
    clearInterval(timer);
    try {
      master.gain.setTargetAtTime(0, c.currentTime, 0.02);
      setTimeout(() => master.disconnect(), 200);
    } catch {}
  };
}

function tone(c: AudioContext, out: AudioNode, freq: number, start: number, length: number, peak: number, type: OscillatorType = "sine") {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.setValueAtTime(peak, start + Math.max(0.012, length - 0.03));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** Incoming call: two short warbling bursts every 3 s. */
export function startRingtone(): () => void {
  return loop(3, (c, out, t0) => {
    for (let burst = 0; burst < 2; burst++) {
      for (let i = 0; i < 10; i++) {
        tone(c, out, i % 2 ? 987.77 : 783.99, t0 + burst * 0.5 + i * 0.04, 0.045, 0.07, "triangle");
      }
    }
  });
}

/** Outgoing call (caller hears it while the other side rings): 425 Hz, 1 s on, 3 s off. */
export function startRingback(): () => void {
  return loop(4, (c, out, t0) => tone(c, out, 425, t0, 1, 0.045));
}
