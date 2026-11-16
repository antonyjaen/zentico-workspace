"use client";

import { ChevronDown, Phone, Users, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { usePopover } from "@/components/usePopover";
import { CALL_RING_CHANNEL_MAX, type CallMedia, type ConversationKind } from "./shared";
import { BTN_MEET } from "./ui";

const ITEM =
  "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none";

/**
 * "Call" button with voice / video options. DMs and groups ring the others; channels offer
 * "Start a meeting" (notifies, rings nobody) and, when small, "Ring everyone".
 */
export function CallMenu({
  kind,
  memberCount,
  disabled,
  onCall,
  onMeet,
  align = "right",
}: {
  kind: ConversationKind;
  memberCount: number;
  disabled?: boolean;
  onCall: (media: CallMedia, ringAll: boolean) => void;
  onMeet?: () => void;
  align?: "left" | "right";
}) {
  const t = useTranslations("chat");
  const pop = usePopover();
  const menu = useRef<HTMLDivElement>(null);
  const channel = kind === "channel";
  const canRingAll = channel && memberCount <= CALL_RING_CHANNEL_MAX;

  useEffect(() => {
    if (pop.open) menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pop.open]);

  const pick = (fn: () => void) => () => {
    pop.setOpen(false);
    fn();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div ref={pop.ref} className="relative">
      <button
        type="button"
        onClick={pop.toggle}
        disabled={disabled}
        className={`${BTN_MEET} px-2 sm:px-3`}
        style={{ background: "var(--color-app-meet)" }}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-label={t("callMenu")}
        title={t("call")}
      >
        {channel ? <Video size={15} aria-hidden /> : <Phone size={15} aria-hidden />}
        <span className="hidden sm:inline">{channel ? t("meetNow") : t("call")}</span>
        <ChevronDown size={13} aria-hidden className="-mr-0.5 opacity-80" />
      </button>
      {pop.open && (
        <div
          ref={menu}
          role="menu"
          aria-label={t("callMenu")}
          onKeyDown={onKeyDown}
          className={`pop absolute top-10 z-30 w-64 p-1.5 ${align === "right" ? "right-0" : "left-0"}`}
        >
          {channel && onMeet && (
            <button type="button" role="menuitem" className={ITEM} onClick={pick(onMeet)}>
              <Video size={15} aria-hidden className="mt-0.5 shrink-0 text-ink-soft" />
              <span className="min-w-0">
                <span className="block font-medium">{t("startMeeting")}</span>
                <span className="block text-[12px] text-ink-mute">{t("startMeetingHint")}</span>
              </span>
            </button>
          )}
          {(!channel || canRingAll) && (
            <>
              <button type="button" role="menuitem" className={ITEM} onClick={pick(() => onCall("audio", channel))}>
                {channel ? <Users size={15} aria-hidden className="mt-0.5 shrink-0 text-ink-soft" /> : <Phone size={15} aria-hidden className="mt-0.5 shrink-0 text-ink-soft" />}
                <span className="min-w-0">
                  <span className="block font-medium">{channel ? t("ringAllVoice") : t("callVoice")}</span>
                  {channel && <span className="block text-[12px] text-ink-mute">{t("ringAllHint", { count: memberCount })}</span>}
                </span>
              </button>
              <button type="button" role="menuitem" className={ITEM} onClick={pick(() => onCall("video", channel))}>
                <Video size={15} aria-hidden className="mt-0.5 shrink-0 text-ink-soft" />
                <span className="block font-medium">{channel ? t("ringAllVideo") : t("callVideo")}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
