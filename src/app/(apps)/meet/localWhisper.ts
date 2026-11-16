"use client";

// Local speech-to-text for Claude commands: Whisper in a Web Worker on the user's GPU (WebGPU), so
// push-to-talk and meeting-context audio become text in the browser and only text is sent. Loaded
// lazily (panel opened, first push to talk, or meeting listening switched on); while it loads, when
// the device has no usable GPU, or after any worker error, callers use the server upload instead.
// One worker per tab, shared by every hook instance; commands are transcribed before waiting
// meeting chunks.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type WorkerIn = { type: "load" } | { type: "transcribe"; id: number; audio: Float32Array };
export type WorkerOut =
  | { type: "progress"; percent: number }
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "result"; id: number; text: string; language: string | null }
  | { type: "error"; id: number; message: string };

export type LocalSttStatus = "idle" | "loading" | "ready" | "failed";
export type LocalSttState = { status: LocalSttStatus; percent: number | null };
export type LocalTranscript = { text: string; language: string | null };
export type LocalPriority = "command" | "context";

/** "0" = transcribe on the server even though this device could do it (default: on when supported). */
const LOCAL_STT_PREF = "zw-meet-claude-local-stt";
/** A clip that takes longer than this on the GPU is given up (the caller falls back to the server). */
const JOB_TIMEOUT_MS = 30_000;
/** Meeting chunks waiting behind others; older ones are dropped beyond this. */
const MAX_CONTEXT_WAITING = 2;

/** Thrown for a meeting chunk dropped because newer ones were waiting (not an error). */
export class LocalSttDropped extends Error {}

type Job = {
  id: number;
  priority: LocalPriority;
  audio: Float32Array;
  resolve: (r: LocalTranscript) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

let state: LocalSttState = { status: "idle", percent: null };
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let nextId = 1;
let waiting: Job[] = [];
let running: Job | null = null;

function setState(next: LocalSttState) {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const snapshot = () => state;
const serverSnapshot: LocalSttState = { status: "idle", percent: null };

/** Stops the worker and fails every job (callers fall back to the server). */
function teardown(status: LocalSttStatus, reason: string) {
  worker?.terminate();
  worker = null;
  const jobs = [...waiting, ...(running ? [running] : [])];
  waiting = [];
  running = null;
  for (const j of jobs) {
    if (j.timer) clearTimeout(j.timer);
    j.reject(new Error(reason));
  }
  setState({ status, percent: null });
}

function pump() {
  if (running || !worker || state.status !== "ready") return;
  const job = waiting.shift();
  if (!job) return;
  running = job;
  job.timer = setTimeout(() => {
    console.warn("[local-stt] transcription timed out");
    teardown("failed", "timeout");
  }, JOB_TIMEOUT_MS);
  const msg: WorkerIn = { type: "transcribe", id: job.id, audio: job.audio };
  worker.postMessage(msg, [job.audio.buffer]);
}

function onMessage(e: MessageEvent<WorkerOut>) {
  const msg = e.data;
  switch (msg.type) {
    case "progress":
      if (state.status === "loading") setState({ status: "loading", percent: msg.percent });
      return;
    case "ready":
      setState({ status: "ready", percent: null });
      return pump();
    case "failed":
      console.warn("[local-stt] model failed to load:", msg.message);
      return teardown("failed", msg.message);
    case "result":
    case "error": {
      const job = running;
      if (!job || job.id !== msg.id) return;
      running = null;
      if (job.timer) clearTimeout(job.timer);
      if (msg.type === "result") {
        job.resolve({ text: msg.text, language: msg.language });
        return pump();
      }
      // A GPU error usually repeats: use the server from now on (re-enabling the setting retries).
      console.warn("[local-stt] transcription failed:", msg.message);
      job.reject(new Error(msg.message));
      return teardown("failed", msg.message);
    }
  }
}

/** Starts downloading / loading the model (once per tab; after a failure only via resetLocalStt). */
export function loadLocalStt(): void {
  if (typeof window === "undefined" || state.status !== "idle") return;
  try {
    worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    console.warn("[local-stt] worker:", e instanceof Error ? e.message : e);
    return setState({ status: "failed", percent: null });
  }
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", (e) => {
    console.warn("[local-stt] worker error:", e.message);
    teardown("failed", "worker error");
  });
  setState({ status: "loading", percent: null });
  const msg: WorkerIn = { type: "load" };
  worker.postMessage(msg);
}

/** Frees the GPU (setting turned off) and allows a fresh load later. */
export function resetLocalStt(): void {
  teardown("idle", "reset");
}

/** Transcribes 16 kHz mono audio (≤ 30 s); the buffer is transferred to the worker. */
export function transcribeLocal(audio: Float32Array, priority: LocalPriority): Promise<LocalTranscript> {
  if (state.status !== "ready" || !worker) return Promise.reject(new Error("not ready"));
  return new Promise((resolve, reject) => {
    const job: Job = { id: nextId++, priority, audio, resolve, reject };
    if (priority === "command") {
      // Commands go before any waiting meeting chunk, after earlier commands.
      const at = waiting.findIndex((j) => j.priority === "context");
      waiting.splice(at < 0 ? waiting.length : at, 0, job);
    } else {
      waiting.push(job);
      const contexts = waiting.filter((j) => j.priority === "context");
      for (const old of contexts.slice(0, Math.max(0, contexts.length - MAX_CONTEXT_WAITING))) {
        waiting = waiting.filter((j) => j !== old);
        old.reject(new LocalSttDropped("dropped"));
      }
    }
    pump();
  });
}

/* ------------------------------------------------------------- capability */

type Gpu = { requestAdapter(): Promise<object | null> };
let probe: Promise<boolean> | null = null;

/** WebGPU with a usable adapter, module workers. Cached per tab. */
function probeLocalStt(): Promise<boolean> {
  probe ??= (async () => {
    try {
      if (typeof Worker === "undefined") return false;
      const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
      return !!gpu && !!(await gpu.requestAdapter());
    } catch {
      return false;
    }
  })();
  return probe;
}

function readPref(): boolean {
  try {
    return localStorage.getItem(LOCAL_STT_PREF) !== "0";
  } catch {
    return true;
  }
}

function writePref(on: boolean) {
  try {
    localStorage.setItem(LOCAL_STT_PREF, on ? "1" : "0");
  } catch {
    // storage blocked: the setting still applies in this tab
  }
}

/**
 * The "Transcribe on this device (GPU)" setting and the model's state. `active` = clips are
 * transcribed locally right now (supported, switched on and loaded).
 */
export function useLocalStt() {
  /** null while checking the GPU. */
  const [supported, setSupported] = useState<boolean | null>(null);
  const [enabled, setEnabledState] = useState(true);
  const st = useSyncExternalStore(subscribe, snapshot, () => serverSnapshot);

  useEffect(() => {
    setEnabledState(readPref());
    let live = true;
    void probeLocalStt().then((ok) => live && setSupported(ok));
    return () => {
      live = false;
    };
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    writePref(on);
    // Off frees the GPU; on after a failure tries again.
    if (!on || state.status === "failed") resetLocalStt();
  }, []);

  const wanted = supported === true && enabled;
  return {
    supported,
    enabled,
    setEnabled,
    /** Supported and switched on: the model should be loaded when Claude is used. */
    wanted,
    status: st.status,
    percent: st.percent,
    active: wanted && st.status === "ready",
  };
}

/** Int16 PCM → Float32 in [-1, 1) for Whisper. */
export function pcmToFloat(pcm: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}
