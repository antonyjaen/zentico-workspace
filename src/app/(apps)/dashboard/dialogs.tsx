"use client";

// Dialogs of the Studio: confirming a mod's action, the block picker, app settings ("Convert to
// app"), publishing to the gallery.
import { Plus, ShieldQuestion, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { uiIcon } from "@/components/uiIcons";
import { COMPONENT_NAMES, COMPONENTS, ICON_NAMES, isColor, type ModView } from "@/lib/ui/schema";
import type { ConfirmRequest } from "./studio-context";

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const t = useTranslations("dashboard");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,textarea,select,button:not([data-close])")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`pop flex max-h-[85vh] w-full flex-col overflow-hidden ${wide ? "max-w-[560px]" : "max-w-[420px]"}`}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 className="flex-1 truncate text-[14.5px] font-semibold text-ink">{title}</h2>
          <button type="button" data-close className="icon-btn !h-8 !w-8" aria-label={t("close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

const BTN = "inline-flex h-9 items-center justify-center rounded-lg border border-line px-3.5 text-[13.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink";
const PRIMARY = "inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3.5 text-[13.5px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-60";
const INPUT = "h-9 rounded-lg border border-line bg-sheet px-3 text-[14px] text-ink outline-none focus:border-line-strong";
const LABEL = "flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft";

/** A mod wants to do something: deny, allow for this session, or always allow. */
export function ConfirmDialog({ req, onDecide }: { req: ConfirmRequest; onDecide: (d: "deny" | "once" | "always") => void }) {
  const t = useTranslations("dashboard.confirm");
  return (
    <Modal title={t("title", { name: req.modName })} onClose={() => onDecide("deny")}>
      <div className="flex gap-3 px-4 py-4">
        <ShieldQuestion size={20} aria-hidden className="mt-0.5 shrink-0 text-amber" />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{req.title}</p>
          {req.detail && req.detail !== "{}" && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-sheet-muted p-2 text-[11.5px] whitespace-pre-wrap text-ink-soft">{req.detail}</pre>}
          <p className="mt-2 text-[12px] text-ink-mute">{t("hint")}</p>
        </div>
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
        <button type="button" className={BTN} onClick={() => onDecide("deny")}>
          {t("deny")}
        </button>
        <button type="button" className={BTN} onClick={() => onDecide("always")}>
          {t("always")}
        </button>
        <button type="button" className={PRIMARY} onClick={() => onDecide("once")}>
          {t("allow")}
        </button>
      </footer>
    </Modal>
  );
}

export type BlockChoice = { kind: "component"; name: string } | { kind: "mod"; id: string };

export function BlockPicker({ mods, onPick, onClose }: { mods: ModView[]; onPick: (c: BlockChoice) => void; onClose: () => void }) {
  const t = useTranslations("dashboard");
  return (
    <Modal title={t("addBlock")} onClose={onClose} wide>
      <div className="min-h-0 overflow-y-auto p-2">
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {COMPONENT_NAMES.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => onPick({ kind: "component", name })} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-hover">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-sheet-muted text-ink-soft">
                  <Plus size={15} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink">{t(`types.${name.replace(".", "_")}`)}</span>
                  <span className="line-clamp-2 block text-[12px] leading-snug text-ink-mute">{t(`typeHints.${name.replace(".", "_")}`)}</span>
                </span>
              </button>
            </li>
          ))}
          {mods.map((m) => {
            const Icon = uiIcon(m.icon);
            return (
              <li key={`mod-${m.id}`}>
                <button type="button" onClick={() => onPick({ kind: "mod", id: m.id })} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-hover">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-sheet-muted text-[var(--dash-accent)]">
                    <Icon size={15} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-medium text-ink">
                      {m.name} <span className="text-[11px] font-normal text-ink-mute">· mod</span>
                    </span>
                    <span className="line-clamp-2 block text-[12px] leading-snug text-ink-mute">{m.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="px-3 pt-2 pb-1 text-[12px] text-ink-mute">{t("addBlockHint", { count: Object.keys(COMPONENTS).length })}</p>
      </div>
    </Modal>
  );
}

export type AppSettings = { name: string; icon: string; color: string; path: string; hidden: boolean };

export function AppDialog({
  initial,
  isApp,
  onSave,
  onRemove,
  onClose,
}: {
  initial: AppSettings;
  isApp: boolean;
  onSave: (s: AppSettings) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations("dashboard.app");
  const [s, setS] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  const colorOk = !s.color || isColor(s.color);
  return (
    <Modal title={isApp ? t("settings") : t("convert")} onClose={onClose}>
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (colorOk) void run(() => onSave(s));
        }}
      >
        <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-4 py-4">
          {!isApp && <p className="text-[13px] text-ink-mute">{t("explain")}</p>}
          <label className={LABEL}>
            {t("name")}
            <input className={INPUT} value={s.name} maxLength={24} onChange={(e) => setS({ ...s, name: e.target.value })} required />
          </label>
          <div className={LABEL}>
            {t("icon")}
            <div className="grid max-h-36 grid-cols-9 gap-1 overflow-y-auto rounded-lg border border-line p-1.5">
              {ICON_NAMES.map((n) => {
                const Icon = uiIcon(n);
                return (
                  <button
                    key={n}
                    type="button"
                    title={n}
                    aria-label={n}
                    aria-pressed={s.icon === n}
                    onClick={() => setS({ ...s, icon: n })}
                    className="grid h-8 place-items-center rounded-md text-ink-soft hover:bg-hover aria-pressed:bg-primary-soft aria-pressed:text-ink"
                  >
                    <Icon size={16} aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={LABEL}>
              {t("color")}
              <span className="flex items-center gap-2">
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#3b6cf6"} onChange={(e) => setS({ ...s, color: e.target.value })} className="h-9 w-10 rounded-lg border border-line bg-sheet" aria-label={t("color")} />
                <input className={`${INPUT} min-w-0 flex-1`} value={s.color} placeholder="#3b6cf6" onChange={(e) => setS({ ...s, color: e.target.value })} />
              </span>
            </label>
            <label className={LABEL}>
              {t("path")}
              <input className={INPUT} value={s.path} maxLength={32} pattern="[a-z0-9][a-z0-9-]{0,31}" onChange={(e) => setS({ ...s, path: e.target.value.toLowerCase() })} />
            </label>
          </div>
          {isApp && (
            <label className="flex items-center gap-2 text-[13.5px] text-ink">
              <input type="checkbox" checked={s.hidden} onChange={(e) => setS({ ...s, hidden: e.target.checked })} className="h-4 w-4 accent-[var(--color-ink)]" />
              {t("hidden")}
            </label>
          )}
          {!colorOk && <p className="text-[12.5px] text-danger">{t("badColor")}</p>}
          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-sheet-muted px-3 py-2 text-[13px] text-danger">{error}</p>}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          {isApp && (
            <button type="button" className={`${BTN} mr-auto`} disabled={busy} onClick={() => void run(onRemove)}>
              {t("remove")}
            </button>
          )}
          <button type="button" className={BTN} onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className={PRIMARY} disabled={busy || !s.name.trim() || !colorOk}>
            {isApp ? t("save") : t("convertButton")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function PublishDialog({
  kind,
  initial,
  onClose,
}: {
  kind: "page" | "mod";
  initial: { id: string; name: string; description: string };
  onClose: (published: boolean) => void;
}) {
  const t = useTranslations("dashboard.publish");
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/ui/gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish", kind, id: initial.id, name, description }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) return onClose(true);
    const b = (await res?.json().catch(() => ({}))) as { message?: string; error?: string } | undefined;
    setError(b?.message || b?.error || t("failed"));
  };
  return (
    <Modal title={kind === "page" ? t("titlePage") : t("titleMod")} onClose={() => onClose(false)}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-3.5 px-4 py-4">
          <p className="text-[13px] text-ink-mute">{t("explain")}</p>
          <label className={LABEL}>
            {t("name")}
            <input className={INPUT} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className={LABEL}>
            {t("description")}
            <textarea className="rounded-lg border border-line bg-sheet p-3 text-[13.5px] text-ink outline-none focus:border-line-strong" rows={4} maxLength={400} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-sheet-muted px-3 py-2 text-[13px] text-danger">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className={BTN} onClick={() => onClose(false)}>
            {t("cancel")}
          </button>
          <button type="submit" className={PRIMARY} disabled={busy || !name.trim()}>
            {t("publish")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
