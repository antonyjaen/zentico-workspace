"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Vacation } from "@/lib/mail-settings";
import { saveVacation, type ActionResult } from "./actions";
import { RichEditor } from "./RichEditor";
import { Field, Status, inputCls, primaryBtn } from "./ui";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function VacationForm({ vacation }: { vacation: Vacation }) {
  const t = useTranslations("mailSettings.vacation");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isEnabled, setEnabled] = useState(vacation.isEnabled);
  const [fromDate, setFrom] = useState(day(vacation.fromDate));
  const [toDate, setTo] = useState(day(vacation.toDate));
  const [subject, setSubject] = useState(vacation.subject);
  const [body, setBody] = useState({ html: vacation.htmlBody, text: vacation.textBody });
  // Seed the editor from the plain body when the server only has text.
  const [initialHtml] = useState(() => vacation.htmlBody || escapeToHtml(vacation.textBody));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveVacation({
        isEnabled,
        fromDate,
        toDate,
        subject,
        htmlBody: body.html,
        textBody: body.text,
      });
      setResult(r);
      if (r.ok) router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-line px-4 py-3">
        <span>
          <span className="block text-[14px] font-medium text-ink">{t("enable")}</span>
          <span className="block text-[13px] text-ink-mute">{t("enableHint")}</span>
        </span>
        <Switch checked={isEnabled} onChange={setEnabled} label={t("enable")} />
      </label>

      <fieldset disabled={!isEnabled} className="space-y-5 transition-opacity disabled:opacity-50">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("from")} hint={t("optional")}>
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t("to")} hint={t("optional")}>
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <Field label={t("subject")}>
          <input
            maxLength={200}
            value={subject}
            placeholder={t("subjectPlaceholder")}
            onChange={(e) => setSubject(e.target.value)}
            className={inputCls}
          />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">{t("message")}</span>
          <RichEditor
            label={t("message")}
            initialHtml={initialHtml}
            minHeight={160}
            onChange={(html, text) => setBody({ html, text })}
          />
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn}>
          {t("save")}
        </button>
        <Status result={result} />
      </div>
    </form>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors aria-checked:bg-primary"
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-sheet shadow-sm transition-transform duration-150 ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

function escapeToHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
