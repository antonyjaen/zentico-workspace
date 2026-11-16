"use client";

import { Check, Cpu, Ear, Loader2, Mic, Send, Share2, ShieldCheck, Square, Volume2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { COMMAND_MAX_CHARS, isFinalStatus, type CommandView, type ConfirmationView } from "./claude";
import type { useClaudeCommands } from "./useClaudeCommands";
import type { useClaudeVoice } from "./useClaudeVoice";

type Claude = ReturnType<typeof useClaudeCommands>;
type Voice = ReturnType<typeof useClaudeVoice>;

const WRITE_TOOLS = new Set([
  "mail_send",
  "mail_create_draft",
  "mail_move",
  "mail_set_keywords",
  "calendar_create_event",
  "drive_write_text",
  "docs_create_markdown",
  "chat_post_message",
]);

export function useToolLabel() {
  const t = useTranslations("meet");
  return (tool: string) => (WRITE_TOOLS.has(tool) ? t(`claudeTool_${tool}`) : tool);
}

/** "Claude is speaking · Stop" for everyone in the call while a spoken reply plays on this device. */
function ClaudeVoiceBar({ voice }: { voice: Voice }) {
  const t = useTranslations("meet");
  const v = voice.current;
  if (!v) return null;
  return (
    <div role="status" className="pop pointer-events-auto flex max-w-full items-center gap-3 px-3 py-2 text-[13px] text-ink">
      <Volume2 size={15} aria-hidden className="shrink-0 animate-pulse" style={{ color: "var(--color-app-meet)" }} />
      <span className="min-w-0 truncate">{v.mine ? t("claudeVoiceSpeakingMine") : t("claudeVoiceSpeaking", { name: v.by })}</span>
      <button
        type="button"
        onClick={() => voice.stop(v.id)}
        title={t("claudeVoiceStopHint")}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-ink hover:bg-primary-hover"
      >
        <Square size={11} aria-hidden />
        {t("claudeVoiceStop")}
      </button>
      <button
        type="button"
        onClick={() => voice.setMuted(true)}
        title={t("claudeVoiceMuteHint")}
        className="shrink-0 text-[12.5px] text-ink-soft underline underline-offset-2"
      >
        {t("claudeVoiceMute")}
      </button>
    </div>
  );
}

/** Push-to-talk progress: recording, transcribing, processing, and what was heard. */
function TalkStatus({ claude, compact = false }: { claude: Claude; compact?: boolean }) {
  const t = useTranslations("meet");
  const lines: React.ReactNode[] = [];
  if (claude.talking)
    lines.push(
      <p key="rec" className="flex items-center gap-2 font-medium text-ink">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden />
        {t("claudeRecording")}
      </p>,
    );
  if (claude.transcribing > 0)
    lines.push(
      <p key="tr" className="flex items-center gap-2">
        <Loader2 size={11} aria-hidden className="shrink-0 animate-spin" />
        {claude.transcribing > 1 ? t("claudeTranscribingQueued", { count: claude.transcribing - 1 }) : t("claudeTranscribing")}
        <span className="text-ink-mute">· {claude.local.active ? t("claudeOnDevice") : t("claudeOnServer")}</span>
      </p>,
    );
  if (claude.accepted.size > 0)
    lines.push(
      <p key="pr" className="flex items-center gap-2 text-ink">
        <Loader2 size={11} aria-hidden className="shrink-0 animate-spin" />
        {t("claudeProcessing")}
      </p>,
    );
  if (claude.heard && !compact)
    lines.push(
      <p key="hd" className="break-words text-ink-mute">
        {t("claudeHeard", { text: claude.heard })}
      </p>,
    );
  if (!lines.length) return null;
  return compact ? (
    <div role="status" className="pop pointer-events-auto max-w-full space-y-1 px-3 py-2 text-[13px] text-ink-soft">
      {lines}
    </div>
  ) : (
    <div role="status" aria-live="polite" className="space-y-1 text-[12.5px] text-ink-soft">
      {lines}
    </div>
  );
}

/** "Transcribe on this device (GPU)": the setting, the one-time model download and where speech is transcribed. */
function LocalSttSetting({ claude }: { claude: Claude }) {
  const t = useTranslations("meet");
  const l = claude.local;
  if (l.supported === null) return null;
  if (!l.supported) return <p className="text-[12.5px] text-ink-mute">{t("claudeLocalSttUnsupported")}</p>;
  const status =
    !l.enabled ? null : l.status === "loading" ? (
      <span className="flex items-center gap-1.5 text-ink-soft">
        <Loader2 size={11} aria-hidden className="shrink-0 animate-spin" />
        {l.percent != null ? t("claudeLocalSttLoadingPct", { percent: l.percent }) : t("claudeLocalSttLoading")}
      </span>
    ) : l.status === "ready" ? (
      <span className="text-signal">{t("claudeLocalSttReady")}</span>
    ) : l.status === "failed" ? (
      <span className="text-amber">{t("claudeLocalSttFailed")}</span>
    ) : null;
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-app-meet)]"
        checked={l.enabled}
        onChange={(e) => l.setEnabled(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <Cpu size={14} aria-hidden className="shrink-0 text-ink-soft" />
          {t("claudeLocalStt")}
        </span>
        <span className="block text-[12.5px] leading-relaxed text-ink-mute">{t("claudeLocalSttHint")}</span>
        {status && (
          <span role="status" aria-live="polite" className="mt-1 block text-[12.5px]">
            {status}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * Banner for everyone while someone's Claude is listening to the meeting (consent notice); the
 * local user's own line has a Stop button.
 */
export function ClaudeListeningBanner({ claude }: { claude: Claude }) {
  const t = useTranslations("meet");
  if (!claude.capturing && !claude.others.length) return null;
  return (
    <div role="status" className="flex flex-col items-center gap-1 border-b border-line bg-sheet-muted px-4 py-2 text-[13px] text-ink-soft">
      {claude.capturing && (
        <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 font-medium text-ink">
            <Ear size={14} aria-hidden style={{ color: "var(--color-app-meet)" }} />
            {t("claudeListeningSelf")}
          </span>
          <button type="button" onClick={() => claude.setListen(false)} className="font-medium text-ink underline underline-offset-2">
            {t("claudeListenStop")}
          </button>
        </p>
      )}
      {claude.others.map((o) => (
        <p key={o.identity} className="flex items-center gap-2">
          <Ear size={14} aria-hidden className="shrink-0" style={{ color: "var(--color-app-meet)" }} />
          {t("claudeListeningBy", { name: o.name })}
        </p>
      ))}
    </div>
  );
}

/** Hold to talk: pointer (mouse, touch, pen) and Space/Enter on the focused button. */
function TalkButton({ claude, disabled }: { claude: Claude; disabled: boolean }) {
  const t = useTranslations("meet");
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={claude.talking}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Keeps pointerup coming here when released outside the button.
        e.currentTarget.setPointerCapture(e.pointerId);
        void claude.startTalk();
      }}
      onPointerUp={claude.endTalk}
      onPointerCancel={claude.endTalk}
      onLostPointerCapture={claude.endTalk}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        if (!e.repeat) void claude.startTalk();
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") claude.endTalk();
      }}
      onBlur={claude.endTalk}
      onContextMenu={(e) => e.preventDefault()}
      className={`flex w-full touch-none items-center justify-center gap-2 rounded-lg px-4 py-3 text-[14px] font-medium select-none disabled:opacity-50 ${
        claude.talking ? "bg-danger text-white" : "bg-primary text-primary-ink hover:bg-primary-hover"
      }`}
    >
      <Mic size={16} aria-hidden className={claude.talking ? "animate-pulse" : ""} />
      {claude.talking ? t("claudeTalkRelease") : t("claudeTalkHold")}
    </button>
  );
}

/**
 * Top of the stage: the spoken-reply bar (everyone), push-to-talk progress while the panel is
 * closed, and Approve / Reject cards for write actions the local user's Claude wants to run (never
 * shown to others).
 */
export function ClaudeConfirmations({ claude, voice, showTalk }: { claude: Claude; voice: Voice; showTalk: boolean }) {
  const t = useTranslations("meet");
  const label = useToolLabel();
  const [busy, setBusy] = useState<string | null>(null);
  const list = claude.data?.confirmations ?? [];
  const talk = showTalk && (claude.talking || claude.transcribing > 0 || claude.accepted.size > 0);
  if (!list.length && !voice.current && !talk) return null;
  const act = async (c: ConfirmationView, approve: boolean) => {
    setBusy(c.id);
    try {
      await claude.decide(c.id, approve);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-2 px-3">
      <ClaudeVoiceBar voice={voice} />
      {talk && <TalkStatus claude={claude} compact />}
      {list.map((c) => (
        <div
          key={c.id}
          role="alertdialog"
          aria-labelledby={`cf-${c.id}`}
          className="pop pointer-events-auto w-full max-w-md p-3 text-[13px] text-ink"
        >
          <p id={`cf-${c.id}`} className="flex items-start gap-2">
            <ShieldCheck size={16} aria-hidden className="mt-0.5 shrink-0 text-ink-soft" />
            <span className="min-w-0">
              <span className="font-medium">{t("claudeWantsTo", { action: label(c.tool) })}</span>
              {c.summary && <span className="mt-0.5 block break-words text-ink-soft">{c.summary}</span>}
            </span>
          </p>
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <span className="mr-auto text-[12px] text-ink-mute">{t("claudeConfirmHint")}</span>
            <button
              type="button"
              onClick={() => void act(c, false)}
              disabled={busy === c.id}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 text-ink hover:bg-hover disabled:opacity-50"
            >
              <X size={14} aria-hidden />
              {t("claudeReject")}
            </button>
            <button
              type="button"
              onClick={() => void act(c, true)}
              disabled={busy === c.id}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-50"
            >
              <Check size={14} aria-hidden />
              {t("claudeApprove")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusChip({ c }: { c: CommandView }) {
  const t = useTranslations("meet");
  const tone =
    c.status === "done"
      ? "text-signal"
      : c.status === "failed"
        ? "text-danger"
        : c.status === "needs_confirmation"
          ? "text-amber"
          : "text-ink-mute";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[11.5px] ${tone}`}>
      {!isFinalStatus(c.status) && c.status !== "needs_confirmation" && <Loader2 size={11} aria-hidden className="animate-spin" />}
      {t(`claudeStatus_${c.status}`)}
    </span>
  );
}

/** Side panel: push to talk, the meeting-listening and speak toggles, the user's own commands and "Ask my Claude". */
export function ClaudePanel({
  claude,
  voice,
  onShareInCall,
  flash,
}: {
  claude: Claude;
  voice: Voice;
  onShareInCall: (text: string) => Promise<void>;
  flash: (msg: string) => void;
}) {
  const t = useTranslations("meet");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const data = claude.data;
  const time = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }), []);
  const noToken = claude.problem === "noToken" || (data != null && !data.hasWriteToken);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim().slice(0, COMMAND_MAX_CHARS);
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await claude.ask(text);
      if (r === "ok") setDraft("");
      else flash(r === "noToken" ? t("claudeNeedToken") : t("claudeSendFailed"));
    } finally {
      setSending(false);
    }
  };

  const share = async (c: CommandView) => {
    if (!c.result) return;
    setSharing(c.id);
    try {
      const r = await claude.share(c.id);
      if (r === "ok") flash(t("claudeShared"));
      else if (r === "noChat") {
        await onShareInCall(`🤖 ${c.text}\n${c.result}`.slice(0, 2000));
        flash(t("claudeSharedInCall"));
      } else flash(t("claudeShareFailed"));
    } catch {
      flash(t("claudeShareFailed"));
    } finally {
      setSharing(null);
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="space-y-3 border-b border-line p-4">
          <div className="space-y-1.5">
            <TalkButton claude={claude} disabled={noToken || !claude.supported} />
            <p className="text-center text-[12px] text-ink-mute">{t("claudeTalkKeyHint")}</p>
          </div>
          <TalkStatus claude={claude} />
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-app-meet)]"
              checked={claude.listen}
              disabled={noToken}
              onChange={(e) => claude.setListen(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
                {t("claudeListen")}
                {claude.capturing && (
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-app-meet)" }} aria-hidden />
                )}
              </span>
              <span className="block text-[12.5px] leading-relaxed text-ink-mute">{t("claudeListenHint")}</span>
            </span>
          </label>
          <LocalSttSetting claude={claude} />
          {voice.supported && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-app-meet)]"
                checked={voice.speakAnswers}
                onChange={(e) => voice.setSpeakAnswers(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-ink">{t("claudeSpeakAnswers")}</span>
                <span className="block text-[12.5px] leading-relaxed text-ink-mute">{t("claudeSpeakAnswersHint")}</span>
              </span>
            </label>
          )}
          {noToken && (
            <p className="text-[12.5px] leading-relaxed text-amber">
              {t("claudeNeedToken")}{" "}
              <Link href="/settings/integrations" target="_blank" className="font-medium underline underline-offset-2">
                {t("claudeOpenIntegrations")}
              </Link>
            </p>
          )}
          {claude.problem === "notConfigured" && <p className="text-[12.5px] text-danger">{t("claudeNotConfigured")}</p>}
          {claude.problem === "unsupported" && <p className="text-[12.5px] text-danger">{t("claudeUnsupported")}</p>}
          {data && !noToken && (
            <p className="text-[12.5px] text-ink-mute">
              {data.bridge.connected ? (
                <span className="text-signal">{t("claudeBridgeOn")}</span>
              ) : (
                <>
                  {t("claudeBridgeOff")}{" "}
                  <Link href="/settings/integrations#bridge" target="_blank" className="underline underline-offset-2">
                    {t("claudeBridgeHow")}
                  </Link>
                </>
              )}
            </p>
          )}
        </div>

        <ul className="flex flex-col gap-3 p-4" aria-live="polite">
          {!data?.commands.length ? (
            <li className="m-auto max-w-[240px] py-6 text-center text-[13px] leading-relaxed text-ink-mute">{t("claudeEmpty")}</li>
          ) : (
            data.commands.map((c) => (
              <li key={c.id} className="rounded-lg border border-line p-3">
                <p className="flex items-baseline justify-between gap-2 text-[12px] text-ink-mute">
                  <span>
                    {time.format(c.createdAt)} · {c.source === "voice" ? t("claudeSaid") : t("claudeTyped")}
                  </span>
                  <StatusChip c={c} />
                </p>
                <p className="mt-1 text-[13.5px] break-words text-ink">{c.text}</p>
                {!isFinalStatus(c.status) && (c.progress || c.status === "queued") && (
                  <p className="mt-1.5 truncate text-[12.5px] text-ink-mute">
                    {c.progress ??
                      (!data.bridge.connected
                        ? t("claudeWaitingBridge")
                        : claude.accepted.has(c.id)
                          ? t("claudeProcessing")
                          : t("claudeWaiting"))}
                  </p>
                )}
                {c.spoken && c.status === "done" && (
                  <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-ink-mute">
                    <Volume2 size={12} aria-hidden className="mt-0.5 shrink-0" />
                    <span className="break-words">{c.spoken}</span>
                  </p>
                )}
                {c.result && (
                  <p
                    className={`mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap ${c.status === "failed" ? "text-danger" : "text-ink-soft"}`}
                  >
                    {c.result}
                  </p>
                )}
                <div className="mt-2 flex justify-end gap-2 empty:hidden">
                  {!isFinalStatus(c.status) && (
                    <button
                      type="button"
                      onClick={() => {
                        voice.stop(c.id);
                        void claude.cancel(c.id);
                      }}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong px-2.5 text-[12.5px] text-ink hover:bg-hover"
                    >
                      <X size={12} aria-hidden />
                      {t("claudeCancel")}
                    </button>
                  )}
                  {voice.current?.id === c.id && (
                    <button
                      type="button"
                      onClick={() => voice.stop(c.id)}
                      className="inline-flex items-center gap-1 text-[12.5px] text-ink-soft underline underline-offset-2"
                    >
                      <Square size={11} aria-hidden />
                      {t("claudeVoiceStop")}
                    </button>
                  )}
                  {c.status === "done" && c.result && (
                    <button
                      type="button"
                      onClick={() => void share(c)}
                      disabled={sharing === c.id}
                      className="inline-flex items-center gap-1 text-[12.5px] text-ink-soft underline underline-offset-2 disabled:opacity-50"
                      title={data.chat ? t("claudeShareHint") : t("claudeShareInCallHint")}
                    >
                      <Share2 size={12} aria-hidden />
                      {t("claudeShare")}
                    </button>
                  )}
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-1.5 focus-within:border-ink-mute">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            maxLength={COMMAND_MAX_CHARS}
            disabled={noToken}
            placeholder={t("claudeAskPlaceholder")}
            aria-label={t("claudeAskPlaceholder")}
            className="max-h-32 min-h-7 flex-1 resize-none bg-transparent py-1 text-[14px] text-ink outline-none placeholder:text-ink-mute disabled:opacity-60"
          />
          <button type="submit" className="icon-btn !h-7 !w-7" disabled={!draft.trim() || sending || noToken} aria-label={t("send")}>
            <Send size={15} aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-[11.5px] text-ink-mute">{t("claudePrivate")}</p>
      </form>
    </>
  );
}
