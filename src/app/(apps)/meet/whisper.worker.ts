// Whisper in the user's browser (WebGPU), for Claude commands in a call: push-to-talk clips and
// meeting-context chunks are turned into text here, so only text goes to the server. Driven by
// localWhisper.ts; one job at a time. The model files (~1.6 GB) are downloaded once from the
// Hugging Face Hub and kept in the browser's Cache API (transformers.js default).
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { WorkerIn, WorkerOut } from "./localWhisper";

const MODEL = "onnx-community/whisper-large-v3-turbo";
const RATE = 16_000;

env.allowLocalModels = false;
// WebGPU does the work; the WASM fallback inside onnxruntime stays single-threaded (no COOP/COEP).
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

const scope = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: MessageEvent<WorkerIn>) => void): void;
};
const post = (msg: WorkerOut) => scope.postMessage(msg);

type Gpu = { requestAdapter(): Promise<{ features: { has(f: string): boolean } } | null> };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Download progress over every model file, 0–100, never going back. */
function progressTracker() {
  const files = new Map<string, { loaded: number; total: number }>();
  let last = -1;
  return (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const pct = Math.min(99, Math.floor((loaded / total) * 100));
    if (pct > last) {
      last = pct;
      post({ type: "progress", percent: pct });
    }
  };
}

async function load() {
  const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) throw new Error("no WebGPU adapter");
  // fp16 halves the encoder (1.3 GB vs 2.5 GB) but needs shader-f16; without it the q4 encoder
  // (~425 MB) keeps the download and GPU memory reasonable instead of a 2.5 GB fp32 one.
  const f16 = adapter.features.has("shader-f16");
  const create = pipeline as unknown as (task: string, model: string, opts: object) => Promise<AutomaticSpeechRecognitionPipeline>;
  const pipe = await create("automatic-speech-recognition", MODEL, {
    device: "webgpu",
    dtype: { encoder_model: f16 ? "fp16" : "q4", decoder_model_merged: "q4" },
    progress_callback: progressTracker(),
  });
  // Compiles the GPU shaders now rather than on the first command.
  await pipe(new Float32Array(RATE), { language: "en", task: "transcribe" });
  asr = pipe;
}

type OutTensor = { type: string; data: ArrayLike<number>; location?: string; dispose?: () => void };
type ForwardOut = Record<string, OutTensor> & { logits: OutTensor };

/**
 * Whisper's own language guess: one decoder step after <|startoftranscript|>, best language token.
 * (transformers.js 3.x defaults to English when no language is given.)
 */
async function detectLanguage(pipe: AutomaticSpeechRecognitionPipeline, audio: Float32Array): Promise<string | null> {
  const model = pipe.model as unknown as ((inputs: object) => Promise<ForwardOut>) & {
    generation_config?: { lang_to_id?: Record<string, number>; decoder_start_token_id?: number };
  };
  const cfg = model.generation_config;
  const langs = Object.entries(cfg?.lang_to_id ?? {});
  if (!langs.length || cfg?.decoder_start_token_id == null) return null;
  const { input_features } = (await (pipe.processor as unknown as (a: Float32Array) => Promise<{ input_features: Tensor }>)(audio));
  const out = await model({
    input_features,
    decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(cfg.decoder_start_token_id)]), [1, 1]),
  });
  try {
    if (out.logits.type !== "float32") return null;
    const logits = out.logits.data;
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [token, id] of langs) {
      if (logits[id] > bestScore) {
        bestScore = logits[id];
        best = token;
      }
    }
    return best ? best.replace(/^<\|/, "").replace(/\|>$/, "") : null;
  } finally {
    // The cache tensors of that step live on the GPU.
    for (const t of Object.values(out)) if (t?.location === "gpu-buffer") t.dispose?.();
  }
}

async function transcribe(audio: Float32Array): Promise<{ text: string; language: string | null }> {
  if (!asr) throw new Error("not loaded");
  const language = await detectLanguage(asr, audio);
  // ≤ 30 s: one window, no chunking.
  const out = await asr(audio, { language: language ?? undefined, task: "transcribe", return_timestamps: false });
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
  return { text, language };
}

scope.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    loading ??= load().then(
      () => post({ type: "ready" }),
      (err) => post({ type: "failed", message: errorText(err) }),
    );
    return;
  }
  if (msg.type === "transcribe") {
    transcribe(msg.audio).then(
      (r) => post({ type: "result", id: msg.id, text: r.text, language: r.language }),
      (err) => post({ type: "error", id: msg.id, message: errorText(err) }),
    );
  }
});
