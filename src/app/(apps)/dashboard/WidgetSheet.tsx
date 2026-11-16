"use client";

// Side sheets of the edit mode: the widget picker and the config editor of one widget. Configs are
// validated by the server (same rules as for Claude); its message is shown as is.
import { BarChart3, CalendarDays, Clock, Code2, HardDrive, Link2, Mail, MessageSquare, StickyNote, Video, X, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { WIDGET_TYPES, type Config, type Widget, type WidgetType } from "./model";

export const TYPE_ICONS: Record<WidgetType, LucideIcon> = {
  agenda: CalendarDays,
  mail: Mail,
  chat: MessageSquare,
  drive: HardDrive,
  meetings: Video,
  notes: StickyNote,
  links: Link2,
  clock: Clock,
  chart: BarChart3,
  custom: Code2,
};

const CUSTOM_STARTER = `<div class="box">
  <div class="n" id="n">…</div>
  <div class="l">unread</div>
</div>
<style>
  .box { height: 100vh; display: grid; place-content: center; text-align: center; }
  .n { font-size: 40px; font-weight: 600; color: var(--zw-accent); }
  .l { color: var(--zw-ink-mute); }
</style>
<script>
  zentico.query("mail.search", { unreadOnly: true, limit: 50 })
    .then((r) => { document.getElementById("n").textContent = r.total; })
    .catch((e) => { document.getElementById("n").textContent = "–"; });
</script>`;

/** Starting config for a widget added from the picker. */
export function starterConfig(type: WidgetType, t: (k: string) => string): Config {
  switch (type) {
    case "chart":
      return { kind: "bar", labels: ["1", "2", "3", "4", "5"], series: [{ name: "", values: [3, 5, 2, 6, 4] }] };
    case "custom":
      return { html: CUSTOM_STARTER };
    case "notes":
      return { text: t("notesStarter") };
    default:
      return {};
  }
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useTranslations("dashboard");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,textarea,select,button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="pop m-2 flex w-full max-w-[420px] flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 className="flex-1 truncate text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" className="icon-btn" aria-label={t("close")} onClick={onClose}>
            <X size={17} aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function WidgetPicker({ onPick, onClose }: { onPick: (type: WidgetType) => void; onClose: () => void }) {
  const t = useTranslations("dashboard");
  return (
    <Sheet title={t("addWidget")} onClose={onClose}>
      <ul className="flex flex-col gap-1 overflow-y-auto p-2">
        {WIDGET_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type];
          return (
            <li key={type}>
              <button type="button" onClick={() => onPick(type)} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-hover">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-sheet-muted text-ink-soft">
                  <Icon size={16} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-ink">{t(`types.${type}`)}</span>
                  <span className="block text-[12.5px] leading-snug text-ink-mute">{t(`typeHints.${type}`)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

const LABEL = "flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft";
const INPUT = "h-9 rounded-lg border border-line bg-sheet px-3 text-[14px] font-normal text-ink outline-none focus:border-line-strong";
const AREA = "rounded-lg border border-line bg-sheet p-3 text-[13px] font-normal text-ink outline-none focus:border-line-strong";
const CHECK = "flex items-center gap-2 text-[13.5px] text-ink";

const linesOf = (items: { a: string; b: string }[]) => items.map((i) => (i.a ? `${i.a} | ${i.b}` : i.b)).join("\n");
function parseLines(text: string): { a: string; b: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf("|");
      return i >= 0 ? { a: l.slice(0, i).trim(), b: l.slice(i + 1).trim() } : { a: "", b: l };
    });
}

/** Form state: plain strings / booleans keyed by field; converted to a config on save. */
type Form = Record<string, string | boolean>;

function toForm(w: Widget): Form {
  const c = w.config;
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (w.type) {
    case "links":
      return { items: linesOf(((c.items as { label: string; url: string }[]) ?? []).map((i) => ({ a: i.label, b: i.url }))) };
    case "clock":
      return { zones: linesOf(((c.zones as { label: string; timeZone: string }[]) ?? []).map((z) => ({ a: z.label, b: z.timeZone }))), hour12: !!c.hour12, seconds: !!c.seconds };
    case "chart":
      return { json: JSON.stringify(c, null, 2) };
    case "custom":
      return { html: s(c.html) };
    case "notes":
      return { text: s(c.text) };
    default:
      return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "boolean" ? v : s(v)]));
  }
}

function fromForm(type: WidgetType, f: Form): Config {
  const n = (k: string) => (f[k] === "" || f[k] == null ? undefined : Number(f[k]));
  const s = (k: string) => String(f[k] ?? "").trim();
  switch (type) {
    case "agenda":
      return { days: n("days"), limit: n("limit") };
    case "mail":
      return { mode: s("mode") || "unread", query: s("query"), folder: s("folder"), unreadOnly: !!f.unreadOnly, limit: n("limit") };
    case "chat":
      return { mode: s("mode") || "unread", conversationId: s("conversationId"), limit: n("limit") };
    case "drive":
      return { mode: s("mode") || "recent", folderId: s("folderId"), limit: n("limit") };
    case "meetings":
      return { upcoming: !!f.upcoming, recordings: !!f.recordings, days: n("days"), limit: n("limit") };
    case "notes":
      return { text: String(f.text ?? "") };
    case "links":
      return { items: parseLines(String(f.items ?? "")).map((i) => ({ label: i.a, url: i.b })) };
    case "clock":
      return { zones: parseLines(String(f.zones ?? "")).map((i) => ({ label: i.a, timeZone: i.b })), hour12: !!f.hour12, seconds: !!f.seconds };
    case "chart":
      try {
        return JSON.parse(String(f.json ?? "{}")) as Config;
      } catch {
        throw new Error("JSON");
      }
    case "custom":
      return { html: String(f.html ?? "") };
  }
}

export function WidgetConfigSheet({
  widget,
  onSave,
  onClose,
}: {
  widget: Widget;
  onSave: (title: string, config: Config) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations("dashboard");
  const tc = useTranslations("dashboard.config");
  const [title, setTitle] = useState(widget.title);
  const [form, setForm] = useState<Form>(() => toForm(widget));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const str = (k: string) => String(form[k] ?? "");

  const text = (k: string, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className={LABEL}>
      {label}
      <input className={INPUT} value={str(k)} onChange={(e) => set(k, e.target.value)} {...extra} />
    </label>
  );
  const num = (k: string, label: string, min: number, max: number) => text(k, label, { type: "number", min, max, inputMode: "numeric" });
  const check = (k: string, label: string) => (
    <label className={CHECK}>
      <input type="checkbox" checked={!!form[k]} onChange={(e) => set(k, e.target.checked)} className="h-4 w-4 accent-[var(--color-ink)]" />
      {label}
    </label>
  );
  const select = (k: string, label: string, options: string[]) => (
    <label className={LABEL}>
      {label}
      <select className={INPUT} value={str(k) || options[0]} onChange={(e) => set(k, e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {tc(`modes.${o}`)}
          </option>
        ))}
      </select>
    </label>
  );
  const area = (k: string, label: string, hint?: string, rows = 8, mono = false) => (
    <label className={LABEL}>
      {label}
      <textarea className={`${AREA} ${mono ? "font-mono text-[12px]" : ""}`} rows={rows} value={str(k)} onChange={(e) => set(k, e.target.value)} spellCheck={!mono} />
      {hint && <span className="text-[12px] font-normal text-ink-mute">{hint}</span>}
    </label>
  );

  let fields: ReactNode = null;
  switch (widget.type) {
    case "agenda":
      fields = (
        <>
          {num("days", tc("days"), 1, 14)}
          {num("limit", tc("limit"), 1, 50)}
        </>
      );
      break;
    case "mail":
      fields = (
        <>
          {select("mode", tc("mode"), ["unread", "search"])}
          {str("mode") === "search" && text("query", tc("query"), { maxLength: 200 })}
          {text("folder", tc("folder"), { maxLength: 100, placeholder: "inbox" })}
          {str("mode") === "search" && check("unreadOnly", tc("unreadOnly"))}
          {num("limit", tc("limit"), 1, 50)}
        </>
      );
      break;
    case "chat":
      fields = (
        <>
          {select("mode", tc("mode"), ["unread", "conversation"])}
          {str("mode") === "conversation" && text("conversationId", tc("conversationId"))}
          {num("limit", tc("limit"), 1, 50)}
        </>
      );
      break;
    case "drive":
      fields = (
        <>
          {select("mode", tc("mode"), ["recent", "folder"])}
          {str("mode") === "folder" && text("folderId", tc("folderId"))}
          {num("limit", tc("limit"), 1, 50)}
        </>
      );
      break;
    case "meetings":
      fields = (
        <>
          {check("upcoming", tc("upcoming"))}
          {check("recordings", tc("recordings"))}
          {num("days", tc("days"), 1, 14)}
          {num("limit", tc("limit"), 1, 20)}
        </>
      );
      break;
    case "notes":
      fields = area("text", tc("text"), tc("markdownHint"), 14);
      break;
    case "links":
      fields = area("items", tc("links"), tc("linksHint"), 10);
      break;
    case "clock":
      fields = (
        <>
          {area("zones", tc("zones"), tc("zonesHint"), 5)}
          {check("hour12", tc("hour12"))}
          {check("seconds", tc("seconds"))}
        </>
      );
      break;
    case "chart":
      fields = area("json", tc("chartJson"), tc("chartHint"), 16, true);
      break;
    case "custom":
      fields = area("html", tc("html"), tc("htmlHint"), 18, true);
      break;
  }

  const save = async () => {
    let config: Config;
    try {
      config = fromForm(widget.type, form);
    } catch {
      setError(tc("invalidJson"));
      return;
    }
    setSaving(true);
    setError(null);
    const err = await onSave(title.trim(), config);
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Sheet title={tc("title", { type: t(`types.${widget.type}`) })} onClose={onClose}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <label className={LABEL}>
            {tc("widgetTitle")}
            <input className={INPUT} value={title} maxLength={80} placeholder={t(`types.${widget.type}`)} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {fields}
          {error && (
            <p role="alert" className="rounded-lg border border-danger/30 bg-sheet-muted px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-[13.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-[13.5px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-60"
          >
            {t("save")}
          </button>
        </footer>
      </form>
    </Sheet>
  );
}
