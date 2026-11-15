"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Status = "connecting" | "live" | "offline";

/**
 * Subscribes to /api/mail/events (JMAP push relayed as SSE) and refreshes the server-rendered
 * list when mail changes. Refreshes are debounced, deferred while the tab is hidden, and the
 * connection is re-opened with exponential backoff.
 */
export function MailLive({ pending }: { pending?: boolean }) {
  const t = useTranslations("mailActions");
  const router = useRouter();
  const [status, setStatus] = useState<Status>("connecting");

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let dirty = false;
    let stopped = false;

    const refresh = () => {
      if (document.hidden) {
        dirty = true;
        return;
      }
      dirty = false;
      router.refresh();
    };
    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 700);
    };

    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      source = new EventSource("/api/mail/events");
      source.onopen = () => {
        // Catch up on anything missed while disconnected.
        if (attempt > 0) schedule();
        attempt = 0;
        setStatus("live");
      };
      source.addEventListener("state", schedule);
      source.onerror = () => {
        source?.close();
        source = null;
        setStatus("offline");
        const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
        attempt += 1;
        retry = setTimeout(connect, delay);
      };
    };

    const onVisible = () => {
      if (!document.hidden && dirty) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(debounce);
      source?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  const label = status === "live" ? t("live") : status === "connecting" ? t("connecting") : t("offline");
  return (
    <span className="inline-flex h-9 items-center gap-2 px-2" title={label} role="status" aria-live="polite">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full transition-colors ${
          status === "live" ? (pending ? "animate-pulse bg-accent" : "bg-signal") : status === "connecting" ? "bg-amber" : "bg-ink-mute"
        }`}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
