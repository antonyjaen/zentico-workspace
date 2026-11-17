"use client";

import { Bell, BellOff, CheckCheck, Settings, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AppNotification } from "@/lib/notifications/types";
import { usePopover } from "../usePopover";
import { CATEGORY_ICON, describe, shortTime } from "./display";
import { DESKTOP_PROMPT_KEY as PROMPT_KEY, useNotifications } from "./NotificationsProvider";


function dayLabel(ms: number, locale: string, t: (k: string) => string): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t("today");
  if (d.toDateString() === yesterday.toDateString()) return t("yesterday");
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(d);
}

/** Bell in the top bar with the notification center popover. */
export function NotificationBell() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const { items, unread, prefs, loaded, permission, markAllRead, dismiss, clearAll, enableDesktop, openNotification } = useNotifications();
  const [confirmClear, setConfirmClear] = useState(false);
  const { open, setOpen, toggle, ref } = usePopover();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [promptDismissed, setPromptDismissed] = useState(true);
  const dnd = prefs.dndUntil > Date.now();

  useEffect(() => {
    try {
      setPromptDismissed(localStorage.getItem(PROMPT_KEY) === "1");
    } catch {
      setPromptDismissed(false);
    }
  }, []);

  // Focus the first item when opening; give focus back to the bell when closing from inside.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        const first = list.current?.querySelector<HTMLElement>("[data-nitem]");
        (first ?? list.current)?.focus();
      });
    } else if (wasOpen.current && (!document.activeElement || document.activeElement === document.body)) {
      // The panel (and the focus inside it) is gone: Escape or an item was chosen.
      button.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const groups = useMemo(() => {
    const out: { label: string; items: AppNotification[] }[] = [];
    for (const n of items) {
      const label = dayLabel(n.created, locale, t);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [items, locale, t]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const all = [...(list.current?.querySelectorAll<HTMLElement>("[data-nitem]") ?? [])];
    if (!all.length) return;
    e.preventDefault();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : e.key === "ArrowDown" ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1);
    all[next]?.focus();
  };

  const dismissPrompt = () => {
    setPromptDismissed(true);
    try {
      localStorage.setItem(PROMPT_KEY, "1");
    } catch {}
  };

  const showPrompt = loaded && !promptDismissed && !prefs.desktop && (permission === "default" || permission === "granted");
  const label = unread > 0 ? t("bellUnread", { count: unread }) : t("bell");
  const BellIcon = dnd ? BellOff : Bell;

  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="icon-btn relative"
      >
        <BellIcon size={19} aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t("title")}
          className="pop absolute top-12 right-0 z-50 flex max-h-[min(560px,calc(100dvh-5rem))] w-[min(380px,calc(100vw-1.5rem))] flex-col"
        >
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-4">
            <h2 className="flex-1 text-[14px] font-medium text-ink">{t("title")}</h2>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unread === 0}
              className="icon-btn h-8 w-8"
              aria-label={t("markAllRead")}
              title={t("markAllRead")}
            >
              <CheckCheck size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={items.length === 0}
              className="icon-btn h-8 w-8"
              aria-label={t("clearAll")}
              title={t("clearAll")}
            >
              <Trash2 size={16} aria-hidden />
            </button>
            <Link
              href="/settings/notifications"
              onClick={() => setOpen(false)}
              className="icon-btn h-8 w-8"
              aria-label={t("settings")}
              title={t("settings")}
            >
              <Settings size={16} aria-hidden />
            </Link>
          </div>

          {confirmClear && items.length > 0 && (
            <div role="alertdialog" aria-label={t("clearConfirm")} className="flex items-center gap-2 border-b border-line px-4 py-2 text-[13px]">
              <span className="flex-1 text-ink-soft">{t("clearConfirm")}</span>
              <button
                type="button"
                onClick={() => {
                  clearAll();
                  setConfirmClear(false);
                }}
                className="inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] font-medium text-danger hover:bg-hover"
              >
                {t("clearYes")}
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink"
              >
                {t("cancel")}
              </button>
            </div>
          )}

          {dnd && (
            <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12.5px] text-ink-mute">
              <BellOff size={13} aria-hidden />
              {t("dndActive", {
                time: new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(prefs.dndUntil),
              })}
            </p>
          )}

          {showPrompt && (
            <div className="border-b border-line px-4 py-3 text-[13px]">
              <p className="text-ink-soft">{t("desktopPrompt")}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await enableDesktop();
                    dismissPrompt();
                  }}
                  className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-ink hover:bg-primary-hover"
                >
                  {t("desktopEnable")}
                </button>
                <button
                  type="button"
                  onClick={dismissPrompt}
                  className="inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink"
                >
                  {t("desktopLater")}
                </button>
              </div>
            </div>
          )}

          <div ref={list} tabIndex={-1} onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto py-1 outline-none">
            {items.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-[14px] font-medium text-ink">{t("empty")}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-mute">{t("emptyHint")}</p>
              </div>
            ) : (
              groups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <h3 className="px-4 pt-2.5 pb-1 text-[11.5px] font-medium tracking-wide text-ink-mute uppercase">{group.label}</h3>
                  <ul>
                    {group.items.map((n) => (
                      <li key={n.id} className="group/n relative">
                        <Item
                          n={n}
                          onOpen={() => {
                            setOpen(false);
                            openNotification(n);
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => dismiss([n.id])}
                          aria-label={t("remove")}
                          title={t("remove")}
                          className="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-md bg-sheet text-ink-mute shadow-[0_0_0_1px_var(--color-line)] transition-opacity hover:text-ink focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/n:opacity-100"
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const d = describe(n, t, locale);
  const { icon: Icon, color } = CATEGORY_ICON[n.category];
  return (
    <button
      type="button"
      data-nitem
      onClick={onOpen}
      className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none [@media(hover:none)]:pr-11"
    >
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-sheet-muted" style={{ color }} aria-hidden>
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13.5px] ${n.read ? "text-ink-soft" : "font-medium text-ink"}`}>{d.title}</span>
          <span className="shrink-0 text-[11.5px] text-ink-mute tabular-nums">{shortTime(n.created, locale)}</span>
        </span>
        <span className="block truncate text-[12px] text-ink-mute">
          {d.title === d.label ? "" : d.label}
          {n.count > 1 && <span> · {t("count", { count: n.count })}</span>}
        </span>
        {d.body && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-ink-soft">{d.body}</span>}
      </span>
      {!n.read && (
        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" role="img" aria-label={t("unread")} />
      )}
    </button>
  );
}
