"use client";

// Meeting recording in the browser of the participant who starts it. Optionally ("video") the
// server also records the room as an MP4 with LiveKit egress; audio for the transcript is still
// recorded here.
// Every speaker's microphone track (local + each remote) is recorded separately with
// MediaRecorder and uploaded in chunks; tracks that come and go mid-meeting start new segments
// with their offset from the start of the recording. Everyone in the call learns about the
// recording over the data channel (topic REC_TOPIC), including people who join later.
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { displayName } from "./media";
import { AUDIO_BITRATE, AUDIO_MIMES, CHUNK_INTERVAL_MS, REC_TOPIC, type RecSignal } from "./recording";

export type ActiveRecording = { id: string; by: string; byName: string; since: number; mine: boolean; video: boolean };
export type RecordingMode = "audio" | "video";
export type RecordingNotice =
  | { kind: "started"; name: string; mine: boolean }
  | { kind: "stopped" }
  | { kind: "busy" | "startFailed" | "uploadFailed" | "tooLarge" | "unsupported" | "videoFailed" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEARTBEAT_MS = 10_000;
const STALE_SIGNAL_MS = 35_000;
const FLUSH_TIMEOUT_MS = 20_000;

const RECONCILE_EVENTS = [
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ActiveDeviceChanged,
  RoomEvent.TrackUnmuted,
] as const;

export function recordingSupported(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!pickMime();
}

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

const baseMime = (m: string, fallback: string) => {
  const base = m.split(";")[0].trim().toLowerCase();
  return (AUDIO_MIMES as readonly string[]).includes(base) ? base : fallback.split(";")[0];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Fatal = "uploadFailed" | "tooLarge" | "gone";

type SegmentRecorder = {
  segment: string;
  identity: string;
  name: string;
  offset: number;
  mime: string;
  mr: MediaRecorder;
  seq: number;
  broken: boolean;
  done: Promise<void>;
};

/** Records every microphone in the room into per-speaker segments and uploads them. */
class MeetingRecorder {
  private t0 = performance.now();
  private recs = new Map<string, SegmentRecorder>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastUpload = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private readonly reconcileBound = () => this.reconcile();

  constructor(
    private room: Room,
    readonly id: string,
    private onFatal: (reason: Fatal) => void,
  ) {
    for (const ev of RECONCILE_EVENTS) room.on(ev, this.reconcileBound);
    // Device switches replace the underlying MediaStreamTrack without a room event in some paths.
    this.timer = setInterval(this.reconcileBound, 2000);
    // Keeps the server from treating a recording without any audio (nobody has a mic) as abandoned.
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastUpload < 60_000) return;
      void fetch(`/api/meet/recordings/${this.id}`, { method: "PUT" })
        .then((res) => {
          if (res.status === 404 || res.status === 410 || res.redirected) this.onFatal("gone");
          else if (res.ok) this.lastUpload = Date.now();
        })
        .catch(() => undefined);
    }, 30_000);
    this.reconcile();
  }

  private wanted(): Map<string, { track: MediaStreamTrack; participant: Participant }> {
    const out = new Map<string, { track: MediaStreamTrack; participant: Participant }>();
    const add = (participant: Participant) => {
      const track = participant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      if (track && track.readyState === "live") out.set(track.id, { track, participant });
    };
    add(this.room.localParticipant);
    for (const p of this.room.remoteParticipants.values()) add(p);
    return out;
  }

  private reconcile() {
    if (this.stopped) return;
    const want = this.wanted();
    for (const [key, rec] of this.recs) {
      if (!want.has(key) || rec.broken || rec.mr.state === "inactive") {
        this.finish(rec);
        this.recs.delete(key);
      }
    }
    for (const [key, { track, participant }] of want) {
      if (!this.recs.has(key)) {
        const rec = this.begin(track, participant);
        if (rec) this.recs.set(key, rec);
      }
    }
  }

  private begin(track: MediaStreamTrack, participant: Participant): SegmentRecorder | null {
    const preferred = pickMime();
    if (!preferred) return null;
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(new MediaStream([track]), { mimeType: preferred, audioBitsPerSecond: AUDIO_BITRATE });
    } catch {
      return null;
    }
    let resolveDone!: () => void;
    const rec: SegmentRecorder = {
      segment: crypto.randomUUID(),
      identity: participant.identity,
      name: displayName(participant),
      offset: Math.round(performance.now() - this.t0),
      mime: baseMime(mr.mimeType || preferred, preferred),
      mr,
      seq: 0,
      broken: false,
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) {
        const seq = rec.seq++;
        this.queue = this.queue.then(() => this.upload(rec, seq, e.data));
      }
    };
    mr.onstop = () => resolveDone();
    mr.onerror = () => resolveDone();
    try {
      mr.start(CHUNK_INTERVAL_MS);
    } catch {
      return null;
    }
    return rec;
  }

  private finish(rec: SegmentRecorder) {
    if (rec.mr.state !== "inactive") {
      try {
        rec.mr.stop();
      } catch {
        // already stopping
      }
    }
  }

  private async upload(rec: SegmentRecorder, seq: number, blob: Blob): Promise<void> {
    if (rec.broken) return;
    const form = new FormData();
    form.set("segment", rec.segment);
    form.set("identity", rec.identity);
    form.set("name", rec.name);
    form.set("offset", String(rec.offset));
    form.set("seq", String(seq));
    form.set("mime", rec.mime);
    form.set("file", blob, "chunk");
    for (let attempt = 0; attempt < 8; attempt++) {
      let status = 0;
      try {
        const res = await fetch(`/api/meet/recordings/${this.id}/chunks`, { method: "POST", body: form });
        // A redirect means the middleware sent us to sign-in (session gone).
        status = res.redirected ? 401 : res.status;
        if (res.ok && !res.redirected) {
          this.lastUpload = Date.now();
          return;
        }
      } catch {
        // network error: retry
      }
      if (status === 413) return this.onFatal("tooLarge");
      if (status === 401 || status === 403 || status === 404 || status === 410) return this.onFatal("gone");
      if (status === 409 || status === 400) {
        // A chunk of this segment went missing: drop it; reconcile starts a fresh segment.
        rec.broken = true;
        setTimeout(this.reconcileBound, 0);
        return;
      }
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
    rec.broken = true;
    this.onFatal("uploadFailed");
  }

  /** Stops every recorder and waits (bounded) for the last chunks to upload. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    for (const ev of RECONCILE_EVENTS) this.room.off(ev, this.reconcileBound);
    const recs = [...this.recs.values()];
    for (const rec of recs) this.finish(rec);
    const flushed = Promise.all(recs.map((r) => r.done)).then(() => this.queue);
    await Promise.race([flushed, sleep(FLUSH_TIMEOUT_MS)]);
  }
}

const stopUrl = (id: string) => `/api/meet/recordings/${id}/stop`;

/** Recording state for the call UI: who records, and start/stop for the local user. */
export function useRecording(room: Room, roomName: string, notify: (n: RecordingNotice) => void) {
  const [active, setActive] = useState<ActiveRecording | null>(null);
  const [busy, setBusy] = useState(false);
  const activeRef = useRef<ActiveRecording | null>(null);
  activeRef.current = active;
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const lastSignal = useRef(0);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const send = useCallback(
    (signal: RecSignal, to?: string[]) =>
      room.localParticipant
        .publishData(encoder.encode(JSON.stringify(signal)), { reliable: true, topic: REC_TOPIC, destinationIdentities: to })
        .catch(() => undefined),
    [room],
  );

  const announce = useCallback(
    (to?: string[]) => {
      const a = activeRef.current;
      if (a?.mine) void send({ type: "state", recording: true, id: a.id, elapsedMs: Date.now() - a.since, video: a.video }, to);
    },
    [send],
  );

  /** Stops the local recording: flush audio, tell the server, tell everyone. */
  const finishLocal = useCallback(
    async (reason: "user" | Fatal | "left") => {
      const rec = recorderRef.current;
      if (!rec) return;
      recorderRef.current = null;
      setActive(null);
      if (reason !== "left") void send({ type: "state", recording: false, id: rec.id });
      await rec.stop();
      await fetch(stopUrl(rec.id), { method: "POST", keepalive: true }).catch(() => undefined);
      if (reason === "user" || reason === "gone") notifyRef.current({ kind: "stopped" });
      else if (reason === "tooLarge" || reason === "uploadFailed") notifyRef.current({ kind: reason });
    },
    [send],
  );

  const start = useCallback(async (mode: RecordingMode = "audio") => {
    if (recorderRef.current || activeRef.current || busy) return;
    if (!recordingSupported()) return notifyRef.current({ kind: "unsupported" });
    setBusy(true);
    try {
      const res = await fetch("/api/meet/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: roomName,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(mode === "video" ? { video: true } : {}),
        }),
      });
      if (res.status === 409) return notifyRef.current({ kind: "busy" });
      if (!res.ok || res.redirected) return notifyRef.current({ kind: "startFailed" });
      const { id, video } = (await res.json()) as { id: string; video?: boolean };
      const lp = room.localParticipant;
      recorderRef.current = new MeetingRecorder(room, id, (reason) => void finishLocal(reason));
      const next: ActiveRecording = {
        id,
        by: lp.identity,
        byName: displayName(lp),
        since: Date.now(),
        mine: true,
        video: video === true,
      };
      activeRef.current = next;
      setActive(next);
      announce();
      notifyRef.current(
        mode === "video" && !next.video ? { kind: "videoFailed" } : { kind: "started", name: next.byName, mine: true },
      );
    } catch {
      notifyRef.current({ kind: "startFailed" });
    } finally {
      setBusy(false);
    }
  }, [room, roomName, busy, announce, finishLocal]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await finishLocal("user");
    } finally {
      setBusy(false);
    }
  }, [finishLocal]);

  // Signals from the recorder; heartbeat and late-joiner announcements when we're the recorder.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== REC_TOPIC || !participant) return;
      let signal: RecSignal;
      try {
        signal = JSON.parse(decoder.decode(payload)) as RecSignal;
      } catch {
        return;
      }
      if (signal?.type !== "state" || typeof signal.id !== "string") return;
      const cur = activeRef.current;
      if (cur?.mine) return;
      if (signal.recording) {
        lastSignal.current = Date.now();
        const elapsed = Math.max(0, Math.min(Number(signal.elapsedMs) || 0, 7 * 24 * 3600_000));
        const next: ActiveRecording = {
          id: signal.id.slice(0, 64),
          by: participant.identity,
          byName: displayName(participant),
          since: Date.now() - elapsed,
          mine: false,
          video: signal.video === true,
        };
        activeRef.current = next;
        setActive(next);
        if (!cur || cur.id !== next.id) notifyRef.current({ kind: "started", name: next.byName, mine: false });
      } else if (cur && cur.id === signal.id && cur.by === participant.identity) {
        activeRef.current = null;
        setActive(null);
        notifyRef.current({ kind: "stopped" });
      }
    };
    const onJoined = (p: RemoteParticipant) => announce([p.identity]);
    const onLeft = (p: RemoteParticipant) => {
      const cur = activeRef.current;
      if (cur && !cur.mine && cur.by === p.identity) {
        activeRef.current = null;
        setActive(null);
        notifyRef.current({ kind: "stopped" });
      }
    };
    const tick = setInterval(() => {
      const cur = activeRef.current;
      if (cur?.mine) announce();
      else if (cur && Date.now() - lastSignal.current > STALE_SIGNAL_MS) {
        activeRef.current = null;
        setActive(null);
        notifyRef.current({ kind: "stopped" });
      }
    }, HEARTBEAT_MS);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantConnected, onJoined);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      clearInterval(tick);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantConnected, onJoined);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room, announce]);

  // Leaving the call (or the page) ends our recording.
  useEffect(() => {
    const onPageHide = () => {
      const rec = recorderRef.current;
      if (rec) navigator.sendBeacon(stopUrl(rec.id));
    };
    const onDisconnected = () => void finishLocal("left");
    window.addEventListener("pagehide", onPageHide);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      room.off(RoomEvent.Disconnected, onDisconnected);
      void finishLocal("left");
    };
  }, [room, finishLocal]);

  return { active, busy, start, stop };
}
