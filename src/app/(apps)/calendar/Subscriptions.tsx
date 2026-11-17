"use client";

// External calendars: sidebar list of ICS subscriptions, the subscribe/settings dialog, the .ics
// import dialog, the CalDAV info dialog and the header menu that opens them (works on phones too).
import { Check, Copy, EllipsisVertical, FileUp, RefreshCw, Rss, Server, Settings2, TriangleAlert, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Calendar } from "@/lib/calendar";
import type { Subscription } from "@/lib/calendar-subs/service";
import { usePopover } from "@/components/usePopover";
import { BTN, BTN_PRIMARY, CAL_COLORS, FIELD } from "./shared";
import {
  importIcs,
  previewIcsImport,
  probeSubscription,
  refreshSubscriptionNow,
  subscribe,
  unsubscribe,
  updateSubscriptionSettings,
  type ImportPreview,
  type ImportReport,
} from "./sync-actions";

const INTERVALS = [5, 15, 30, 60, 180, 720, 1440];
const SECTION = "mb-1 flex h-7 items-center justify-between pr-1 pl-3 text-[11px] font-medium tracking-wide text-ink-mute uppercase";

type T = ReturnType<typeof useTranslations<"calendarSync">>;

/** Message for an error code from the sync actions / last refresh ("http_404" → status 404). */
export function syncError(t: T, code: string): string {
  if (code.startsWith("http_")) return t("errors.http", { status: code.slice(5) });
  const known = ["invalid_url", "blocked", "dns", "timeout", "too_large", "not_calendar", "redirects", "network", "limit", "duplicate", "rate_limited", "delegated", "not_found", "empty", "too_many", "invalid"];
  return t(`errors.${(known.includes(code) ? code : "failed") as "failed"}`);
}

function relative(locale: string, ms: number): string {
  const diff = Math.round((ms - Date.now()) / 60_000);
  const f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(diff) < 60) return f.format(diff, "minute");
  if (Math.abs(diff) < 1440) return f.format(Math.round(diff / 60), "hour");
  return f.format(Math.round(diff / 1440), "day");
}

// ---- Sidebar ----

export function SubscriptionList({
  subscriptions,
  hidden,
  refreshing,
  onToggle,
  onAdd,
  onEdit,
  onRefresh,
}: {
  subscriptions: Subscription[];
  hidden: Set<string>;
  refreshing: string | null;
  onToggle: (s: Subscription) => void;
  onAdd: () => void;
  onEdit: (s: Subscription) => void;
  onRefresh: (s: Subscription) => void;
}) {
  const t = useTranslations("calendarSync");
  return (
    <nav aria-label={t("section")} className="mb-4 flex flex-col gap-0.5">
      <h2 className={SECTION}>
        {t("section")}
        <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("subscribe")} title={t("subscribe")} onClick={onAdd}>
          <Rss size={14} aria-hidden />
        </button>
      </h2>
      {subscriptions.map((s) => {
        const on = !hidden.has(s.key);
        return (
          <div key={s.id} className="group flex h-8 items-center rounded-md transition-colors hover:bg-hover">
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onToggle(s)}
              className="flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left text-[14px] text-ink-soft group-hover:text-ink"
            >
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border" style={{ background: on ? s.color : "transparent", borderColor: s.color }}>
                {on && <Check size={11} strokeWidth={3} color="#fff" aria-hidden />}
              </span>
              <span className="flex-1 truncate">{s.name}</span>
              {s.lastError && (
                <span role="img" aria-label={t("row.failing", { error: syncError(t, s.lastError) })} title={t("row.failing", { error: syncError(t, s.lastError) })} className="shrink-0 text-danger">
                  <TriangleAlert size={13} aria-hidden />
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onRefresh(s)}
              disabled={refreshing === s.id}
              aria-label={t("row.refresh")}
              title={t("row.refresh")}
              className="icon-btn !h-7 !w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-100"
            >
              <RefreshCw size={13} aria-hidden className={refreshing === s.id ? "animate-spin" : undefined} />
            </button>
            <button
              type="button"
              onClick={() => onEdit(s)}
              aria-label={t("row.settingsFor", { name: s.name })}
              title={t("row.settingsFor", { name: s.name })}
              className="icon-btn !h-7 !w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Settings2 size={14} aria-hidden />
            </button>
          </div>
        );
      })}
      {subscriptions.length === 0 && (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-8 items-center gap-3 rounded-md px-3 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <Rss size={16} aria-hidden className="shrink-0" />
          {t("subscribe")}
        </button>
      )}
    </nav>
  );
}

/** Header "⋮" menu: subscribe, import, CalDAV (also the way in on phones, where the sidebar is hidden). */
export function SyncMenu({ canSubscribe, onSubscribe, onImport, onDav }: { canSubscribe: boolean; onSubscribe: () => void; onImport: () => void; onDav: () => void }) {
  const t = useTranslations("calendarSync");
  const { open, setOpen, toggle, ref } = usePopover();
  const item = "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink";
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" className="icon-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={t("menu")} title={t("menu")}>
        <EllipsisVertical size={18} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute top-full right-0 z-40 mt-1 w-64 p-1.5" style={{ transformOrigin: "top right" }}>
          {canSubscribe && (
            <button type="button" role="menuitem" className={item} onClick={pick(onSubscribe)}>
              <Rss size={16} aria-hidden className="shrink-0" />
              {t("subscribe")}
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={pick(onImport)}>
            <FileUp size={16} aria-hidden className="shrink-0" />
            {t("import")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={pick(onDav)}>
            <Server size={16} aria-hidden className="shrink-0" />
            {t("caldav")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Dialog shell ----

function Dialog({ title, onClose, onSubmit, children, footer }: { title: string; onClose: () => void; onSubmit?: (e: React.FormEvent) => void; children: React.ReactNode; footer: React.ReactNode }) {
  const t = useTranslations("calendarSync");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        onSubmit={onSubmit ?? ((e) => e.preventDefault())}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pop flex max-h-[92dvh] w-full max-w-[480px] flex-col overflow-hidden"
        style={{ transformOrigin: "center" }}
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="flex-1 text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" className="icon-btn" aria-label={t("dialog.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">{footer}</footer>
      </form>
    </div>
  );
}

function ColorPicker({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {CAL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
            className="grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-[var(--color-sheet)] transition-transform hover:scale-110 aria-pressed:ring-2"
            style={{ background: c, ["--tw-ring-color" as string]: c }}
          >
            {value === c && <Check size={14} strokeWidth={3} color="#fff" aria-hidden />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const LABEL = "flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft";
const ERROR = "min-w-0 flex-1 text-[13px] text-danger";

// ---- Subscribe / settings ----

/** New subscription (sub = null) or settings of an existing one. `onDone` refreshes the page. */
export function SubscriptionDialog({ sub, onClose, onDone }: { sub: Subscription | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("calendarSync");
  const locale = useLocale();
  const [url, setUrl] = useState("");
  const [name, setName] = useState(sub?.name ?? "");
  const [color, setColor] = useState(sub?.color ?? CAL_COLORS[1]);
  const [refreshMin, setRefreshMin] = useState(sub?.refreshMin ?? 15);
  const [busyFlag, setBusyFlag] = useState(sub?.busy ?? true);
  const [probe, setProbe] = useState<{ url: string; state: "checking" | "ok" | "error"; name?: string; events?: number; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [refreshState, setRefreshState] = useState<string | null>(sub?.lastError ?? null);

  async function check() {
    const value = url.trim();
    if (!value || probe?.url === value) return;
    setProbe({ url: value, state: "checking" });
    const r = await probeSubscription(value);
    setProbe((p) => (p?.url !== value ? p : r.ok ? { url: value, state: "ok", name: r.data.name, events: r.data.events } : { url: value, state: "error", error: r.error }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const r = sub
      ? await updateSubscriptionSettings(sub.id, { name: name.trim() || sub.name, color, refreshMin, busy: busyFlag })
      : await subscribe({ url: url.trim(), name, color, busy: busyFlag, refreshMin });
    setSaving(false);
    if (!r.ok) return setError(syncError(t, r.error));
    onDone();
    onClose();
  }

  async function remove() {
    if (!sub) return;
    setSaving(true);
    const r = await unsubscribe(sub.id);
    setSaving(false);
    if (!r.ok) return setError(syncError(t, r.error));
    onDone();
    onClose();
  }

  async function refreshNow() {
    if (!sub) return;
    setSaving(true);
    setError(null);
    const r = await refreshSubscriptionNow(sub.id);
    setSaving(false);
    if (!r.ok) return setError(syncError(t, r.error));
    setRefreshState(r.data.error);
    onDone();
  }

  const found = probe?.state === "ok";
  return (
    <Dialog
      title={sub ? t("dialog.editTitle") : t("dialog.newTitle")}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {error && (
            <p role="alert" className={ERROR}>
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              {t("dialog.cancel")}
            </button>
            <button type="submit" className={BTN_PRIMARY} disabled={saving || (!sub && !url.trim())}>
              {sub ? (saving ? t("dialog.saving") : t("dialog.save")) : saving ? t("dialog.subscribing") : t("dialog.subscribe")}
            </button>
          </div>
        </>
      }
    >
      {sub ? (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-sheet-muted px-3 py-2 text-[13px] text-ink-soft">
          <span>
            {t("dialog.source")}: <span className="text-ink">{sub.host}</span>
          </span>
          <span>{sub.lastSuccess ? t("dialog.lastUpdate", { when: relative(locale, sub.lastSuccess), count: sub.eventCount }) : t("row.never")}</span>
          {refreshState && (
            <span role="status" className="flex items-start gap-1.5 text-danger">
              <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
              {t("row.failing", { error: syncError(t, refreshState) })}
            </span>
          )}
          <button type="button" className={`${BTN} mt-1 self-start`} disabled={saving} onClick={refreshNow}>
            <RefreshCw size={14} aria-hidden className={saving ? "animate-spin" : undefined} />
            {t("row.refresh")}
          </button>
        </div>
      ) : (
        <>
          <label className={LABEL}>
            {t("dialog.url")}
            <input
              autoFocus
              required
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={check}
              placeholder={t("dialog.urlPlaceholder")}
              maxLength={2048}
              className={FIELD}
            />
            <span className="text-[12px] font-normal text-ink-mute">{t("dialog.urlHint")}</span>
          </label>
          {probe && (
            <p role="status" className={`text-[13px] ${probe.state === "error" ? "text-danger" : "text-ink-soft"}`}>
              {probe.state === "checking"
                ? t("dialog.checking")
                : found
                  ? probe.name
                    ? t("dialog.found", { name: probe.name, count: probe.events ?? 0 })
                    : t("dialog.foundUnnamed", { count: probe.events ?? 0 })
                  : syncError(t, probe.error ?? "failed")}
            </p>
          )}
          <details className="rounded-md border border-line px-3 py-2 text-[13px] text-ink-soft">
            <summary className="cursor-pointer font-medium text-ink">{t("help.title")}</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4">
              <li>{t("help.google")}</li>
              <li>{t("help.outlook")}</li>
              <li>{t("help.apple")}</li>
            </ul>
            <p className="mt-2 text-[12px] text-ink-mute">{t("help.secret")}</p>
          </details>
        </>
      )}

      <label className={LABEL}>
        {t("dialog.name")}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required={!!sub}
          placeholder={(found && probe?.name) || t("dialog.namePlaceholder")}
          className={FIELD}
        />
      </label>

      <ColorPicker value={color} onChange={setColor} label={t("dialog.color")} />

      <label className={LABEL}>
        {t("dialog.refresh")}
        <select value={refreshMin} onChange={(e) => setRefreshMin(Number(e.target.value))} className={FIELD}>
          {INTERVALS.map((m) => (
            <option key={m} value={m}>
              {t("dialog.every", { label: t(`intervals.${m}` as "intervals.5") })}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-start gap-2.5 text-[13px] text-ink-soft">
        <input type="checkbox" checked={busyFlag} onChange={(e) => setBusyFlag(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]" />
        <span>
          <span className="text-ink">{t("dialog.busy")}</span>
          <span className="block text-[12px] text-ink-mute">{t("dialog.busyHint")}</span>
        </span>
      </label>

      {sub && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {confirmRemove ? (
            <span className="flex flex-wrap items-center gap-2 text-[13px] text-ink-soft">
              {t("dialog.confirmRemove")}
              <button type="button" className={`${BTN} text-danger`} disabled={saving} onClick={remove}>
                {t("dialog.remove")}
              </button>
              <button type="button" className={BTN} onClick={() => setConfirmRemove(false)}>
                {t("dialog.cancel")}
              </button>
            </span>
          ) : (
            <button type="button" className={`${BTN} hover:text-danger`} onClick={() => setConfirmRemove(true)}>
              <Trash2 size={14} aria-hidden />
              {t("dialog.remove")}
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---- .ics import ----

export function ImportDialog({ calendars, onClose, onDone }: { calendars: Calendar[]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("calendarSync");
  const writable = calendars.filter((c) => c.owner === null && c.mayWrite);
  const [file, setFile] = useState<File | null>(null);
  const [calendar, setCalendar] = useState((writable.find((c) => c.isDefault) ?? writable[0])?.key ?? "");
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = () => {
    const fd = new FormData();
    if (file) fd.set("file", file);
    fd.set("calendar", calendar);
    fd.set("mode", mode);
    return fd;
  };

  useEffect(() => {
    if (!file || !calendar) return;
    let live = true;
    setPreview(null);
    setReport(null);
    setError(null);
    if (file.size > 10 * 1024 * 1024) {
      setError(syncError(t, "too_large"));
      return;
    }
    setBusy("reading");
    const fd = new FormData();
    fd.set("file", file);
    fd.set("calendar", calendar);
    // A body over the server-action limit rejects instead of returning an error.
    void previewIcsImport(fd)
      .catch((): { ok: false; error: string } => ({ ok: false, error: "too_large" }))
      .then((r) => {
        if (!live) return;
        setBusy(null);
        if (r.ok) setPreview(r.data);
        else setError(syncError(t, r.error));
      });
    return () => {
      live = false;
    };
  }, [file, calendar, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || busy) return;
    setBusy("importing");
    setError(null);
    const r = await importIcs(form()).catch((): { ok: false; error: string } => ({ ok: false, error: "failed" }));
    setBusy(null);
    if (!r.ok) return setError(syncError(t, r.error));
    setReport(r.data);
    onDone();
  }

  return (
    <Dialog
      title={t("importDialog.title")}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {error && (
            <p role="alert" className={ERROR}>
              {error}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              {report ? t("dialog.close") : t("dialog.cancel")}
            </button>
            {!report && (
              <button type="submit" className={BTN_PRIMARY} disabled={!preview || !!busy}>
                {busy === "importing" ? t("importDialog.importing") : t("importDialog.import")}
              </button>
            )}
          </div>
        </>
      }
    >
      <label className={LABEL}>
        {t("importDialog.file")}
        <input
          type="file"
          accept=".ics,.ical,.ifb,.icalendar,text/calendar"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-[13px] font-normal text-ink-soft file:mr-3 file:h-8 file:rounded-md file:border file:border-line file:bg-sheet file:px-3 file:text-[13px] file:font-medium file:text-ink-soft hover:file:bg-hover"
        />
      </label>
      <label className={LABEL}>
        {t("importDialog.calendar")}
        <select value={calendar} onChange={(e) => setCalendar(e.target.value)} className={FIELD}>
          {writable.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {busy === "reading" && <p className="text-[13px] text-ink-soft">{t("importDialog.reading")}</p>}
      {preview && (
        <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5 text-[13px] text-ink-soft">
          <p className="text-ink">
            {t("importDialog.preview", { count: preview.events })}
            {preview.recurring > 0 && <span className="text-ink-mute"> · {t("importDialog.recurring", { count: preview.recurring })}</span>}
          </p>
          {preview.existing > 0 && !report && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1">{t("importDialog.existing", { count: preview.existing })}</legend>
              {(["skip", "update"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--color-primary)]" />
                  {t(`importDialog.${m}`)}
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-[12px] text-ink-mute">{t("importDialog.hint")}</p>
        </div>
      )}
      {report && (
        <p role="status" className="flex items-start gap-2 rounded-md bg-primary-soft px-3 py-2.5 text-[13px] text-ink">
          <Check size={15} aria-hidden className="mt-0.5 shrink-0" />
          {t("importDialog.done", report)}
        </p>
      )}
    </Dialog>
  );
}

// ---- CalDAV ----

function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations("calendarSync");
  const [done, setDone] = useState(false);
  return (
    <div className={LABEL}>
      {label}
      <div className="flex gap-2">
        <input readOnly value={value} className={`${FIELD} font-mono text-[13px]`} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className={`${BTN} !h-9 shrink-0`}
          aria-label={`${t("dav.copy")} ${label}`}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            })
          }
        >
          {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          <span className="hidden sm:inline">{done ? t("dav.copied") : t("dav.copy")}</span>
        </button>
      </div>
    </div>
  );
}

export function CalDavDialog({ server, username, onClose }: { server: string; username: string; onClose: () => void }) {
  const t = useTranslations("calendarSync");
  return (
    <Dialog
      title={t("dav.title")}
      onClose={onClose}
      footer={
        <button type="button" className={`${BTN} ml-auto`} onClick={onClose}>
          {t("dialog.close")}
        </button>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink-soft">{t("dav.body")}</p>
      <CopyField label={t("dav.server")} value={server} />
      <CopyField label={t("dav.username")} value={username} />
      <p className="text-[13px] text-ink-soft">
        {t("dav.passwordHint")}{" "}
        <Link href="/settings/security" className="font-medium text-ink underline underline-offset-2">
          {t("dav.appPasswords")}
        </Link>
      </p>
      <p className="text-[12px] text-ink-mute">{t("dav.outlook")}</p>
    </Dialog>
  );
}
