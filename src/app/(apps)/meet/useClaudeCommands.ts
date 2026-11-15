"use client";

// "Claude commands" for the LOCAL user only: when they opt in, short rolling windows of their own
// microphone (never other participants' audio) go to /api/meet/voice, which queues "Claude, …"
// for their own Claude Code bridge. Also polls their commands / pending confirmations in this room.
// Nothing here is sent over the LiveKit data channel: results stay private to the speaker.
import { Room, Track } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLAUDE_COMMANDS_PREF,
  isFinalStatus,
  VOICE_MAX_BYTES,
  VOICE_OVERLAP_MS,
  VOICE_WINDOW_MS,
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

const SILENCE_RMS = 0.015;

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

/**
 * Records the local microphone in overlapping windows: a new MediaRecorder starts every
 * (window − overlap) ms and stops after `window` ms, so each window is a standalone file. Silent
 * windows (muted mic, nobody talking) are dropped in the browser and never uploaded.
 */
class VoiceCapture {
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sourceTrack: MediaStreamTrack | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private voicedAt = 0;
  private active = new Set<MediaRecorder>();

  constructor(
    private getTrack: () => MediaStreamTrack | null,
    private onWindow: (blob: Blob, mime: string, durationMs: number) => void,
  ) {
    this.timer = setInterval(() => this.startWindow(), VOICE_WINDOW_MS - VOICE_OVERLAP_MS);
    this.levelTimer = setInterval(() => this.sampleLevel(), 100);
    this.startWindow();
  }

  /** Tracks when the mic last carried sound (RMS over a threshold). Without Web Audio, assume voiced. */
  private sampleLevel() {
    const track = this.getTrack();
    if (!track) return;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
      if (this.sourceTrack !== track) {
        this.source?.disconnect();
        this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.source.connect(this.analyser);
        this.sourceTrack = track;
      }
      const buf = new Float32Array(this.analyser!.fftSize);
      this.analyser!.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      if (Math.sqrt(sum / buf.length) > SILENCE_RMS) this.voicedAt = performance.now();
    } catch {
      this.voicedAt = performance.now();
    }
  }

  private startWindow() {
    if (this.stopped) return;
    const track = this.getTrack();
    const mime = pickMime();
    if (!track || track.readyState !== "live" || !track.enabled || !mime) return;
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: 32_000 });
    } catch {
      return;
    }
    const startedAt = performance.now();
    const parts: Blob[] = [];
    mr.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    mr.onstop = () => {
      this.active.delete(mr);
      const durationMs = Math.round(performance.now() - startedAt);
      const voiced = this.voicedAt >= startedAt;
      if (this.stopped || !voiced || durationMs < 1000) return;
      const blob = new Blob(parts, { type: (mr.mimeType || mime).split(";")[0] });
      if (blob.size > 0 && blob.size <= VOICE_MAX_BYTES) this.onWindow(blob, blob.type, durationMs);
    };
    try {
      mr.start();
    } catch {
      return;
    }
    this.active.add(mr);
    setTimeout(() => {
      if (mr.state !== "inactive") {
        try {
          mr.stop();
        } catch {
          // already stopped
        }
      }
    }, VOICE_WINDOW_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    for (const mr of this.active) {
      try {
        mr.stop();
      } catch {
        // ignore
      }
    }
    this.active.clear();
    this.source?.disconnect();
    void this.ctx?.close().catch(() => undefined);
  }
}

export function voiceSupported(): boolean {
  return typeof window !== "undefined" && !!pickMime() && !!navigator.mediaDevices;
}

function readPref(): boolean {
  try {
    return localStorage.getItem(CLAUDE_COMMANDS_PREF) === "1";
  } catch {
    return false;
  }
}

export function useClaudeCommands(room: Room, roomName: string, opts: { panelOpen: boolean; notify: (n: ClaudeNotice) => void }) {
  const [enabled, setEnabledState] = useState(false);
  const [data, setData] = useState<CommandsResponse | null>(null);
  const [problem, setProblem] = useState<VoiceProblem>(null);
  const [heardAt, setHeardAt] = useState(0);
  const [capturing, setCapturing] = useState(false);
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
      form.set("file", blob, "window");
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
        if (!res.ok || res.redirected) return;
        const body = (await res.json()) as VoiceResponse;
        if (body.heard) setHeardAt(Date.now());
        setCapturing(!!body.capturing);
        if (body.action) notifyRef.current({ kind: body.action });
        if (body.command) {
          if (!seen.current.has(body.command.id)) notifyRef.current({ kind: "queued", command: body.command });
          seen.current.set(body.command.id, body.command.status);
        }
        if (body.command || body.action) void refresh();
      } catch {
        // dropped window: the next one follows in a few seconds
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
    const capture = new VoiceCapture(() => {
      const lp = room.localParticipant;
      if (!lp.isMicrophoneEnabled) return null;
      return lp.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
    }, (blob, mime, ms) => void upload(blob, mime, ms));
    return () => {
      capture.stop();
      setCapturing(false);
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

  // "Listening" indicator: something was heard in the last few seconds.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  const hearing = enabled && Date.now() - heardAt < 7000;

  return { enabled, setEnabled, data, problem, hearing, capturing, ask, decide, cancel, share };
}
