"use client";

// Gallery: the built-in recommended library (layouts, apps and mods, with an "Official" badge) and
// the pages and mods people in the workspace published. Installing copies into the user's own
// `Zentico UI/` folder (new pages never overwrite existing ones) after showing what the mods may do.
import { BadgeCheck, Download, Loader2, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { uiIcon } from "@/components/uiIcons";
import type { UiView } from "@/lib/ui/schema";

type Kind = "layout" | "app" | "mod" | "page";
type PNode = { type?: string; children?: PNode[]; sizes?: number[]; x?: number; y?: number; w?: number; h?: number; component?: string; mod?: string };
type Preview = PNode | null;
type Entry = {
  id: string;
  kind: Kind;
  icon: string | null;
  name: string;
  description: string;
  official?: boolean;
  permissions: string[];
  preview: Preview;
  app?: { name?: string; color?: string; sections?: unknown[] } | null;
  author?: { name: string; email: string };
  installs?: number;
  mine?: boolean;
};

/** Schematic thumbnail of a layout tree. */
export function LayoutPreview({ node, depth = 0 }: { node: Preview; depth?: number }) {
  if (!node || depth > 6) return <div className="h-full w-full rounded-[3px] bg-line" />;
  const kids = node.children ?? [];
  if (node.type === "row" || node.type === "column") {
    const sizes = node.sizes && node.sizes.length === kids.length ? node.sizes : kids.map(() => 1);
    return (
      <div className={`flex h-full w-full gap-[3px] ${node.type === "row" ? "flex-row" : "flex-col"}`}>
        {kids.map((c, i) => (
          <div key={i} className="min-h-0 min-w-0" style={{ flex: `${sizes[i]} 1 0%` }}>
            <LayoutPreview node={c} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (node.type === "tabs" || node.type === "stack") {
    return (
      <div className="flex h-full w-full flex-col gap-[3px]">
        <div className="h-[5px] w-1/2 rounded-[2px] bg-line-strong" />
        <div className="min-h-0 flex-1">
          <LayoutPreview node={kids[0] ?? null} depth={depth + 1} />
        </div>
      </div>
    );
  }
  if (node.type === "grid") {
    const rows = Math.max(1, ...kids.map((c) => (c.y ?? 0) + (c.h ?? 1)));
    return (
      <div className="relative h-full w-full">
        {kids.map((c, i) => (
          <div
            key={i}
            className="absolute p-[1.5px]"
            style={{ left: `${((c.x ?? 0) / 12) * 100}%`, top: `${((c.y ?? 0) / rows) * 100}%`, width: `${((c.w ?? 1) / 12) * 100}%`, height: `${((c.h ?? 1) / rows) * 100}%` }}
          >
            <LayoutPreview node={c} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  const mod = node.type === "mod";
  return (
    <div className={`flex h-full w-full flex-col gap-[3px] rounded-[3px] border p-[3px] ${mod ? "border-[var(--dash-accent)]/50 bg-[color-mix(in_oklab,var(--dash-accent)_12%,transparent)]" : "border-line bg-sheet"}`}>
      <div className="h-[3px] w-2/3 rounded-full bg-line-strong" />
      <div className="h-[3px] w-1/2 rounded-full bg-line" />
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useTranslations("dashboard");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="pop m-2 flex w-full max-w-[760px] flex-col overflow-hidden">
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

export function PermissionList({ perms }: { perms: string[] }) {
  const tp = useTranslations("dashboard.perms");
  const tm = useTranslations("dashboard.mods");
  if (!perms.length) return <p className="text-[12.5px] text-ink-mute">{tm("noPerms")}</p>;
  return (
    <ul className="flex flex-col gap-1 text-[12.5px] text-ink-soft">
      {perms.map((p) => (
        <li key={p}>• {p.startsWith("mcp:") ? tm("mcpScope", { scope: p.slice(4) }) : tp(p.replace(".", "_"))}</li>
      ))}
    </ul>
  );
}

export function Gallery({ onClose, onInstalled }: { onClose: () => void; onInstalled: (v: UiView & { pageId?: string | null }, kind: Kind) => void }) {
  const t = useTranslations("dashboard.gallery");
  const [tab, setTab] = useState<"recommended" | "workspace">("recommended");
  const [filter, setFilter] = useState<"all" | "layout" | "app" | "mod">("all");
  const [data, setData] = useState<{ recommended: Entry[]; items: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/ui/gallery", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { recommended: Entry[]; items: (Entry & { kind: "page" | "mod" })[] }) => setData({ recommended: d.recommended, items: d.items }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  const install = async (e: Entry) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(e.official ? "/api/ui" : "/api/ui/gallery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(e.official ? { action: "template", id: e.id, grant: true } : { action: "install", id: e.id, grant: true }),
      });
      const body = (await res.json().catch(() => ({}))) as UiView & { pageId?: string; message?: string; error?: string };
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      setConfirm(null);
      onInstalled(body, e.kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: Entry) => {
    if (!window.confirm(t("removeConfirm"))) return;
    await fetch("/api/ui/gallery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", id: e.id }) }).catch(() => null);
    void load();
  };

  const list = (tab === "recommended" ? data?.recommended : data?.items) ?? [];
  const shown = list.filter((e) => filter === "all" || e.kind === filter || (filter === "layout" && e.kind === "page"));
  const pill = "h-7 rounded-full px-3 text-[12.5px] font-medium transition-colors";

  return (
    <Sheet title={t("title")} onClose={onClose}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        {(["recommended", "workspace"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`${pill} ${tab === k ? "bg-primary text-primary-ink" : "text-ink-soft hover:bg-hover"}`}>
            {t(k)}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {(["all", "layout", "app", "mod"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={`${pill} ${filter === k ? "bg-primary-soft text-ink" : "text-ink-mute hover:bg-hover"}`}>
            {t(`kinds.${k}`)}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mx-4 mt-3 rounded-lg border border-danger/30 bg-sheet-muted px-3 py-2 text-[13px] text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!data ? (
          <div className="grid h-40 place-items-center">
            <Loader2 size={18} className="animate-spin text-ink-mute" aria-hidden />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-[13.5px] text-ink-mute">{tab === "workspace" ? t("emptyWorkspace") : t("empty")}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {shown.map((e) => {
              const Icon = uiIcon(e.icon);
              return (
                <li key={`${e.kind}-${e.id}`} className="flex flex-col overflow-hidden rounded-xl border border-line bg-sheet">
                  <div className="h-28 border-b border-line bg-sheet-muted p-3" aria-hidden>
                    {e.preview ? (
                      <LayoutPreview node={e.preview} />
                    ) : (
                      <div className="grid h-full place-items-center">
                        <Icon size={28} className="text-[var(--dash-accent)]" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-center gap-2">
                      <Icon size={15} aria-hidden className="shrink-0" style={{ color: e.app?.color ?? "var(--dash-accent)" }} />
                      <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{e.name}</h3>
                      {e.official && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-ink">
                          <BadgeCheck size={12} aria-hidden />
                          {t("official")}
                        </span>
                      )}
                      <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-mute">{t(`kinds.${e.kind === "page" ? "layout" : e.kind}`)}</span>
                    </div>
                    <p className="line-clamp-3 text-[12.5px] leading-snug text-ink-mute">{e.description}</p>
                    {e.author && (
                      <p className="text-[11.5px] text-ink-mute">
                        {t("by", { name: e.author.name })} · {t("installs", { n: e.installs ?? 0 })}
                      </p>
                    )}
                    <div className="mt-auto flex items-center justify-end gap-1.5 pt-1.5">
                      {e.mine && (
                        <button type="button" className="icon-btn !h-8 !w-8" aria-label={t("remove")} title={t("remove")} onClick={() => void remove(e)}>
                          <Trash2 size={14} aria-hidden />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setConfirm(e)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover"
                      >
                        <Download size={14} aria-hidden />
                        {e.kind === "mod" ? t("install") : t("use")}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {confirm && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onPointerDown={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div role="alertdialog" aria-modal="true" aria-label={confirm.name} className="pop w-full max-w-sm p-4">
            <h3 className="text-[15px] font-semibold text-ink">{t("confirmTitle", { name: confirm.name })}</h3>
            <p className="mt-1 text-[13px] text-ink-mute">{confirm.kind === "mod" ? t("confirmMod") : t("confirmPage")}</p>
            <div className="mt-3">
              <PermissionList perms={confirm.permissions} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-[13.5px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void install(confirm)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13.5px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-60"
              >
                {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
                {confirm.permissions.length ? t("allowInstall") : t("install")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
