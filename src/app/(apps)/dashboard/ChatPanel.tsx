"use client";

// The Dashboard's Claude chat: messages go to the user's OWN Claude Code through their bridge
// (like "Ask my Claude" in a call). State arrives over the dashboard's SSE stream; this component
// only sends, cancels and approves / rejects write actions.
import { ArrowUp, Check, Loader2, PanelRightClose, Sparkles, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import { renderMarkdown } from "@/app/(apps)/docs/md/[fileId]/markdown";
import { CHAT_TEXT_MAX, isFinalTurn, type ChatState, type TurnView } from "./model";
import { viewerTimeZone } from "./widgets";

const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export function ChatPanel({
  chat,
  draft,
  setDraft,
  inputRef,
  onAdded,
  onCollapse,
  where,
  examples,
}: {
  chat: ChatState;
  draft: string;
  setDraft: (v: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onAdded: (turn: TurnView) => void;
  onCollapse?: () => void;
  /** Set by "Customize with Claude" outside the Dashboard: the app the user is in. */
  where?: { app: string; path: string };
  /** Example prompts for the empty state (default: the Dashboard's). */
  examples?: string[];
}) {
  const t = useTranslations("dashboard.chat");
  const locale = useLocale();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const last = chat.turns[chat.turns.length - 1];

  // Follow the conversation (new turns, progress, results).
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.turns.length, last?.status, last?.progress, last?.result]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(id);
  }, [flash]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await post("/api/dashboard/chat", { text, timeZone: viewerTimeZone(), ...(where ? { where } : {}) });
      if (res.ok) {
        const { turn } = (await res.json()) as { turn: TurnView };
        onAdded(turn);
        setDraft("");
      } else setFlash(res.status === 412 ? t("needToken") : t("sendFailed"));
    } catch {
      setFlash(t("sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const decide = async (id: string, approve: boolean) => {
    const res = await post(`/api/meet/voice/confirmations/${id}`, { decision: approve ? "approve" : "reject" }).catch(() => null);
    if (!res?.ok) setFlash(t("expired"));
  };

  const cancel = (commandId: string) => void post(`/api/meet/voice/commands/${commandId}`, { action: "cancel" }).catch(() => null);

  const clear = async () => {
    if (!window.confirm(t("clearConfirm"))) return;
    await post("/api/dashboard/chat", undefined, "DELETE").catch(() => null);
  };

  const noToken = !chat.hasWriteToken;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-3">
        <Sparkles size={16} aria-hidden className="text-[var(--dash-accent)]" />
        <h2 className="ml-1.5 flex-1 text-[15px] font-semibold text-ink">{t("title")}</h2>
        {chat.turns.length > 0 && (
          <button type="button" className="icon-btn !h-8 !w-8" onClick={clear} aria-label={t("clear")} title={t("clear")}>
            <Trash2 size={15} aria-hidden />
          </button>
        )}
        {onCollapse && (
          <button type="button" className="icon-btn !h-8 !w-8" onClick={onCollapse} aria-label={t("collapse")} title={t("collapse")}>
            <PanelRightClose size={16} aria-hidden />
          </button>
        )}
      </header>

      <div className="border-b border-line px-4 py-2 text-[12.5px] leading-relaxed">
        {noToken ? (
          <p className="text-amber">
            {t("needToken")}{" "}
            <Link href="/settings/integrations" className="font-medium underline underline-offset-2">
              {t("openIntegrations")}
            </Link>
          </p>
        ) : chat.bridge.connected ? (
          <p className="text-signal">{t("bridgeOn")}</p>
        ) : (
          <p className="text-ink-mute">
            {t("bridgeOff")}{" "}
            <Link href="/settings/integrations#bridge" className="font-medium text-ink-soft underline underline-offset-2">
              {t("bridgeHow")}
            </Link>
          </p>
        )}
      </div>

      <ol ref={list} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {chat.turns.length === 0 && (
          <li className="m-auto max-w-[280px] text-center text-[13px] leading-relaxed text-ink-mute">
            <p className="font-medium text-ink-soft">{t("emptyTitle")}</p>
            <p className="mt-1.5">{t("emptyBody")}</p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {(examples ?? (["example1", "example2", "example3"] as const).map((k) => t(k))).map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(k);
                      inputRef.current?.focus();
                    }}
                    className="w-full rounded-lg border border-line px-3 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
                  >
                    {k}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )}
        {chat.turns.map((turn) => {
          const running = !isFinalTurn(turn.status);
          const confirmations = chat.confirmations.filter((c) => c.commandId === turn.commandId);
          return (
            <li key={turn.id} className="flex flex-col gap-2">
              <div className="ml-8 self-end rounded-xl rounded-br-sm bg-primary-soft px-3 py-2 text-[13.5px] whitespace-pre-wrap text-ink">
                {turn.text}
                <span className="mt-0.5 block text-right text-[11px] text-ink-mute tabular-nums">{time.format(turn.createdAt)}</span>
              </div>
              {confirmations.map((c) => (
                <div key={c.id} className="rounded-lg border border-amber/40 bg-sheet-muted px-3 py-2.5 text-[13px]">
                  <p className="font-medium text-ink">{t("wantsTo", { action: c.tool.replace(/_/g, " ") })}</p>
                  <p className="mt-0.5 text-[12.5px] break-words text-ink-soft">{c.summary}</p>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <button type="button" onClick={() => decide(c.id, false)} className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-[12.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
                      <X size={13} aria-hidden />
                      {t("reject")}
                    </button>
                    <button type="button" onClick={() => decide(c.id, true)} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-ink hover:bg-primary-hover">
                      <Check size={13} aria-hidden />
                      {t("approve")}
                    </button>
                  </div>
                </div>
              ))}
              {running ? (
                <div className="flex items-start gap-2 text-[13px] text-ink-mute">
                  <Loader2 size={14} aria-hidden className="mt-0.5 shrink-0 animate-spin" />
                  <span className="min-w-0 flex-1 break-words">
                    {turn.progress ||
                      (turn.status === "needs_confirmation"
                        ? t("needsConfirmation")
                        : turn.status === "queued" && !chat.bridge.connected
                          ? t("waitingBridge")
                          : t("working"))}
                  </span>
                  {turn.commandId && (
                    <button type="button" onClick={() => cancel(turn.commandId!)} className="shrink-0 text-[12px] font-medium text-ink-soft underline-offset-2 hover:text-ink hover:underline">
                      {t("cancel")}
                    </button>
                  )}
                </div>
              ) : turn.status === "done" ? (
                <div className="min-w-0 text-[13.5px] leading-relaxed text-ink">{renderMarkdown(turn.result ?? "")}</div>
              ) : (
                <p className={`text-[13px] ${turn.status === "cancelled" ? "text-ink-mute" : "text-danger"}`}>
                  {turn.status === "cancelled" ? t("cancelled") : turn.result || t("failed")}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <form
        className="shrink-0 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-sheet px-3 py-2 focus-within:border-line-strong">
          <textarea
            ref={inputRef}
            rows={Math.min(6, Math.max(1, draft.split("\n").length))}
            value={draft}
            maxLength={CHAT_TEXT_MAX}
            disabled={noToken}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            className="max-h-40 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-mute"
          />
          <button type="submit" className="icon-btn !h-7 !w-7 shrink-0" disabled={!draft.trim() || sending || noToken} aria-label={t("send")}>
            {sending ? <Loader2 size={15} aria-hidden className="animate-spin" /> : <ArrowUp size={16} aria-hidden />}
          </button>
        </div>
        <p className="mt-1.5 text-[11.5px] text-ink-mute" role={flash ? "alert" : undefined}>
          {flash ?? t("private")}
        </p>
      </form>
    </div>
  );
}
