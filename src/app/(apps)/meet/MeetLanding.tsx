"use client";

import { ArrowRight, Clock, Keyboard, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { generateRoomCode, meetHref, parseRoomInput } from "./shared";

export function MeetLanding({ recent }: { recent: string[] }) {
  const t = useTranslations("meet");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const room = parseRoomInput(code);
    if (!room) return setInvalid(true);
    router.push(meetHref(room));
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-12">
      <div className="rise">
        <span
          className="grid h-12 w-12 place-items-center rounded-xl border border-line bg-sheet-muted"
          style={{ color: "var(--color-app-meet)" }}
        >
          <Video size={22} aria-hidden />
        </span>
        <h1 className="mt-6 text-[28px] font-semibold tracking-tight text-ink">{t("landingTitle")}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{t("landingBody")}</p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-start">
          <button
            type="button"
            onClick={() => router.push(meetHref(generateRoomCode()))}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover"
          >
            <Video size={15} aria-hidden />
            {t("newMeeting")}
          </button>
          <form onSubmit={join} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex gap-2">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">{t("joinLabel")}</span>
                <Keyboard
                  size={15}
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-mute"
                />
                <input
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setInvalid(false);
                  }}
                  placeholder={t("joinPlaceholder")}
                  maxLength={300}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? "meet-code-error" : undefined}
                  className="h-10 w-full rounded-lg border border-line bg-sheet pr-3 pl-9 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute aria-invalid:border-danger"
                />
              </label>
              <button
                type="submit"
                disabled={!code.trim()}
                className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-[14px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50"
              >
                {t("join")}
              </button>
            </div>
            {invalid && (
              <p id="meet-code-error" className="text-[12px] text-danger">
                {t("invalidCode")}
              </p>
            )}
          </form>
        </div>

        {recent.length > 0 && (
          <section className="mt-12">
            <h2 className="text-[12px] font-medium tracking-wide text-ink-mute uppercase">{t("recent")}</h2>
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line">
              {recent.map((room) => (
                <li key={room}>
                  <Link
                    href={meetHref(room)}
                    className="group flex h-11 items-center gap-3 px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
                  >
                    <Clock size={15} aria-hidden className="shrink-0 text-ink-mute" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{room}</span>
                    <ArrowRight
                      size={15}
                      aria-hidden
                      className="shrink-0 text-ink-mute opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
