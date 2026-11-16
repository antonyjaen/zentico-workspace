"use client";

// Above the composer, only for me: what MY Claude is doing in this conversation, and the write
// actions it wants to run, waiting for my Approve / Reject (nobody else sees this). Loaded when the
// conversation opens and refreshed on "claude" chat events; decisions go through the same
// endpoints as in a call.
import { Check, Loader2, ShieldAlert, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { Subscribe } from "./ChatApp";
import type { ClaudeChatState } from "./shared";
import { BTN, BTN_PRIMARY } from "./ui";

export function ClaudeStrip({ conversationId, subscribe }: { conversationId: string; subscribe: Subscribe }) {
  const t = useTranslations("apps");
  const [state, setState] = useState<ClaudeChatState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/claude?c=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
      if (res.ok) setState((await res.json()) as ClaudeChatState);
    } catch {
      // offline: the next event retries
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "claude" && e.conversationId === conversationId) void load();
      }),
    [subscribe, conversationId, load],
  );
  // Drop approvals when they expire.
  useEffect(() => {
    const next = Math.min(...(state?.confirmations.map((c) => c.expiresAt) ?? []));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => void load(), Math.max(0, next - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [state, load]);

  const post = async (key: string, url: string, body: unknown) => {
    setBusy(key);
    try {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      // shown as still pending; the user can retry
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (!state || (!state.commands.length && !state.confirmations.length)) return null;
  const waiting = new Set(state.confirmations.map((c) => c.commandId));

  return (
    <div className="mx-3 mb-1 space-y-1.5 md:mx-4" aria-live="polite">
      {state.confirmations.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber/50 bg-amber/[0.07] px-3 py-2">
          <ShieldAlert size={16} className="shrink-0 text-amber" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-ink">{t("claudeWantsTo", { tool: c.tool })}</p>
            <p className="truncate text-[12px] text-ink-soft" title={c.summary}>
              {c.summary}
            </p>
            <p className="text-[11px] text-ink-mute">{t("onlyYouSeeThis")}</p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post(c.id, `/api/meet/voice/confirmations/${encodeURIComponent(c.id)}`, { decision: "reject" })}
            className={BTN}
          >
            <X size={14} aria-hidden />
            {t("reject")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post(c.id, `/api/meet/voice/confirmations/${encodeURIComponent(c.id)}`, { decision: "approve" })}
            className={BTN_PRIMARY}
          >
            {busy === c.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
            {t("approve")}
          </button>
        </div>
      ))}
      {state.commands
        .filter((c) => !waiting.has(c.id))
        .map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-1.5">
            <Sparkles size={14} className="shrink-0 animate-pulse text-ink-mute" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-[12.5px] text-ink-soft" title={c.text}>
              {c.status === "queued" ? t("claudeWaitingBridge") : t("claudeWorkingOn")} <span className="text-ink">{c.text}</span>
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => post(c.id, `/api/meet/voice/commands/${encodeURIComponent(c.id)}`, { action: "cancel" })}
              className="shrink-0 text-[12px] text-ink-mute hover:text-ink"
            >
              {t("cancel")}
            </button>
          </div>
        ))}
    </div>
  );
}
