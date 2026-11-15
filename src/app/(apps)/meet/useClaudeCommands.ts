"use client";

// "Claude commands" for the LOCAL user only: when they opt in, each utterance of their own
// microphone (never other participants' audio), cut by voice activity detection in the browser,
// goes to /api/meet/voice, which queues "Claude, …" for their own Claude Code bridge. Also polls
// their commands / pending confirmations in this room.
// Nothing here is sent over the LiveKit data channel: results stay private to the speaker.
import { Room, Track } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLAUDE_COMMANDS_PREF,
  isFinalStatus,
  VOICE_MAX_BYTES,
  VOICE_MAX_CLIP_MS,
  type CommandsResponse,
  type CommandView,
  type VoiceResponse,
} from "./claude";

export type ClaudeNotice =
  | { kind: "done"; command: CommandView }
  | { kind: "failed"; command: CommandView }
  | { kind: "queued"; command: CommandView }
  | { kind: "approved" | "rejected" | "cancelled" | "noToken" | "notConfigured" | "unsupported" | "error" };

export type VoiceProblem = "noToken" | "notConfigured" | "unsupported" | null;

/**
 * Voice activity detection on the local microphone, in 20 ms frames of RMS level.
 * Thresholds are relative to an adaptive noise floor (≈ minimum tracking: falls fast, rises
 * slowly), so the same settings work in quiet and noisy rooms.
 */
const VAD = {
  frameMs: 20,
  /** Speech starts when the level stays this many times above the floor (≈ +10 dB) for onsetMs… */
  onsetRatio: 3.2,
  onsetMs: 60,
  /** …and continues while it stays above this ratio (≈ +6 dB): hysteresis. */
  releaseRatio: 2,
  /** Absolute minimum level for speech (≈ −44 dBFS), so a near-silent floor doesn't trigger on hiss. */
  minRms: 0.006,
  /** The clip ends after this much continuous silence (hangover)… */
  hangoverMs: 900,
  /** …or at this length. */
  maxClipMs: VOICE_MAX_CLIP_MS,
  /** Clips with less speech than this are dropped (coughs, clicks, "mm"). */
  minSpeechMs: 600,
  /** Minimum audio kept before the detected onset (see `maintainArmed`). */
  preRollMs: 300,
  armRotateMs: 700,
  /** Noise floor time constants. */
  floorFallMs: 150,
  floorRiseIdleMs: 2000,
  floorRiseSpeechMs: 15_000,
  floorMin: 0.0005,
  floorInit: 0.003,
  /** After (re)binding a track the floor calibrates for this long before speech can start. */
  warmupMs: 500,
} as const;

/** Runs on the audio thread (not throttled in background tabs): posts one RMS value per frame. */
const WORKLET = `class ZwVadRms extends AudioWorkletProcessor {
  constructor() { super(); this.n = Math.max(1, Math.round(sampleRate * ${VAD.frameMs / 1000})); this.sum = 0; this.count = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i] * ch[i];
      if (++this.count >= this.n) { this.port.postMessage(Math.sqrt(this.sum / this.count)); this.sum = 0; this.count = 0; }
    }
    return true;
  }
}
registerProcessor("zw-vad-rms", ZwVadRms);`;

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
};

type Rec = { mr: MediaRecorder; startedAt: number; parts: Blob[]; mime: string };

/**
 * Cuts the local microphone into utterances: a clip starts at speech onset (with pre-roll) and
 * ends after `hangoverMs` of silence or at `maxClipMs`; each clip is its own MediaRecorder file.
 * MediaRecorder can't record the past, so while idle one or two "armed" recorders run and rotate;
 * at onset the oldest (started ≥ preRollMs ago) becomes the clip and the others are discarded.
 */
class VoiceCapture {
  private stopped = false;
  private ctx: AudioContext | null = null;
  private workletLoad: Promise<boolean> | null = null;
  private nodes: AudioNode[] = [];
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private checkTimer: ReturnType<typeof setInterval>;
  private track: MediaStreamTrack | null = null;
  private boundAt = 0;
  private floor: number = VAD.floorInit;
  private onsetRun = 0;
  private armed: Rec[] = [];
  private clip: { rec: Rec; voicedMs: number; silenceMs: number } | null = null;
  private readonly mime = pickMime();

  constructor(
    private getTrack: () => MediaStreamTrack | null,
    private onClip: (blob: Blob, mime: string, durationMs: number) => void,
    private onSpeaking: (speaking: boolean) => void,
  ) {
    this.checkTimer = setInterval(() => this.check(), 500);
    this.check();
  }

  /** Follows the microphone track (muted, switched device, unpublished). */
  private check() {
    if (this.stopped) return;
    const track = this.getTrack();
    if (!track || track.readyState !== "live" || !track.enabled || !this.mime) {
      if (this.track) this.unbind();
      return;
    }
    if (track !== this.track) {
      this.unbind();
      void this.bind(track);
    }
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => undefined);
  }

  private loadWorklet(ctx: AudioContext): Promise<boolean> {
    return (this.workletLoad ??= (async () => {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })());
  }

  private async bind(track: MediaStreamTrack) {
    this.track = track;
    this.boundAt = performance.now();
    this.floor = VAD.floorInit;
    this.onsetRun = 0;
    try {
      const ctx = (this.ctx ??= new AudioContext());
      const worklet = await this.loadWorklet(ctx);
      if (this.stopped || this.track !== track) return;
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      if (worklet) {
        const node = new AudioWorkletNode(ctx, "zw-vad-rms", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        // A silent path to the destination keeps the graph pulled in every browser.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        source.connect(node);
        node.connect(sink);
        sink.connect(ctx.destination);
        const frameMs = (Math.max(1, Math.round(ctx.sampleRate * (VAD.frameMs / 1000))) / ctx.sampleRate) * 1000;
        node.port.onmessage = (e: MessageEvent<number>) => this.onFrame(e.data, frameMs);
        this.nodes = [source, node, sink];
      } else {
        // Fallback: AnalyserNode sampled by a timer (may be throttled in background tabs).
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        this.nodes = [source, analyser];
        const buf = new Float32Array(analyser.fftSize);
        let last = performance.now();
        this.fallbackTimer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const now = performance.now();
          this.onFrame(Math.sqrt(sum / buf.length), Math.min(1000, now - last));
          last = now;
        }, VAD.frameMs);
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    } catch {
      // No Web Audio: nothing is captured (never upload blind).
    }
  }

  private unbind() {
    if (this.clip) this.endClip(performance.now());
    for (const r of this.armed) this.discard(r);
    this.armed = [];
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    for (const n of this.nodes) {
      if (n instanceof AudioWorkletNode) n.port.onmessage = null;
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.nodes = [];
    this.track = null;
  }

  private startRecorder(now: number): Rec | null {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.mime) return null;
    try {
      const mr = new MediaRecorder(new MediaStream([track]), { mimeType: this.mime, audioBitsPerSecond: 32_000 });
      const rec: Rec = { mr, startedAt: now, parts: [], mime: this.mime };
      mr.ondataavailable = (e) => {
        if (e.data.size) rec.parts.push(e.data);
      };
      mr.start();
      return rec;
    } catch {
      return null;
    }
  }

  private discard(r: Rec) {
    r.mr.ondataavailable = null;
    r.mr.onstop = null;
    r.parts.length = 0;
    if (r.mr.state !== "inactive") {
      try {
        r.mr.stop();
      } catch {
        // already stopped
      }
    }
  }

  /** Keeps armed[0] between preRollMs and preRollMs + armRotateMs old, with at most two recorders live. */
  private maintainArmed(now: number) {
    const newest = this.armed[this.armed.length - 1];
    if (!newest || now - newest.startedAt >= VAD.armRotateMs) {
      const r = this.startRecorder(now);
      if (r) this.armed.push(r);
    }
    while (this.armed.length > 1 && now - this.armed[1].startedAt >= VAD.preRollMs) this.discard(this.armed.shift()!);
  }

  private onFrame(rms: number, dt: number) {
    if (this.stopped || !this.track) return;
    const now = performance.now();
    const warm = now - this.boundAt < VAD.warmupMs;
    const tau = rms < this.floor || warm ? VAD.floorFallMs : this.clip ? VAD.floorRiseSpeechMs : VAD.floorRiseIdleMs;
    this.floor = Math.max(VAD.floorMin, this.floor + (rms - this.floor) * (1 - Math.exp(-dt / tau)));
    const onset = Math.max(this.floor * VAD.onsetRatio, VAD.minRms);
    const release = Math.max(this.floor * VAD.releaseRatio, VAD.minRms * 0.6);

    if (!this.clip) {
      this.maintainArmed(now);
      if (warm) return;
      this.onsetRun = rms > onset ? this.onsetRun + dt : 0;
      if (this.onsetRun >= VAD.onsetMs) this.startClip(now);
      return;
    }
    const c = this.clip;
    if (rms > release) {
      c.voicedMs += dt;
      c.silenceMs = 0;
    } else c.silenceMs += dt;
    if (c.silenceMs >= VAD.hangoverMs || now - c.rec.startedAt >= VAD.maxClipMs) this.endClip(now);
  }

  private startClip(now: number) {
    // The oldest armed recorder holds the pre-roll; the others aren't needed.
    const rec = this.armed.shift() ?? this.startRecorder(now);
    for (const r of this.armed) this.discard(r);
    this.armed = [];
    const voicedMs = this.onsetRun;
    this.onsetRun = 0;
    if (!rec) return;
    this.clip = { rec, voicedMs, silenceMs: 0 };
    this.onSpeaking(true);
  }

  private endClip(now: number) {
    const c = this.clip;
    if (!c) return;
    this.clip = null;
    this.onSpeaking(false);
    const { rec } = c;
    if (this.stopped || c.voicedMs < VAD.minSpeechMs) return this.discard(rec);
    const durationMs = Math.round(now - rec.startedAt);
    rec.mr.onstop = () => {
      const type = (rec.mr.mimeType || rec.mime).split(";")[0];
      const blob = new Blob(rec.parts, { type });
      rec.parts.length = 0;
      if (!this.stopped && blob.size > 0 && blob.size <= VOICE_MAX_BYTES) this.onClip(blob, type, durationMs);
    };
    try {
      rec.mr.stop();
    } catch {
      this.discard(rec);
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.checkTimer);
    if (this.clip) {
      this.discard(this.clip.rec);
      this.clip = null;
    }
    this.unbind();
    void this.ctx?.close().catch(() => undefined);
  }
}

export function voiceSupported(): boolean {
  return typeof window !== "undefined" && !!pickMime() && !!navigator.mediaDevices && typeof AudioContext !== "undefined";
}

function readPref(): boolean {
  try {
    return localStorage.getItem(CLAUDE_COMMANDS_PREF) === "1";
  } catch {
    return false;
  }
}

/** How long the last transcription stays visible as "Heard: …". */
const HEARD_VISIBLE_MS = 15_000;

export function useClaudeCommands(room: Room, roomName: string, opts: { panelOpen: boolean; notify: (n: ClaudeNotice) => void }) {
  const [enabled, setEnabledState] = useState(false);
  const [data, setData] = useState<CommandsResponse | null>(null);
  const [problem, setProblem] = useState<VoiceProblem>(null);
  /** The VAD is inside an utterance right now. */
  const [speaking, setSpeaking] = useState(false);
  /** Clips uploaded and not answered yet (one transcribing, the rest queued on the server). */
  const [transcribing, setTranscribing] = useState(0);
  const [heard, setHeard] = useState<{ text: string; at: number } | null>(null);
  /** Voice commands just accepted, shown as "Claude is processing…" until the bridge picks them up. */
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const notifyRef = useRef(opts.notify);
  notifyRef.current = opts.notify;
  const seen = useRef(new Map<string, CommandView["status"]>());
  const first = useRef(true);

  useEffect(() => setEnabledState(readPref()), []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    if (on) setProblem(null);
    try {
      localStorage.setItem(CLAUDE_COMMANDS_PREF, on ? "1" : "0");
    } catch {
      // storage blocked: the toggle still works for this call
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/meet/voice/commands?room=${encodeURIComponent(roomName)}`, { cache: "no-store" });
      if (!res.ok || res.redirected) return;
      const next = (await res.json()) as CommandsResponse;
      // Toast when one of the user's commands finishes (not for history loaded on join).
      for (const c of next.commands) {
        const before = seen.current.get(c.id);
        if (!first.current && before && before !== c.status && isFinalStatus(c.status) && c.status !== "cancelled") {
          notifyRef.current({ kind: c.status === "done" ? "done" : "failed", command: c });
        }
        seen.current.set(c.id, c.status);
      }
      first.current = false;
      setData(next);
      // The real status takes over once the command left the queue (or is gone).
      setAccepted((prev) => {
        if (!prev.size) return prev;
        const still = new Set([...prev].filter((id) => next.commands.some((c) => c.id === id && c.status === "queued" && !c.progress)));
        return still.size === prev.size ? prev : still;
      });
    } catch {
      // offline: next poll
    }
  }, [roomName]);

  // Poll quickly while something is going on, slowly otherwise.
  const busy = enabled || opts.panelOpen || !!data?.commands.some((c) => !isFinalStatus(c.status)) || !!data?.confirmations.length;
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), busy ? 2000 : 15_000);
    return () => clearInterval(id);
  }, [refresh, busy]);

  const upload = useCallback(
    async (blob: Blob, mime: string, durationMs: number) => {
      const form = new FormData();
      form.set("room", roomName);
      form.set("mime", mime);
      form.set("duration", String(durationMs));
      form.set("timeZone", timeZone());
      form.set("file", blob, "clip");
      setTranscribing((n) => n + 1);
      try {
        const res = await fetch("/api/meet/voice", { method: "POST", body: form });
        if (res.status === 412) {
          setProblem("noToken");
          setEnabledState(false);
          return notifyRef.current({ kind: "noToken" });
        }
        if (res.status === 503) {
          setProblem("notConfigured");
          setEnabledState(false);
          return notifyRef.current({ kind: "notConfigured" });
        }
        // 429: superseded by newer clips (the server keeps the newest speech) or rate limited.
        if (!res.ok || res.redirected) return;
        const body = (await res.json()) as VoiceResponse;
        if (body.heard) setHeard({ text: body.heard.slice(0, 200), at: Date.now() });
        if (body.action) notifyRef.current({ kind: body.action });
        const command = body.command;
        if (command) {
          if (!seen.current.has(command.id)) notifyRef.current({ kind: "queued", command });
          seen.current.set(command.id, command.status);
          // Optimistic: show it right away, before the next poll.
          if (command.status === "queued") setAccepted((prev) => new Set(prev).add(command.id));
          setData((prev) =>
            prev && !prev.commands.some((c) => c.id === command.id) ? { ...prev, commands: [command, ...prev.commands] } : prev,
          );
        }
        if (command || body.action) void refresh();
      } catch {
        // dropped clip (offline): nothing to retry, the speaker can repeat
      } finally {
        setTranscribing((n) => Math.max(0, n - 1));
      }
    },
    [roomName, refresh],
  );

  // The capture loop, only while the toggle is on. Own microphone only.
  useEffect(() => {
    if (!enabled) return;
    if (!voiceSupported()) {
      setProblem("unsupported");
      setEnabledState(false);
      notifyRef.current({ kind: "unsupported" });
      return;
    }
    const capture = new VoiceCapture(
      () => {
        const lp = room.localParticipant;
        if (!lp.isMicrophoneEnabled) return null;
        return lp.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
      },
      (blob, mime, ms) => void upload(blob, mime, ms),
      setSpeaking,
    );
    return () => {
      capture.stop();
      setSpeaking(false);
    };
  }, [enabled, room, upload]);

  const ask = useCallback(
    async (text: string): Promise<"ok" | "noToken" | "error"> => {
      try {
        const res = await fetch("/api/meet/voice/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: roomName, text, timeZone: timeZone() }),
        });
        if (res.status === 412) {
          setProblem("noToken");
          return "noToken";
        }
        if (!res.ok || res.redirected) return "error";
        const { command } = (await res.json()) as { command: CommandView };
        seen.current.set(command.id, command.status);
        void refresh();
        return "ok";
      } catch {
        return "error";
      }
    },
    [roomName, refresh],
  );

  const post = useCallback(async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res;
  }, []);

  const decide = useCallback(
    async (id: string, approve: boolean) => {
      try {
        await post(`/api/meet/voice/confirmations/${id}`, { decision: approve ? "approve" : "reject" });
      } finally {
        void refresh();
      }
    },
    [post, refresh],
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        await post(`/api/meet/voice/commands/${id}`, { action: "cancel" });
      } finally {
        void refresh();
      }
    },
    [post, refresh],
  );

  /** Shares a result to the meeting's Chat thread; "noChat" when the room has none. */
  const share = useCallback(
    async (id: string): Promise<"ok" | "noChat" | "error"> => {
      try {
        const res = await post(`/api/meet/voice/commands/${id}`, { action: "share" });
        if (res.status === 404) return "noChat";
        return res.ok ? "ok" : "error";
      } catch {
        return "error";
      }
    },
    [post],
  );

  // "Heard: …" fades out after a while.
  useEffect(() => {
    if (!heard) return;
    const id = setTimeout(() => setHeard(null), Math.max(0, heard.at + HEARD_VISIBLE_MS - Date.now()));
    return () => clearTimeout(id);
  }, [heard]);

  return {
    enabled,
    setEnabled,
    data,
    problem,
    speaking: enabled && speaking,
    transcribing,
    heard: heard?.text ?? null,
    accepted,
    ask,
    decide,
    cancel,
    share,
  };
}
