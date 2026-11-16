"use client";

// "Claude commands" for the LOCAL user: they talk to THEIR OWN Claude Code (bridge) during a call.
// - Push to talk: while the panel button or the "C" key is held, their own voice is recorded (a
//   clone of the published mic, or a private capture when muted in the call, so the room never
//   hears it) and sent to /api/meet/voice as kind=command; the whole clip is the command.
// - "Claude listens to the meeting" (opt-in, announced to everyone over the data channel before
//   anything is captured): their browser mixes every participant's microphone and sends ~15 s
//   chunks as kind=context, so commands come with what was said in the meeting.
// Also polls their commands / pending confirmations in this room. Results stay private to the
// user (only the short spoken summary is shared, by useClaudeVoice).
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLAUDE_LISTEN_PREF,
  CLAUDE_LISTEN_TOPIC,
  CONTEXT_CHUNK_MS,
  isFinalStatus,
  PTT_MIN_MS,
  VOICE_MAX_BYTES,
  VOICE_MAX_CLIP_MS,
  type ClaudeListenSignal,
  type CommandsResponse,
  type CommandView,
  type VoiceKind,
  type VoiceResponse,
} from "./claude";
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
  return typeof window !== "undefined" && !!pickMime() && !!navigator.mediaDevices?.getUserMedia;
}

function listenSupported(): boolean {
  return typeof window !== "undefined" && !!pickMime() && typeof AudioContext !== "undefined";
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

/** Level (RMS) above which a sample counts as sound (≈ −40 dBFS). */
const SOUND_RMS = 0.01;
/** Chunks with less sound than this are not uploaded (the server also runs VAD). */
const MIN_SOUND_MS = 1000;
const LEVEL_SAMPLE_MS = 200;

type Chunk = { mr: MediaRecorder; parts: Blob[]; startedAt: number; soundMs: number };

/**
 * Mixes every microphone in the room (local + each subscribed remote track, following tracks that
 * come and go) into one stream with Web Audio and records it in CONTEXT_CHUNK_MS chunks; recorders
 * are rotated so each chunk is a standalone file. Nearly silent chunks are dropped.
 */
class MeetingListener {
  private readonly ctx = new AudioContext();
  private readonly mix: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private sources = new Map<string, MediaStreamAudioSourceNode>();
  private chunk: Chunk | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastLevel = performance.now();
  private stopped = false;
  private readonly reconcileBound = () => this.reconcile();

  constructor(
    private room: Room,
    private mime: string,
    private onChunk: (blob: Blob, mime: string, durationMs: number) => void,
  ) {
    this.mix = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.dest = this.ctx.createMediaStreamDestination();
    // mix → analyser → recorder stream (the analyser passes audio through, so it is always pulled).
    this.mix.connect(this.analyser);
    this.analyser.connect(this.dest);
    for (const ev of LISTEN_EVENTS) room.on(ev, this.reconcileBound);
    this.timers.push(
      // Device switches replace the underlying MediaStreamTrack without a room event in some paths.
      setInterval(this.reconcileBound, 2000),
      setInterval(() => this.level(), LEVEL_SAMPLE_MS),
      setInterval(() => this.rotate(), CONTEXT_CHUNK_MS),
    );
    this.reconcile();
    this.rotate();
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

  private level() {
    const now = performance.now();
    const dt = Math.min(1000, now - this.lastLevel);
    this.lastLevel = now;
    if (!this.chunk) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    if (Math.sqrt(sum / this.buf.length) > SOUND_RMS) this.chunk.soundMs += dt;
  }

  private startChunk(): Chunk | null {
    try {
      const mr = new MediaRecorder(this.dest.stream, { mimeType: this.mime, audioBitsPerSecond: AUDIO_BITRATE });
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
  private rotate() {
    if (this.stopped) return;
    const prev = this.chunk;
    this.chunk = this.startChunk();
    if (!prev) return;
    const durationMs = Math.round(performance.now() - prev.startedAt);
    prev.mr.onstop = () => {
      const parts = prev.parts;
      prev.parts = [];
      if (this.stopped || prev.soundMs < MIN_SOUND_MS) return;
      const type = baseMime(prev.mr, this.mime);
      const blob = new Blob(parts, { type });
      if (blob.size > 0 && blob.size <= VOICE_MAX_BYTES) this.onChunk(blob, type, Math.min(durationMs, CONTEXT_CHUNK_MS + 2000));
    };
    try {
      prev.mr.stop();
    } catch {
      // already stopped
    }
  }

  /** Stops capturing; the chunk in progress is discarded. */
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
    for (const node of this.sources.values()) node.disconnect();
    this.sources.clear();
    void this.ctx.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------ push to talk */

type Press = {
  released: boolean;
  tracks: MediaStreamTrack[];
  mr: MediaRecorder | null;
  parts: Blob[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const stopTracks = (p: Press) => {
  for (const t of p.tracks) t.stop();
  p.tracks = [];
};

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
  opts: { panelOpen: boolean; notify: (n: ClaudeNotice) => void; onTalk?: () => void },
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

  const upload = useCallback(
    async (kind: VoiceKind, blob: Blob, mime: string, durationMs: number) => {
      const form = new FormData();
      form.set("kind", kind);
      form.set("room", roomName);
      form.set("mime", mime);
      form.set("duration", String(Math.round(durationMs)));
      form.set("timeZone", timeZone());
      form.set("file", blob, "clip");
      const command = kind === "command";
      if (command) setTranscribing((n) => n + 1);
      try {
        const res = await fetch("/api/meet/voice", { method: "POST", body: form });
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
      } catch {
        // dropped clip (offline): nothing to retry, the speaker can repeat
      } finally {
        if (command) setTranscribing((n) => Math.max(0, n - 1));
      }
    },
    [roomName, refresh],
  );
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
    if (!p.mr) return;
    finishPress(p);
    const durationMs = performance.now() - p.startedAt;
    const mr = p.mr;
    mr.onstop = () => {
      stopTracks(p);
      const parts = p.parts;
      p.parts = [];
      if (durationMs < PTT_MIN_MS) return notifyRef.current({ kind: "tooShort" });
      const type = baseMime(mr, "audio/webm");
      const blob = new Blob(parts, { type });
      if (blob.size > 0 && blob.size <= VOICE_MAX_BYTES) void uploadRef.current("command", blob, type, Math.min(durationMs, VOICE_MAX_CLIP_MS));
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
    if (dataRef.current && !dataRef.current.hasWriteToken) {
      setProblem("noToken");
      return notifyRef.current({ kind: "noToken" });
    }
    const mime = pickMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      setProblem("unsupported");
      return notifyRef.current({ kind: "unsupported" });
    }
    const p: Press = { released: false, tracks: [], mr: null, parts: [], startedAt: 0, timer: null };
    press.current = p;
    setTalking(true);
    let track: MediaStreamTrack;
    try {
      track = await acquireMic(room);
    } catch {
      finishPress(p);
      return notifyRef.current({ kind: "micFailed" });
    }
    p.tracks = [track];
    if (p.released || press.current !== p) {
      // Let go before the microphone was ready.
      stopTracks(p);
      finishPress(p);
      return notifyRef.current({ kind: "tooShort" });
    }
    try {
      const mr = new MediaRecorder(new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: AUDIO_BITRATE });
      mr.ondataavailable = (e) => {
        if (e.data.size) p.parts.push(e.data);
      };
      mr.start();
      p.mr = mr;
      p.startedAt = performance.now();
      p.timer = setTimeout(endTalk, VOICE_MAX_CLIP_MS);
    } catch {
      stopTracks(p);
      finishPress(p);
      notifyRef.current({ kind: "micFailed" });
    }
  }, [room, endTalk, finishPress]);

  const talkRef = useRef({ startTalk, endTalk });
  talkRef.current = { startTalk, endTalk };

  // Hold "C" anywhere in the call (not while typing) to talk to Claude.
  useEffect(() => {
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
    };
  }, []);

  // Leaving the call drops a press in progress.
  useEffect(
    () => () => {
      const p = press.current;
      press.current = null;
      if (!p) return;
      p.released = true;
      if (p.timer) clearTimeout(p.timer);
      if (p.mr) {
        p.mr.ondataavailable = null;
        p.mr.onstop = null;
        try {
          if (p.mr.state !== "inactive") p.mr.stop();
        } catch {
          // already stopped
        }
      }
      stopTracks(p);
    },
    [],
  );

  /* ----- "Claude listens to the meeting" */

  // Announce first; capture only once the notice went out. Heartbeat for late joiners.
  useEffect(() => {
    if (!listen) return;
    const mime = pickMime();
    if (!mime || !listenSupported()) {
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
      try {
        listener = new MeetingListener(room, mime, (blob, type, ms) => void uploadRef.current("context", blob, type, ms));
        setCapturing(true);
      } catch {
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
    ask,
    decide,
    cancel,
    share,
  };
}
