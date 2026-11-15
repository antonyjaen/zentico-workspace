"use client";

import { Check, Star, Trash2, Users, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { Calendar, ShareRole } from "@/lib/calendar";
import { createCalendar, deleteCalendar, setDefaultCalendar, shareCalendar, updateCalendar } from "./actions";
import { Combobox, principalItem, usePrincipalMatches, usePrincipals } from "./people";
import { BTN, BTN_PRIMARY, CAL_COLORS, FIELD } from "./shared";

const ROLES: ShareRole[] = ["freebusy", "read", "write", "manage"];

/** Create a calendar (calendar = null) or edit one of mine: name, color, sharing, default, delete. */
export function CalendarDialog({
  calendar,
  myEmail,
  onClose,
}: {
  calendar: Calendar | null;
  myEmail: string;
  onClose: () => void;
}) {
  const t = useTranslations("calendar");
  const principals = usePrincipals();
  const [name, setName] = useState(calendar?.name ?? "");
  const [color, setColor] = useState(calendar?.color ?? CAL_COLORS[0]);
  const [shares, setShares] = useState<Record<string, ShareRole>>(calendar?.shareWith ?? {});
  const [q, setQ] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = useMemo(() => principals?.find((p) => p.email === myEmail.toLowerCase())?.id, [principals, myEmail]);
  const exclude = useMemo(() => new Set([...Object.keys(shares), ...(me ? [me] : [])]), [shares, me]);
  const found = usePrincipalMatches(principals, q, { exclude, groups: true });
  const byId = useMemo(() => new Map((principals ?? []).map((p) => [p.id, p])), [principals]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<{ ok: boolean }>, close = true) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(t("errors.calendar"));
    else if (close) onClose();
    return r.ok;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    if (!calendar) return run(() => createCalendar(name, color));
    const sharesChanged = JSON.stringify(shares) !== JSON.stringify(calendar.shareWith);
    const propsChanged = name.trim() !== calendar.name || color !== calendar.color;
    return run(async () => {
      if (propsChanged) {
        const r = await updateCalendar(calendar.id, { name, color });
        if (!r.ok) return r;
      }
      if (sharesChanged) return shareCalendar(calendar.id, shares);
      return { ok: true };
    });
  }

  const title = calendar ? t("manage.editTitle") : t("manage.newTitle");

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pop flex max-h-[92dvh] w-full max-w-[480px] flex-col overflow-hidden"
        style={{ transformOrigin: "center" }}
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="flex-1 text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" className="icon-btn" aria-label={t("details.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft">
            {t("manage.name")}
            <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={255} className={FIELD} />
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">{t("manage.color")}</legend>
            <div className="flex flex-wrap gap-2">
              {CAL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  className="grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-[var(--color-sheet)] transition-transform hover:scale-110 aria-pressed:ring-2"
                  style={{ background: c, ["--tw-ring-color" as string]: c }}
                >
                  {color === c && <Check size={14} strokeWidth={3} color="#fff" aria-hidden />}
                </button>
              ))}
            </div>
          </fieldset>

          {calendar?.mayShare && (
            <section className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
                <Users size={14} aria-hidden />
                {t("manage.sharing")}
              </h3>
              <Combobox
                value={q}
                onChange={setQ}
                items={found.map(principalItem)}
                onPick={(it) => {
                  setShares((s) => ({ ...s, [it.key]: "read" }));
                  setQ("");
                }}
                placeholder={principals && principals.length === 0 ? t("people.unavailable") : t("manage.addPeople")}
                label={t("manage.addPeople")}
              />
              {Object.keys(shares).length > 0 ? (
                <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {Object.entries(shares).map(([pid, role]) => {
                    const p = byId.get(pid);
                    return (
                      <li key={pid} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-ink">{p ? p.name || p.email : pid}</span>
                          {p?.name && p.email && <span className="ml-1.5 text-ink-mute">{p.email}</span>}
                        </span>
                        <select
                          value={role}
                          onChange={(e) => setShares((s) => ({ ...s, [pid]: e.target.value as ShareRole }))}
                          className="h-7 rounded-md border border-line bg-sheet px-1.5 text-[12px] text-ink-soft"
                          aria-label={t("manage.role")}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {t(`manage.roles.${r}`)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="icon-btn !h-7 !w-7"
                          aria-label={t("manage.removeShare", { name: p?.name || p?.email || pid })}
                          onClick={() => setShares(({ [pid]: _, ...rest }) => rest)}
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-mute">{t("manage.notShared")}</p>
              )}
            </section>
          )}

          {calendar && !calendar.isDefault && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <button type="button" className={BTN} disabled={busy} onClick={() => run(() => setDefaultCalendar(calendar.id))}>
                <Star size={14} aria-hidden />
                {t("manage.makeDefault")}
              </button>
              {calendar.mayDelete &&
                (confirmDelete ? (
                  <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-soft">
                    {t("manage.confirmDelete")}
                    <button type="button" className={`${BTN} text-danger`} disabled={busy} onClick={() => run(() => deleteCalendar(calendar.id))}>
                      {t("details.delete")}
                    </button>
                    <button type="button" className={BTN} onClick={() => setConfirmDelete(false)}>
                      {t("editor.cancel")}
                    </button>
                  </span>
                ) : (
                  <button type="button" className={`${BTN} ml-auto hover:text-danger`} onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={14} aria-hidden />
                    {t("manage.delete")}
                  </button>
                ))}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          {error && (
            <p role="alert" className="min-w-0 flex-1 truncate text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              {t("editor.cancel")}
            </button>
            <button type="submit" className={BTN_PRIMARY} disabled={busy || !name.trim()}>
              {busy ? t("editor.saving") : calendar ? t("editor.save") : t("manage.create")}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
