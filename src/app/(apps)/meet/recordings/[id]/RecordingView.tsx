"use client";

import { ArrowLeft, Check, Copy, Download, FolderOpen, Loader2, RotateCw, Search, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusPill } from "../../MeetLanding";
import { clock, type AudioSegment, type MeetingDetail, type TranscriptSegment } from "../../recording";

type Block = { start: number; speaker: string; text: string };

/** Joins consecutive segments of the same speaker (as in the Markdown transcript). */
function blocks(segments: TranscriptSegment[]): Block[] {
  const out: (Block & { end: number })[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 4) {
      last.text += ` ${s.text}`;
      last.end = Math.max(last.end, s.end);
    } else out.push({ start: s.start, end: s.end, speaker: s.speaker, text: s.text });
  }
  return out;
}

const BTN =
  "inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50";

export function RecordingView({ detail, transcriptionConfigured }: { detail: MeetingDetail; transcriptionConfigured: boolean }) {
  const t = useTranslations("meet");
  const format = useFormatter();
  const router = useRouter();
  const { meeting, segments, markdown, audio, isStarter } = detail;
  const [query, setQuery] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRefs = useRef(new Map<number, HTMLAudioElement>());

  // While recording/transcribing, keep the page fresh.
  const pending = meeting.status === "recording" || meeting.status === "processing";
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [pending, router]);

  const all = useMemo(() => blocks(segments), [segments]);
  const speakers = useMemo(() => [...new Set(segments.map((s) => s.speaker))].sort(), [segments]);
  const q = query.trim().toLowerCase();
  const shown = all.filter((b) => (!speaker || b.speaker === speaker) && (!q || b.text.toLowerCase().includes(q)));

  const bySpeaker = useMemo(() => {
    const map = new Map<string, AudioSegment[]>();
    for (const a of audio) map.set(a.name, [...(map.get(a.name) ?? []), a]);
    return [...map.entries()];
  }, [audio]);

  /** Plays the speaker's audio from a transcript timestamp. */
  const playAt = (b: Block) => {
    const seg = audio.filter((a) => a.name === b.speaker && a.offsetSeconds <= b.start).at(-1);
    const el = seg && audioRefs.current.get(seg.id);
    if (!seg || !el) return;
    for (const other of audioRefs.current.values()) if (other !== el) other.pause();
    el.currentTime = Math.max(0, b.start - seg.offsetSeconds);
    void el.play().catch(() => undefined);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("recCopyFailed"));
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meeting.title.replace(/[\\/:*?"<>|]/g, " ").trim() || meeting.room}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const act = async (kind: "retry" | "delete") => {
    if (kind === "delete" && !window.confirm(t("recDeleteConfirm"))) return;
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/meet/recordings/${meeting.id}`, { method: kind === "retry" ? "POST" : "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      if (kind === "delete") router.push("/meet");
      else router.refresh();
    } catch {
      setError(t("recActionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const canRetry =
    meeting.status === "failed" || (meeting.status === "ready" && !meeting.driveFileId && !!meeting.error);
  const driveHref = meeting.driveFolderId ? `/drive?folder=${encodeURIComponent(meeting.driveFolderId)}` : "/drive";

  const statusText = (() => {
    if (meeting.status === "recording") return t("recInProgress");
    if (meeting.status === "processing") return t("recProcessing");
    if (meeting.status === "failed") {
      if (meeting.error === "not_configured" || !transcriptionConfigured) return t("recErrNotConfigured");
      return t("recErrTranscription");
    }
    if (meeting.error === "drive_session_expired") return t("recErrDriveSession");
    if (meeting.error) return t("recErrDrive");
    return null;
  })();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <Link href="/meet" className="inline-flex items-center gap-1.5 text-[13px] text-ink-mute transition-colors hover:text-ink">
        <ArrowLeft size={14} aria-hidden />
        {t("backToMeet")}
      </Link>

      <header className="mt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 text-[24px] font-semibold tracking-tight break-words text-ink">{meeting.title}</h1>
          <StatusPill status={meeting.status} error={meeting.error} />
        </div>
        <p className="mt-1 text-[13px] text-ink-mute">
          {format.dateTime(new Date(meeting.startedAt), { dateStyle: "full", timeStyle: "short" })}
          {meeting.durationSeconds != null && ` · ${clock(meeting.durationSeconds)}`}
          {" · "}
          <span className="font-mono">{meeting.room}</span>
        </p>
        <p className="mt-2 text-[13px] text-ink-soft">
          {t("recParticipants")}: {meeting.participants.map((p) => p.name || p.email).join(", ")}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {meeting.driveFileId && (
            <Link href={driveHref} className={BTN}>
              <FolderOpen size={14} aria-hidden />
              {t("recOpenDrive")}
            </Link>
          )}
          {markdown && (
            <>
              <button type="button" className={BTN} onClick={copy}>
                {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                {copied ? t("recCopied") : t("recCopyMarkdown")}
              </button>
              <button type="button" className={BTN} onClick={download}>
                <Download size={14} aria-hidden />
                {t("recDownload")}
              </button>
            </>
          )}
          {canRetry && (
            <button type="button" className={BTN} onClick={() => void act("retry")} disabled={!!busy}>
              {busy === "retry" ? <Loader2 size={14} aria-hidden className="animate-spin" /> : <RotateCw size={14} aria-hidden />}
              {t("recRetry")}
            </button>
          )}
          {isStarter && !pending && (
            <button type="button" className={`${BTN} hover:!text-danger`} onClick={() => void act("delete")} disabled={!!busy}>
              <Trash2 size={14} aria-hidden />
              {t("recDelete")}
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      </header>

      {statusText && (
        <p role="status" className="mt-6 flex items-center gap-2 rounded-lg border border-line bg-sheet-muted px-4 py-3 text-[13px] text-ink-soft">
          {pending && <Loader2 size={14} aria-hidden className="shrink-0 animate-spin" />}
          {statusText}
        </p>
      )}

      {bySpeaker.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[12px] font-medium tracking-wide text-ink-mute uppercase">{t("recAudio")}</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {bySpeaker.map(([name, parts]) => (
              <li key={name} className="rounded-lg border border-line p-3">
                <p className="text-[13px] font-medium text-ink">{name}</p>
                <div className="mt-2 flex flex-col gap-2">
                  {parts.map((a) => (
                    <div key={a.id} className="flex items-center gap-3">
                      {parts.length > 1 && (
                        <span className="w-14 shrink-0 font-mono text-[12px] text-ink-mute">{clock(a.offsetSeconds)}</span>
                      )}
                      <audio
                        ref={(el) => {
                          if (el) audioRefs.current.set(a.id, el);
                          else audioRefs.current.delete(a.id);
                        }}
                        controls
                        preload="none"
                        src={`/api/meet/recordings/${meeting.id}/audio/${a.id}`}
                        className="h-9 w-full min-w-0"
                      />
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {meeting.status === "ready" && (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[12px] font-medium tracking-wide text-ink-mute uppercase">{t("recTranscript")}</h2>
            {all.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <label className="relative">
                  <span className="sr-only">{t("recSearch")}</span>
                  <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-mute" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("recSearch")}
                    className="h-8 w-48 rounded-lg border border-line bg-sheet pr-2 pl-8 text-[13px] text-ink outline-none placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute"
                  />
                </label>
                {speakers.length > 1 && (
                  <select
                    value={speaker}
                    onChange={(e) => setSpeaker(e.target.value)}
                    aria-label={t("recSpeakerFilter")}
                    className="h-8 rounded-lg border border-line bg-sheet px-2 text-[13px] text-ink outline-none hover:border-line-strong focus:border-ink-mute"
                  >
                    <option value="">{t("recAllSpeakers")}</option>
                    {speakers.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
          {all.length === 0 ? (
            <p className="mt-4 text-[14px] text-ink-mute">{t("recNoSpeech")}</p>
          ) : shown.length === 0 ? (
            <p className="mt-4 text-[14px] text-ink-mute">{t("recNoMatches")}</p>
          ) : (
            <ol className="mt-4 flex flex-col gap-4">
              {shown.map((b, i) => (
                <li key={`${b.start}-${i}`} className="grid grid-cols-[auto_1fr] gap-x-3">
                  <button
                    type="button"
                    onClick={() => playAt(b)}
                    className="mt-0.5 h-fit rounded font-mono text-[12px] text-ink-mute tabular-nums transition-colors hover:text-ink"
                    title={t("recPlayFrom")}
                  >
                    {clock(b.start)}
                  </button>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">{b.speaker}</p>
                    <p className="mt-0.5 text-[14px] leading-relaxed break-words text-ink-soft">{b.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
