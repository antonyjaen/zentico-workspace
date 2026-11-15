"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { UNREAD_EVENT } from "@/app/(apps)/chat/shared";

const POLL_MS = 30_000;

/** Unread Chat count on the rail icon: polls every 30 s, on focus, and when the chat app reads. */
export function ChatUnreadBadge() {
  const t = useTranslations("apps");
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    let inflight = false;
    const load = async () => {
      if (inflight || document.visibilityState === "hidden") return;
      inflight = true;
      try {
        const res = await fetch("/api/chat/unread", { cache: "no-store" });
        if (res.ok && live) setCount(Number(((await res.json()) as { total?: number }).total) || 0);
      } catch {
        // Offline or signed out: keep the last value.
      } finally {
        inflight = false;
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    const onSignal = (e: Event) => {
      const total = (e as CustomEvent<number | undefined>).detail;
      if (typeof total === "number") setCount(total);
      else void load();
    };
    window.addEventListener(UNREAD_EVENT, onSignal);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(UNREAD_EVENT, onSignal);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  if (count <= 0) return null;
  return (
    <span
      className="absolute -top-1 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
      aria-label={t("chatUnread", { count })}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
