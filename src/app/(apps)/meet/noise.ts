"use client";

// RNNoise noise suppression for the local microphone, as a LiveKit audio processor. LiveKit's
// own (Krisp) filter needs LiveKit Cloud; this runs RNNoise (WASM, in an AudioWorklet) on top of
// the browser's built-in noiseSuppression. Assets are served from /vendor/rnnoise.
import type { AudioProcessorOptions, LocalAudioTrack, Track, TrackProcessor } from "livekit-client";

const BASE = "/vendor/rnnoise";
let wasm: Promise<ArrayBuffer> | null = null;

function loadWasm(): Promise<ArrayBuffer> {
  wasm ??= import("@sapphi-red/web-noise-suppressor")
    .then(({ loadRnnoise }) => loadRnnoise({ url: `${BASE}/rnnoise.wasm`, simdUrl: `${BASE}/rnnoise_simd.wasm` }))
    .catch((e) => {
      wasm = null;
      throw e;
    });
  return wasm;
}

class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "rnnoise";
  processedTrack?: MediaStreamTrack;
  private ctx: AudioContext | null = null;
  private node: (AudioWorkletNode & { destroy(): void }) | null = null;

  async init({ track }: AudioProcessorOptions) {
    const [{ RnnoiseWorkletNode }, binary] = await Promise.all([import("@sapphi-red/web-noise-suppressor"), loadWasm()]);
    // RNNoise works on 48 kHz frames; the browser resamples the mic into this context.
    const ctx = new AudioContext({ sampleRate: 48000 });
    try {
      if (ctx.state === "suspended") await ctx.resume();
      // A context that can't run would send silence: fail so the raw mic stays in use.
      if (ctx.state !== "running") throw new Error("audio context not running");
      await ctx.audioWorklet.addModule(`${BASE}/worklet.js`);
      const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
      const out = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream([track])).connect(node).connect(out);
      this.ctx = ctx;
      this.node = node;
      this.processedTrack = out.stream.getAudioTracks()[0];
    } catch (e) {
      void ctx.close().catch(() => {});
      throw e;
    }
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.node?.destroy();
    this.node?.disconnect();
    this.node = null;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

/** Puts RNNoise on a microphone track; on any failure the track keeps the unprocessed mic. */
export async function suppressNoise(track: LocalAudioTrack): Promise<void> {
  if (typeof AudioWorkletNode === "undefined" || track.getProcessor()?.name === "rnnoise") return;
  try {
    await track.setProcessor(new RnnoiseProcessor());
  } catch (e) {
    console.warn("[meet] noise suppression unavailable:", e instanceof Error ? e.message : e);
  }
}
