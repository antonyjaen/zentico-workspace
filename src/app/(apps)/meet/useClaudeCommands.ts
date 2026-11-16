"use client";

// "Claude commands" for the LOCAL user: they talk to THEIR OWN Claude Code (bridge) during a call.
// - Push to talk: while the panel button or the "C" key is held, their own voice is recorded (a
//   clone of the published mic, or a private capture when muted in the call, so the room never
//   hears it) and sent to /api/meet/voice as kind=command; the whole clip is the command.
// - "Claude listens to the meeting" (opt-in, announced to everyone over the data channel before
//   anything is captured): their browser mixes every participant's microphone and sends ~15 s
//   chunks as kind=context, so commands come with what was said in the meeting. The part not sent
//   yet when push to talk starts goes in front of the command, in the same clip (contextMs marks
//   the boundary), so the last seconds before a command are never missing.
// - Local transcription (localWhisper.ts): where the GPU allows it, both are transcribed in this
//   browser (the command and the tail separately) and only the text is posted (kind=command-text /
//   context-text); until the model is loaded, or after it fails, the audio goes to the server.
// Also polls their commands / pending confirmations in this room. Results stay private to the
// user (only the short spoken summary is shared, by useClaudeVoice).
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMMAND_MAX_CHARS,
  CLAUDE_LISTEN_PREF,
  CLAUDE_LISTEN_TOPIC,
  CONTEXT_CHUNK_MS,
  CONTEXT_TAIL_MAX_MS,
  isFinalStatus,
  PTT_MIN_MS,
  VOICE_CONTEXT_MAX_CHARS,
  VOICE_MAX_BYTES,
  VOICE_MAX_CLIP_MS,
  VOICE_MAX_TOTAL_MS,
  type ClaudeListenSignal,
  type CommandsResponse,
  type CommandView,
  type VoiceKind,
  type VoiceResponse,
  type VoiceTextRequest,
} from "./claude";
import { loadLocalStt, LocalSttDropped, pcmToFloat, transcribeLocal, useLocalStt } from "./localWhisper";
import { displayName } from "./media";

export type ClaudeNotice =
  | { kind: "done"; command: CommandView }
  | { kind: "failed"; command: CommandView }
  | { kind: "queued"; command: CommandView }
  | { kind: "listenStarted"; name: string }
  | {
      kind:
        | "approved"
        | "rejected"
        | "cancelled"
        | "noToken"
        | "notConfigured"
        | "unsupported"
        | "tooShort"
        | "nothingHeard"
        | "micFailed"
        | "error";
    };

export type VoiceProblem = "noToken" | "notConfigured" | "unsupported" | null;

/** Someone else in the call whose Claude is listening to the meeting. */
export type ClaudeListener = { identity: string; name: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AUDIO_BITRATE = 32_000;
/** "Claude is listening" is repeated this often; receivers forget it after STALE_LISTEN_MS without one. */
const LISTEN_HEARTBEAT_MS = 10_000;
const STALE_LISTEN_MS = 35_000;
/** How long the last transcription stays visible as "Heard: …". */
const HEARD_VISIBLE_MS = 15_000;

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

const baseMime = (mr: MediaRecorder, fallback: string) => (mr.mimeType || fallback).split(";")[0];

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
};

export function voiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    ((typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined") || !!pickMime())
  );
}

function listenSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    (typeof AudioWorkletNode !== "undefined" || !!pickMime())
  );
}

function readPref(): boolean {
  try {
    return localStorage.getItem(CLAUDE_LISTEN_PREF) === "1";
  } catch {
    return false;
  }
}

function writePref(on: boolean) {
  try {
    localStorage.setItem(CLAUDE_LISTEN_PREF, on ? "1" : "0");
  } catch {
    // storage blocked: the toggle still works for this call
  }
}

/** Focus is somewhere the "C" key types text. */
function typingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/* ------------------------------------------------------------------- PCM */
// Meeting audio and push to talk are captured as raw 16 kHz mono PCM by an AudioWorklet (so the
// unsent end of the meeting audio can ride along with a command) and uploaded as 16-bit WAV.

const PCM_RATE = 16_000;
const msToSamples = (ms: number) => Math.round((ms * PCM_RATE) / 1000);
const samplesToMs = (n: number) => Math.round((n * 1000) / PCM_RATE);
/** Silence between the meeting tail and the command in one clip. */
const TAIL_GAP_MS = 600;
/** The ring keeps this much meeting audio (Int16: 1.9 MB). */
const RING_SECONDS = 60;

/** Downmixed mono in, 16 kHz Float32 blocks of 100 ms out (box filter + decimation). */
const PCM_WORKLET = `class ZwPcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.step = sampleRate / ${PCM_RATE}; this.pos = 0; this.acc = 0; this.n = 0; this.out = new Float32Array(${PCM_RATE / 10}); this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.n++;
      if (++this.pos >= this.step) {
        this.pos -= this.step;
        this.out[this.len++] = this.acc / this.n; this.acc = 0; this.n = 0;
        if (this.len === this.out.length) { this.port.postMessage(this.out, [this.out.buffer]); this.out = new Float32Array(${PCM_RATE / 10}); this.len = 0; }
      }
    }
    return true;
  }
}
registerProcessor("zw-pcm16k", ZwPcm16k);`;

/** A worklet node posting 16 kHz blocks to `onBlock`; null without AudioWorklet support. */
async function pcmNode(ctx: AudioContext, onBlock: (block: Float32Array) => void): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return null;
  const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, "zw-pcm16k", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);
  // A silent path to the destination keeps the graph pulled in every browser.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  return node;
}

function toInt16(blocks: Float32Array[]): Int16Array<ArrayBuffer> {
  const out = new Int16Array(blocks.reduce((n, b) => n + b.length, 0));
  let i = 0;
  for (const b of blocks) for (const v of b) out[i++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  return out;
}

/** How much of the clip has sound, in ms (100 ms windows above SOUND_RMS). */
function soundMs(pcm: Int16Array): number {
  const win = PCM_RATE / 10;
  const limit = SOUND_RMS * 0x7fff;
  let ms = 0;
  for (let at = 0; at + win <= pcm.length; at += win) {
    let sum = 0;
    for (let i = at; i < at + win; i++) sum += pcm[i] * pcm[i];
    if (Math.sqrt(sum / win) > limit) ms += 100;
  }
  return ms;
}

/** 16-bit PCM WAV, 16 kHz mono. */
function wavBlob(parts: Int16Array<ArrayBuffer>[]): Blob {
  const bytes = parts.reduce((n, p) => n + p.byteLength, 0);
  const v = new DataView(new ArrayBuffer(44));
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, PCM_RATE, true);
  v.setUint32(28, PCM_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, bytes, true);
  return new Blob([v.buffer, ...parts], { type: "audio/wav" });
}

/** The last RING_SECONDS of meeting PCM, with a "sent up to" pointer (absolute sample indexes). */
class PcmRing {
  private buf = new Int16Array(RING_SECONDS * PCM_RATE);
  written = 0;
  sent = 0;

  push(block: Float32Array) {
    const len = this.buf.length;
    for (const v of block) this.buf[this.written++ % len] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }

  oldest() {
    return Math.max(0, this.written - this.buf.length);
  }

  slice(from: number, to: number): Int16Array<ArrayBuffer> {
    const start = Math.max(from, this.oldest());
    const out = new Int16Array(Math.max(0, to - start));
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(start + i) % this.buf.length];
    return out;
  }
}

/* ------------------------------------------------------------- meeting audio */

const LISTEN_EVENTS = [
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ActiveDeviceChanged,
  RoomEvent.TrackUnmuted,
] as const;

/** Level (RMS) above which audio counts as sound (≈ −40 dBFS). */
const SOUND_RMS = 0.01;
/** Chunks with less sound than this are not uploaded (the server also runs VAD). */
const MIN_SOUND_MS = 1000;
/** A context chunk never exceeds this (the flush timer can be late in a background tab). */
const CONTEXT_MAX_MS = CONTEXT_CHUNK_MS + 3000;
const LEVEL_SAMPLE_MS = 200;

type Chunk = { mr: MediaRecorder; parts: Blob[]; startedAt: number; soundMs: number };
/** Where the unsent meeting audio was when push to talk started. */
export type TailMark = { from: number; to: number };

/**
 * Mixes every microphone in the room (local + each subscribed remote track, following tracks that
 * come and go) with Web Audio. The mix goes into a PCM ring buffer (AudioWorklet) whose unsent
 * part is uploaded every CONTEXT_CHUNK_MS as WAV unless nearly silent; push to talk can take the
 * newest unsent part instead (beginPress / endPress). Without AudioWorklet, rotating MediaRecorders
 * make standalone Opus chunks (and there is no tail).
 */
class MeetingListener {
  private readonly ctx = new AudioContext();
  private readonly mix: GainNode;
  private sources = new Map<string, MediaStreamAudioSourceNode>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private ring: PcmRing | null = null;
  /** Push to talk is held: chunks wait, so the tail isn't sent twice. */
  private held = false;
  // MediaRecorder fallback
  private analyser: AnalyserNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private chunk: Chunk | null = null;
  private lastLevel = performance.now();
  private readonly reconcileBound = () => this.reconcile();

  constructor(
    private room: Room,
    /** `pcm` (16 kHz) is there in PCM mode, for local transcription. */
    private onChunk: (blob: Blob, mime: string, durationMs: number, pcm: Int16Array<ArrayBuffer> | null) => void,
  ) {
    this.mix = this.ctx.createGain();
    for (const ev of LISTEN_EVENTS) room.on(ev, this.reconcileBound);
    // Device switches replace the underlying MediaStreamTrack without a room event in some paths.
    this.timers.push(setInterval(this.reconcileBound, 2000));
    this.reconcile();
  }

  /** Starts recording the mix; false when this browser can't (no AudioWorklet nor MediaRecorder). */
  async start(): Promise<boolean> {
    const ring = new PcmRing();
    const node = await pcmNode(this.ctx, (b) => ring.push(b)).catch(() => null);
    if (this.stopped) return true;
    if (node) {
      this.ring = ring;
      this.mix.connect(node);
      this.timers.push(setInterval(() => this.flush(), CONTEXT_CHUNK_MS));
      return true;
    }
    const mime = pickMime();
    if (!mime) return false;
    // mix → analyser → recorder stream (the analyser passes audio through, so it is always pulled).
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.dest = this.ctx.createMediaStreamDestination();
    this.mix.connect(this.analyser);
    this.analyser.connect(this.dest);
    this.timers.push(
      setInterval(() => this.level(), LEVEL_SAMPLE_MS),
      setInterval(() => this.rotate(mime), CONTEXT_CHUNK_MS),
    );
    this.rotate(mime);
    return true;
  }

  private reconcile() {
    if (this.stopped) return;
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    const want = new Map<string, MediaStreamTrack>();
    const add = (p: Participant) => {
      const track = p.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      if (track && track.readyState === "live") want.set(track.id, track);
    };
    add(this.room.localParticipant);
    for (const p of this.room.remoteParticipants.values()) add(p);
    for (const [id, node] of this.sources) {
      if (want.has(id)) continue;
      node.disconnect();
      this.sources.delete(id);
    }
    for (const [id, track] of want) {
      if (this.sources.has(id)) continue;
      try {
        const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
        node.connect(this.mix);
        this.sources.set(id, node);
      } catch {
        // track ended meanwhile: next reconcile
      }
    }
  }

  /* --- PCM mode */

  /** Uploads ring[from, to) as one context chunk if it has enough sound. */
  private sendRange(from: number, to: number) {
    if (!this.ring || to - from < PCM_RATE) return;
    const pcm = this.ring.slice(from, to);
    if (soundMs(pcm) < MIN_SOUND_MS) return;
    const blob = wavBlob([pcm]);
    if (blob.size <= VOICE_MAX_BYTES) this.onChunk(blob, "audio/wav", samplesToMs(pcm.length), pcm);
  }

  private flush() {
    const r = this.ring;
    if (this.stopped || !r || this.held) return;
    const to = r.written;
    const from = Math.max(r.sent, r.oldest(), to - msToSamples(CONTEXT_MAX_MS));
    r.sent = to;
    this.sendRange(from, to);
  }

  /** Push to talk starts: chunks wait; returns where the unsent meeting audio is (PCM mode only). */
  beginPress(): TailMark | null {
    if (this.stopped || !this.ring) return null;
    this.held = true;
    return { from: Math.max(this.ring.sent, this.ring.oldest()), to: this.ring.written };
  }

  /**
   * Push to talk ended. With `maxTailMs` (the command is being sent) returns the newest unsent
   * meeting audio from before the press (≤ maxTailMs, null if nearly silent) and marks it sent; an
   * older unsent part goes out as an ordinary chunk. Audio during the press is skipped (it is the
   * command). With null (press discarded) nothing is consumed.
   */
  endPress(mark: TailMark | null, maxTailMs: number | null): Int16Array<ArrayBuffer> | null {
    this.held = false;
    const r = this.ring;
    if (this.stopped || !r || !mark || maxTailMs == null) return null;
    const cut = Math.max(mark.from, mark.to - msToSamples(Math.max(0, maxTailMs)));
    r.sent = r.written;
    if (cut > mark.from) this.sendRange(mark.from, cut);
    const from = Math.max(cut, r.oldest());
    if (mark.to - from < PCM_RATE / 2) return null;
    const tail = r.slice(from, mark.to);
    return soundMs(tail) >= MIN_SOUND_MS ? tail : null;
  }

  /* --- MediaRecorder fallback */

  private level() {
    const now = performance.now();
    const dt = Math.min(1000, now - this.lastLevel);
    this.lastLevel = now;
    if (!this.chunk || !this.analyser || !this.buf) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    if (Math.sqrt(sum / this.buf.length) > SOUND_RMS) this.chunk.soundMs += dt;
  }

  private startChunk(mime: string): Chunk | null {
    if (!this.dest) return null;
    try {
      const mr = new MediaRecorder(this.dest.stream, { mimeType: mime, audioBitsPerSecond: AUDIO_BITRATE });
      const c: Chunk = { mr, parts: [], startedAt: performance.now(), soundMs: 0 };
      mr.ondataavailable = (e) => {
        if (e.data.size) c.parts.push(e.data);
      };
      mr.start();
      return c;
    } catch {
      return null;
    }
  }

  /** Starts the next chunk first, then closes the previous one, so nothing falls in between. */
  private rotate(mime: string) {
    if (this.stopped) return;
    const prev = this.chunk;
    this.chunk = this.startChunk(mime);
    if (!prev) return;
    const durationMs = Math.round(performance.now() - prev.startedAt);
    prev.mr.onstop = () => {
      const parts = prev.parts;
      prev.parts = [];
      if (this.stopped || prev.soundMs < MIN_SOUND_MS) return;
      const type = baseMime(prev.mr, mime);
      const blob = new Blob(parts, { type });
      if (blob.size > 0 && blob.size <= VOICE_MAX_BYTES) this.onChunk(blob, type, Math.min(durationMs, CONTEXT_MAX_MS), null);
    };
    try {
      prev.mr.stop();
    } catch {
      // already stopped
    }
  }

  /** Stops capturing; audio not sent yet is discarded. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const ev of LISTEN_EVENTS) this.room.off(ev, this.reconcileBound);
    const c = this.chunk;
    this.chunk = null;
    if (c) {
      c.mr.ondataavailable = null;
      c.mr.onstop = null;
      c.parts = [];
      try {
        if (c.mr.state !== "inactive") c.mr.stop();
      } catch {
        // already stopped
      }
    }
    this.ring = null;
    for (const node of this.sources.values()) node.disconnect();
    this.sources.clear();
    void this.ctx.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------ push to talk */

type Press = {
  released: boolean;
  tracks: MediaStreamTrack[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The meeting listener when the press started, and where its unsent audio was. */
  listener: MeetingListener | null;
  mark: TailMark | null;
  /** PCM capture (AudioWorklet)… */
  ctx: AudioContext | null;
  pcm: Float32Array[] | null;
  /** …or the MediaRecorder fallback. */
  mr: MediaRecorder | null;
  parts: Blob[];
};

const stopTracks = (p: Press) => {
  for (const t of p.tracks) t.stop();
  p.tracks = [];
};

/** Releases everything a press holds; the meeting listener keeps its unsent audio. */
function dropPress(p: Press) {
  p.released = true;
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  if (p.mr) {
    p.mr.ondataavailable = null;
    p.mr.onstop = null;
    try {
      if (p.mr.state !== "inactive") p.mr.stop();
    } catch {
      // already stopped
    }
  }
  void p.ctx?.close().catch(() => undefined);
  p.ctx = null;
  stopTracks(p);
  p.listener?.endPress(p.mark, null);
  p.listener = null;
}

/**
 * The local user's own voice for a command: a clone of the published microphone when it is live
 * and on, otherwise a private capture (muted in the call: the room must not hear it).
 */
async function acquireMic(room: Room): Promise<MediaStreamTrack> {
  const lp = room.localParticipant;
  const pub = lp.getTrackPublication(Track.Source.Microphone);
  const live = pub?.track?.mediaStreamTrack;
  if (lp.isMicrophoneEnabled && !pub?.isMuted && live && live.readyState === "live" && live.enabled) return live.clone();
  const deviceId = room.getActiveDevice("audioinput");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId && deviceId !== "default" ? { deviceId: { ideal: deviceId } } : {}),
    },
  });
  const [track, ...rest] = stream.getAudioTracks();
  for (const t of rest) t.stop();
  if (!track) throw new Error("no audio track");
  return track;
}

/* -------------------------------------------------------------------- hook */

export function useClaudeCommands(
  room: Room,
  roomName: string,
  opts: {
    panelOpen: boolean;
    notify: (n: ClaudeNotice) => void;
    onTalk?: () => void;
    /** Hold-"C" push to talk; off while the call is minimised elsewhere in the app. */
    hotkey: boolean;
  },
) {
  /** "Claude listens to the meeting" toggle (remembered on this device). */
  const [listen, setListenState] = useState(false);
  /** Announced and capturing meeting audio right now. */
  const [capturing, setCapturing] = useState(false);
  const [others, setOthers] = useState<ClaudeListener[]>([]);
  const [supported, setSupported] = useState(true);
  const [data, setData] = useState<CommandsResponse | null>(null);
  const [problem, setProblem] = useState<VoiceProblem>(null);
  /** Push to talk is held (recording, or getting the microphone). */
  const [talking, setTalking] = useState(false);
  /** Command clips uploaded and not answered yet (one transcribing, the rest queued on the server). */
  const [transcribing, setTranscribing] = useState(0);
  const [heard, setHeard] = useState<{ text: string; at: number } | null>(null);
  /** Voice commands just accepted, shown as "Claude is processing…" until the bridge picks them up. */
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const notifyRef = useRef(opts.notify);
  notifyRef.current = opts.notify;
  const onTalkRef = useRef(opts.onTalk);
  onTalkRef.current = opts.onTalk;
  const seen = useRef(new Map<string, CommandView["status"]>());
  const first = useRef(true);
  const press = useRef<Press | null>(null);
  /** The meeting listener while capturing (push to talk takes its unsent tail). */
  const listenerRef = useRef<MeetingListener | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    setSupported(voiceSupported());
    setListenState(readPref() && listenSupported());
  }, []);

  const setListen = useCallback((on: boolean) => {
    setListenState(on);
    if (on) setProblem(null);
    writePref(on);
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
  const busy =
    listen ||
    talking ||
    transcribing > 0 ||
    opts.panelOpen ||
    !!data?.commands.some((c) => !isFinalStatus(c.status)) ||
    !!data?.confirmations.length;
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), busy ? 2000 : 15_000);
    return () => clearInterval(id);
  }, [refresh, busy]);

  /** Handles the server's answer to a command or context clip (audio or text). */
  const settle = useCallback(
    async (res: Response, command: boolean) => {
      if (res.status === 412 || res.status === 503) {
        const p = res.status === 412 ? "noToken" : "notConfigured";
        setProblem(p);
        setListenState(false);
        return notifyRef.current({ kind: p });
      }
      // 429 for a context chunk: superseded by a newer one (the server keeps the newest).
      if (!command || !res.ok || res.redirected) return;
      const body = (await res.json()) as VoiceResponse;
      if (body.heard) setHeard({ text: body.heard.slice(0, 200), at: Date.now() });
      else notifyRef.current({ kind: "nothingHeard" });
      if (body.action) notifyRef.current({ kind: body.action });
      const cmd = body.command;
      if (cmd) {
        if (!seen.current.has(cmd.id)) notifyRef.current({ kind: "queued", command: cmd });
        seen.current.set(cmd.id, cmd.status);
        // Optimistic: show it right away, before the next poll.
        if (cmd.status === "queued") setAccepted((prev) => new Set(prev).add(cmd.id));
        setData((prev) => (prev && !prev.commands.some((c) => c.id === cmd.id) ? { ...prev, commands: [cmd, ...prev.commands] } : prev));
      }
      if (cmd || body.action) void refresh();
    },
    [refresh],
  );

  const upload = useCallback(
    async (kind: VoiceKind, blob: Blob, mime: string, durationMs: number, contextMs = 0) => {
      const form = new FormData();
      form.set("kind", kind);
      form.set("room", roomName);
      form.set("mime", mime);
      form.set("duration", String(Math.round(durationMs)));
      form.set("timeZone", timeZone());
      if (contextMs > 0) form.set("contextMs", String(Math.round(contextMs)));
      form.set("file", blob, "clip");
      const command = kind === "command";
      if (command) setTranscribing((n) => n + 1);
      try {
        await settle(await fetch("/api/meet/voice", { method: "POST", body: form }), command);
      } catch {
        // dropped clip (offline): nothing to retry, the speaker can repeat
      } finally {
        if (command) setTranscribing((n) => Math.max(0, n - 1));
      }
    },
    [roomName, settle],
  );

  /* ----- local transcription (only text leaves the browser) */

  const local = useLocalStt();
  const localRef = useRef(local);
  localRef.current = local;

  const postText = useCallback(
    (body: VoiceTextRequest) =>
      fetch("/api/meet/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    [],
  );

  /**
   * Push to talk, transcribed here: the command first (it is what the user waits for), then the
   * meeting tail; both go up as text. If the GPU fails, `fallback` uploads the clip instead.
   */
  const sendLocalCommand = useCallback(
    async (command: Int16Array, tail: Int16Array | null, fallback: () => void) => {
      setTranscribing((n) => n + 1);
      try {
        let said;
        try {
          said = await transcribeLocal(pcmToFloat(command), "command");
        } catch {
          return fallback();
        }
        const context = tail ? await transcribeLocal(pcmToFloat(tail), "command").catch(() => null) : null;
        const text = said.text.slice(0, COMMAND_MAX_CHARS);
        const ctx = context?.text.slice(-VOICE_CONTEXT_MAX_CHARS) ?? "";
        if (!text && !ctx) return notifyRef.current({ kind: "nothingHeard" });
        const body: VoiceTextRequest = { kind: "command-text", room: roomName, command: text, timeZone: timeZone() };
        if (ctx) body.context = ctx;
        if (said.language) body.lang = said.language;
        await settle(await postText(body), true);
      } catch {
        // offline: the speaker can repeat
      } finally {
        setTranscribing((n) => Math.max(0, n - 1));
      }
    },
    [roomName, postText, settle],
  );

  /** A meeting chunk: transcribed here when the local model is ready, otherwise uploaded. */
  const sendContext = useCallback(
    async (blob: Blob, mime: string, durationMs: number, pcm: Int16Array | null) => {
      if (!pcm || !localRef.current.active) return upload("context", blob, mime, durationMs);
      let heard;
      try {
        heard = await transcribeLocal(pcmToFloat(pcm), "context");
      } catch (e) {
        // Dropped behind newer chunks: fine. A GPU failure: this one goes to the server.
        if (!(e instanceof LocalSttDropped)) await upload("context", blob, mime, durationMs);
        return;
      }
      const text = heard.text.slice(0, VOICE_CONTEXT_MAX_CHARS);
      if (!text) return;
      try {
        const body: VoiceTextRequest = { kind: "context-text", room: roomName, context: text, timeZone: timeZone() };
        if (heard.language) body.lang = heard.language;
        await settle(await postText(body), false);
      } catch {
        // offline: this piece of context is lost
      }
    },
    [roomName, upload, postText, settle],
  );

  const localCommandRef = useRef(sendLocalCommand);
  localCommandRef.current = sendLocalCommand;
  const contextRef = useRef(sendContext);
  contextRef.current = sendContext;

  // The model loads only once Claude is used: panel opened, meeting listening on, or push to talk.
  useEffect(() => {
    if (local.wanted && (opts.panelOpen || listen)) loadLocalStt();
  }, [local.wanted, opts.panelOpen, listen]);

  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  /* ----- push to talk */

  const finishPress = useCallback((p: Press) => {
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (press.current === p) press.current = null;
    setTalking(false);
  }, []);

  const endTalk = useCallback(() => {
    const p = press.current;
    if (!p || p.released) return;
    p.released = true;
    // Still getting the microphone: startTalk cleans up when it resolves.
    if (!p.pcm && !p.mr) return;
    finishPress(p);
    const listener = p.listener;
    p.listener = null;

    if (p.pcm) {
      const command = toInt16(p.pcm);
      p.pcm = null;
      void p.ctx?.close().catch(() => undefined);
      p.ctx = null;
      stopTracks(p);
      const commandMs = samplesToMs(command.length);
      if (commandMs < PTT_MIN_MS) {
        listener?.endPress(p.mark, null);
        return notifyRef.current({ kind: "tooShort" });
      }
      // The unsent meeting audio before the press rides along (one Whisper window for both).
      const tail = listener?.endPress(p.mark, Math.min(CONTEXT_TAIL_MAX_MS, VOICE_MAX_TOTAL_MS - TAIL_GAP_MS - commandMs)) ?? null;
      const parts = tail ? [tail, new Int16Array(msToSamples(TAIL_GAP_MS)), command] : [command];
      const contextMs = tail ? samplesToMs(tail.length) + TAIL_GAP_MS / 2 : 0;
      const blob = wavBlob(parts);
      const totalMs = samplesToMs(parts.reduce((n, x) => n + x.length, 0));
      const upload = () => {
        if (blob.size <= VOICE_MAX_BYTES) void uploadRef.current("command", blob, "audio/wav", totalMs, contextMs);
      };
      if (localRef.current.active) void localCommandRef.current(command, tail, upload);
      else upload();
      return;
    }

    listener?.endPress(p.mark, null);
    const durationMs = performance.now() - p.startedAt;
    const mr = p.mr!;
    mr.onstop = () => {
      stopTracks(p);
      const parts = p.parts;
      p.parts = [];
      if (durationMs < PTT_MIN_MS) return notifyRef.current({ kind: "tooShort" });
      const type = baseMime(mr, "audio/webm");
      const blob = new Blob(parts, { type });
      if (blob.size > 0 && blob.size <= VOICE_MAX_BYTES) void uploadRef.current("command", blob, type, Math.min(durationMs, VOICE_MAX_CLIP_MS), 0);
    };
    try {
      mr.stop();
    } catch {
      stopTracks(p);
    }
  }, [finishPress]);

  const startTalk = useCallback(async () => {
    if (press.current) return;
    // Claude's spoken reply stops here so it doesn't talk over the user.
    onTalkRef.current?.();
    if (localRef.current.wanted) loadLocalStt();
    if (dataRef.current && !dataRef.current.hasWriteToken) {
      setProblem("noToken");
      return notifyRef.current({ kind: "noToken" });
    }
    if (!voiceSupported()) {
      setProblem("unsupported");
      return notifyRef.current({ kind: "unsupported" });
    }
    const listener = listenerRef.current;
    const p: Press = {
      released: false,
      tracks: [],
      startedAt: 0,
      timer: null,
      listener,
      // Taken at the press: the meeting audio from before it, not what is said while holding.
      mark: listener?.beginPress() ?? null,
      // Created inside the key/pointer handler (user activation) so it starts running.
      ctx: typeof AudioContext !== "undefined" ? new AudioContext() : null,
      pcm: null,
      mr: null,
      parts: [],
    };
    press.current = p;
    setTalking(true);
    const fail = (kind: "tooShort" | "micFailed") => {
      dropPress(p);
      finishPress(p);
      notifyRef.current({ kind });
    };
    let track: MediaStreamTrack;
    try {
      track = await acquireMic(room);
    } catch {
      return fail("micFailed");
    }
    p.tracks = [track];
    // Let go before the microphone was ready.
    if (p.released || press.current !== p) return fail("tooShort");

    const ctx = p.ctx;
    const blocks: Float32Array[] = [];
    const node = ctx ? await pcmNode(ctx, (b) => blocks.push(b)).catch(() => null) : null;
    if (p.released || press.current !== p) return fail("tooShort");
    if (ctx && node) {
      try {
        ctx.createMediaStreamSource(new MediaStream([track])).connect(node);
        if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
        p.pcm = blocks;
      } catch {
        // falls back to MediaRecorder below
      }
    }
    if (!p.pcm) {
      void ctx?.close().catch(() => undefined);
      p.ctx = null;
      const mime = pickMime();
      try {
        if (!mime) throw new Error("no recorder");
        const mr = new MediaRecorder(new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: AUDIO_BITRATE });
        mr.ondataavailable = (e) => {
          if (e.data.size) p.parts.push(e.data);
        };
        mr.start();
        p.mr = mr;
      } catch {
        return fail("micFailed");
      }
    }
    p.startedAt = performance.now();
    p.timer = setTimeout(endTalk, VOICE_MAX_CLIP_MS);
  }, [room, endTalk, finishPress]);

  const talkRef = useRef({ startTalk, endTalk });
  talkRef.current = { startTalk, endTalk };

  // Hold "C" anywhere in the call (not while typing) to talk to Claude.
  const hotkey = opts.hotkey;
  useEffect(() => {
    if (!hotkey) return;
    let heldCode: string | null = null;
    const release = () => {
      if (heldCode == null) return;
      heldCode = null;
      talkRef.current.endTalk();
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingTarget(e.target) || typingTarget(document.activeElement)) return;
      e.preventDefault();
      if (e.repeat || heldCode != null) return;
      heldCode = e.code;
      void talkRef.current.startTalk();
    };
    const onUp = (e: KeyboardEvent) => {
      if (heldCode != null && e.code === heldCode) release();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onHidden);
      release();
    };
  }, [hotkey]);

  // Leaving the call drops a press in progress.
  useEffect(
    () => () => {
      const p = press.current;
      press.current = null;
      if (p) dropPress(p);
    },
    [],
  );

  /* ----- "Claude listens to the meeting" */

  // Announce first; capture only once the notice went out. Heartbeat for late joiners.
  useEffect(() => {
    if (!listen) return;
    if (!listenSupported()) {
      setProblem("unsupported");
      setListenState(false);
      notifyRef.current({ kind: "unsupported" });
      return;
    }
    let cancelled = false;
    let listener: MeetingListener | null = null;
    const send = (on: boolean, to?: string[]) =>
      room.localParticipant.publishData(encoder.encode(JSON.stringify({ type: "listen", on } satisfies ClaudeListenSignal)), {
        reliable: true,
        topic: CLAUDE_LISTEN_TOPIC,
        destinationIdentities: to,
      });
    const begin = async () => {
      try {
        await send(true);
      } catch {
        return; // not announced: no capture; retried on the next heartbeat
      }
      if (cancelled || listener) return;
      let next: MeetingListener | null = null;
      try {
        next = new MeetingListener(room, (blob, type, ms, pcm) => void contextRef.current(blob, type, ms, pcm));
        listener = next;
        if (!(await next.start())) throw new Error("unsupported");
        if (cancelled) return;
        listenerRef.current = next;
        setCapturing(true);
      } catch {
        next?.stop();
        listener = null;
        if (cancelled) return;
        setProblem("unsupported");
        setListenState(false);
      }
    };
    void begin();
    const beat = setInterval(() => {
      if (listener) void send(true).catch(() => undefined);
      else void begin();
    }, LISTEN_HEARTBEAT_MS);
    const onJoined = (p: RemoteParticipant) => {
      if (listener) void send(true, [p.identity]).catch(() => undefined);
    };
    room.on(RoomEvent.ParticipantConnected, onJoined);
    return () => {
      cancelled = true;
      clearInterval(beat);
      room.off(RoomEvent.ParticipantConnected, onJoined);
      if (listenerRef.current === listener) listenerRef.current = null;
      listener?.stop();
      setCapturing(false);
      void send(false).catch(() => undefined);
    };
  }, [listen, room]);

  // Other participants' notices: a persistent banner while their Claude listens.
  useEffect(() => {
    const active = new Map<string, { name: string; last: number }>();
    const sync = () => setOthers([...active].map(([identity, v]) => ({ identity, name: v.name })));
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== CLAUDE_LISTEN_TOPIC || !participant) return;
      let signal: Partial<ClaudeListenSignal>;
      try {
        signal = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      if (signal?.type !== "listen") return;
      const id = participant.identity;
      if (signal.on === true) {
        const name = displayName(participant);
        const isNew = !active.has(id);
        active.set(id, { name, last: Date.now() });
        if (isNew) {
          sync();
          notifyRef.current({ kind: "listenStarted", name });
        }
      } else if (active.delete(id)) sync();
    };
    const onLeft = (p: RemoteParticipant) => {
      if (active.delete(p.identity)) sync();
    };
    const tick = setInterval(() => {
      let changed = false;
      for (const [id, v] of active) {
        if (Date.now() - v.last > STALE_LISTEN_MS) changed = active.delete(id) || changed;
      }
      if (changed) sync();
    }, LISTEN_HEARTBEAT_MS);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      clearInterval(tick);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);

  /* ----- typed commands, confirmations, results */

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
    /** Push to talk works in this browser. */
    supported,
    listen,
    setListen,
    capturing,
    others,
    talking,
    startTalk,
    endTalk,
    data,
    problem,
    transcribing,
    heard: heard?.text ?? null,
    accepted,
    /** Local (GPU) transcription: the setting, the model's state, and whether it is in use. */
    local,
    ask,
    decide,
    cancel,
    share,
  };
}
