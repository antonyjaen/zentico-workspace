// Transcription through a self-hosted Whisper server with an OpenAI-compatible API
// (e.g. speaches / faster-whisper-server): POST {WHISPER_URL}/v1/audio/transcriptions. Server-only.
// No ffmpeg here: every speaker segment is sent as its own file and its timestamps are shifted
// by the segment's offset from the start of the meeting.
import { readFile } from "node:fs/promises";
import { clock, type MeetingSummary, type TranscriptSegment } from "@/app/(apps)/meet/recording";

export type WhisperConfig = { url: string; model: string; language: string | null };

export function whisperConfig(): WhisperConfig | null {
  const url = process.env.WHISPER_URL?.trim();
  if (!url || !/^https?:\/\//.test(url)) return null;
  const language = process.env.WHISPER_LANGUAGE?.trim().toLowerCase() || null;
  return {
    url: url.replace(/\/+$/, ""),
    model: process.env.WHISPER_MODEL?.trim() || "Systran/faster-whisper-small",
    language: language && /^[a-z]{2,3}$/.test(language) ? language : null,
  };
}

type WhisperSegment = {
  start?: number;
  end?: number;
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
};

/** Long recordings take a while on CPU; allow up to an hour per segment. */
const REQUEST_TIMEOUT_MS = 60 * 60_000;

const filename = (mime: string) => (mime === "audio/ogg" ? "audio.ogg" : mime === "audio/mp4" ? "audio.m4a" : "audio.webm");

/** Transcribes one audio file; returns segments relative to the start of that file. */
export async function transcribeFile(cfg: WhisperConfig, path: string, mime: string): Promise<TranscriptSegment[]> {
  const audio = await readFile(path);
  return (await transcribeAudio(cfg, audio, mime, { timeoutMs: REQUEST_TIMEOUT_MS })).segments;
}

/**
 * Transcribes audio held in memory (nothing is written to disk). `prompt` biases recognition
 * towards expected words (e.g. "Claude"); `duration` is the audio length in seconds when known.
 */
export async function transcribeAudio(
  cfg: WhisperConfig,
  audio: Uint8Array,
  mime: string,
  opts: { timeoutMs: number; prompt?: string; language?: string | null },
): Promise<{ segments: TranscriptSegment[]; duration: number | null; language: string | null }> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), filename(mime));
  form.set("model", cfg.model);
  form.set("response_format", "verbose_json");
  form.set("temperature", "0");
  const language = opts.language ?? cfg.language;
  if (language) form.set("language", language);
  if (opts.prompt) form.set("prompt", opts.prompt);

  const res = await fetch(`${cfg.url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Whisper ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await res.json()) as { segments?: WhisperSegment[]; text?: string; duration?: number; language?: string };
  const segments = Array.isArray(body.segments) ? body.segments : [];
  const duration = typeof body.duration === "number" && Number.isFinite(body.duration) ? body.duration : null;
  const detected = typeof body.language === "string" ? toIso(body.language) : null;
  return { segments: cleanSegments(segments), duration, language: language ?? detected };
}

function cleanSegments(segments: WhisperSegment[]): TranscriptSegment[] {
  return segments
    .filter(
      (s) =>
        typeof s.text === "string" &&
        s.text.trim() &&
        // Whisper invents text on silence (muted mics are recorded too): drop likely hallucinations.
        // (Whisper's own no-speech rule, plus near-certain silence regardless of confidence.)
        !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) &&
        (s.no_speech_prob ?? 0) < 0.9 &&
        (s.compression_ratio ?? 0) < 2.6,
    )
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || Number(s.start) || 0, speaker: "", text: s.text!.trim() }));
}

/** Merges everyone's segments into one timeline. */
export function mergeSegments(parts: { speaker: string; offsetSeconds: number; segments: TranscriptSegment[] }[]): TranscriptSegment[] {
  const round = (n: number) => Math.round(n * 100) / 100;
  return parts
    .flatMap((p) =>
      p.segments.map((s) => ({
        start: round(s.start + p.offsetSeconds),
        end: round(s.end + p.offsetSeconds),
        speaker: p.speaker,
        text: s.text,
      })),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function formatWhen(iso: string, timeZone: string | null): { date: string; time: string } {
  const opts = (tz: string | undefined): Intl.DateTimeFormatOptions => ({
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", opts(timeZone ?? undefined)).formatToParts(new Date(iso));
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", opts("UTC")).formatToParts(new Date(iso));
  }
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return { date: `${p("year")}-${p("month")}-${p("day")}`, time: `${p("hour")}:${p("minute")}` };
}

/** Markdown transcript: header, then "**[mm:ss] Name:** text" lines (same speaker runs joined). */
export function toMarkdown(meeting: MeetingSummary, segments: TranscriptSegment[], timeZone: string | null): string {
  const { date, time } = formatWhen(meeting.startedAt, timeZone);
  const lines = [
    `# ${meeting.title}`,
    "",
    `- **Date:** ${date} ${time}${timeZone ? ` (${timeZone})` : " (UTC)"}`,
    `- **Room:** ${meeting.room}`,
    `- **Duration:** ${meeting.durationSeconds != null ? clock(meeting.durationSeconds) : "—"}`,
    `- **Participants:** ${meeting.participants.map((p) => (p.name && p.name !== p.email ? `${p.name} <${p.email}>` : p.email)).join(", ")}`,
    `- **Recorded by:** ${meeting.startedByName}`,
    "",
    "## Transcript",
    "",
  ];
  if (!segments.length) lines.push("_No speech was detected._");
  let current: { start: number; end: number; speaker: string; text: string[] } | null = null;
  const flush = () => {
    if (current) lines.push(`**[${clock(current.start)}] ${current.speaker}:** ${current.text.join(" ")}`, "");
  };
  for (const s of segments) {
    if (current && current.speaker === s.speaker && s.start - current.end < 4) {
      current.text.push(s.text);
      current.end = Math.max(current.end, s.end);
    } else {
      flush();
      current = { start: s.start, end: s.end, speaker: s.speaker, text: [s.text] };
    }
  }
  flush();
  return lines.join("\n").trimEnd() + "\n";
}

/** Whisper reports either ISO codes ("es") or names ("spanish"); normalize the common ones. */
function toIso(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  if (/^[a-z]{2,3}$/.test(l)) return l;
  const names: Record<string, string> = { spanish: "es", english: "en", portuguese: "pt", french: "fr", german: "de", italian: "it" };
  return names[l] ?? null;
}
