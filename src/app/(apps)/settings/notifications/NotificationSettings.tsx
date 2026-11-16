"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useNotifications } from "@/components/notifications/NotificationsProvider";
import type { NotificationPrefs } from "@/lib/notifications/types";

type BoolPref = "chat" | "channelMentionsOnly" | "meetings" | "mail" | "calendar" | "claude" | "sound" | "ringtone";

function Switch({ checked, onChange, labelledBy, describedBy, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors disabled:opacity-50 aria-checked:bg-primary"
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-sheet shadow-sm transition-transform duration-150 ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

function Row({ id, label, hint, children, nested }: { id: string; label: string; hint?: string; children: React.ReactNode; nested?: boolean }) {
  return (
    <div className={`flex items-start gap-4 py-3 ${nested ? "pl-6" : ""}`}>
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="text-[14px] text-ink">
          {label}
        </p>
        {hint && (
          <p id={`${id}-hint`} className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/** Tomorrow at 08:00 local time. */
function tomorrowAt8(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

export function NotificationSettings() {
  const t = useTranslations("notifications.page");
  const tn = useTranslations("notifications");
  const locale = useLocale();
  const { prefs, loaded, permission, savePrefs, enableDesktop } = useNotifications();
  const [status, setStatus] = useState<"saved" | "error" | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (status !== "saved") return;
    const id = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(id);
  }, [status]);

  const save = async (patch: Partial<NotificationPrefs>) => {
    setStatus((await savePrefs(patch)) ? "saved" : "error");
  };

  const toggle = (key: BoolPref) => (v: boolean) => void save({ [key]: v });

  const setDesktop = async (on: boolean) => {
    if (!on) return save({ desktop: false });
    setStatus((await enableDesktop()) ? "saved" : null);
  };

  const dndOn = now > 0 && prefs.dndUntil > now;
  const dndTime = dndOn
    ? new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(prefs.dndUntil)
    : "";

  const switchFor = (id: BoolPref, disabled?: boolean) => (
    <Switch
      checked={prefs[id]}
      onChange={toggle(id)}
      labelledBy={`n-${id}-label`}
      describedBy={`n-${id}-hint`}
      disabled={!loaded || disabled}
    />
  );

  return (
    <div className="mx-auto max-w-2xl px-5 py-6">
      <p className="text-[14px] leading-relaxed text-ink-soft">{t("intro")}</p>

      <section aria-labelledby="n-what" className="mt-6">
        <h2 id="n-what" className="text-[13px] font-medium tracking-wide text-ink-mute uppercase">
          {t("whatTitle")}
        </h2>
        <div className="mt-2 divide-y divide-line border-y border-line">
          <Row id="n-chat" label={t("chat")} hint={t("chatHint")}>
            {switchFor("chat")}
          </Row>
          <Row id="n-channelMentionsOnly" label={t("channelMentionsOnly")} hint={t("channelMentionsOnlyHint")} nested>
            {switchFor("channelMentionsOnly", !prefs.chat)}
          </Row>
          <Row id="n-meetings" label={t("meetings")} hint={t("meetingsHint")}>
            {switchFor("meetings")}
          </Row>
          <Row id="n-mail" label={t("mail")} hint={t("mailHint")}>
            {switchFor("mail")}
          </Row>
          <Row id="n-calendar" label={t("calendar")} hint={t("calendarHint")}>
            {switchFor("calendar")}
          </Row>
          <Row id="n-claude" label={t("claude")} hint={t("claudeHint")}>
            {switchFor("claude")}
          </Row>
        </div>
      </section>

      <section aria-labelledby="n-how" className="mt-8">
        <h2 id="n-how" className="text-[13px] font-medium tracking-wide text-ink-mute uppercase">
          {t("howTitle")}
        </h2>
        <div className="mt-2 divide-y divide-line border-y border-line">
          <Row id="n-desktop" label={t("desktop")} hint={t("desktopHint")}>
            <Switch
              checked={prefs.desktop && permission === "granted"}
              onChange={(v) => void setDesktop(v)}
              labelledBy="n-desktop-label"
              describedBy="n-desktop-hint n-desktop-note"
              disabled={!loaded || permission === "unsupported" || permission === "denied"}
            />
          </Row>
          {(permission === "denied" || permission === "unsupported") && (
            <p id="n-desktop-note" className="py-2 text-[12.5px] text-amber">
              {permission === "denied" ? tn("desktopBlocked") : tn("desktopUnsupported")}
            </p>
          )}
          <Row id="n-sound" label={t("sound")} hint={t("soundHint")}>
            {switchFor("sound")}
          </Row>
          <Row id="n-ringtone" label={t("ringtone")} hint={t("ringtoneHint")}>
            {switchFor("ringtone")}
          </Row>
        </div>
      </section>

      <section aria-labelledby="n-dnd" className="mt-8">
        <h2 id="n-dnd" className="text-[13px] font-medium tracking-wide text-ink-mute uppercase">
          {t("dndTitle")}
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">{t("dndHint")}</p>
        <div role="group" aria-labelledby="n-dnd" className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["off", t("dndOff"), 0],
              ["hour", t("dndHour"), -1],
              ["tomorrow", t("dndTomorrow"), -2],
            ] as const
          ).map(([key, label, code]) => {
            const current = key === "off" && !dndOn;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={key === "off" ? current : undefined}
                disabled={!loaded || current}
                onClick={() => void save({ dndUntil: code === 0 ? 0 : code === -1 ? Date.now() + 3_600_000 : tomorrowAt8() })}
                className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink disabled:opacity-60 aria-pressed:border-ink aria-pressed:text-ink aria-pressed:opacity-100"
              >
                {label}
              </button>
            );
          })}
        </div>
        {dndOn && <p className="mt-2 text-[13px] text-ink">{t("dndUntil", { time: dndTime })}</p>}
      </section>

      <div className="mt-6 h-5" aria-live="polite">
        {status === "saved" && <span className="font-mono text-[12px] tracking-[0.15em] text-signal uppercase">{t("saved")}</span>}
        {status === "error" && (
          <span role="alert" className="text-[13px] text-danger">
            {t("error")}
          </span>
        )}
      </div>
    </div>
  );
}
