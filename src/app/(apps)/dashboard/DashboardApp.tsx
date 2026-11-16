"use client";

// Dashboard: a per-user widget canvas plus a chat with the user's own Claude, who can change the
// dashboard through MCP tools (src/lib/mcp/dashboard-tools.ts). Changes from Claude, from another
// tab or from this one arrive over SSE (/api/dashboard/events). Desktop: canvas + collapsible chat
// panel. Phones: one column and a Widgets / Claude switch.
import { Check, LayoutDashboard, Loader2, MoreHorizontal, PanelRightOpen, Pencil, Plus, RotateCcw, RotateCw, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePopover } from "@/components/usePopover";
import { ChatPanel } from "./ChatPanel";
import { CustomWidget } from "./CustomWidget";
import { Grid, GRID_METRICS } from "./Grid";
import type { ChatState, Config, DashboardDoc, DashOp, TurnView, Widget, WidgetType } from "./model";
import { WidgetBody } from "./widgets";
import { starterConfig, TYPE_ICONS, WidgetConfigSheet, WidgetPicker } from "./WidgetSheet";

const CHAT_PREF = "zw-dashboard-chat";

type Sheet = { kind: "picker" } | { kind: "config"; id: string } | null;

async function postOps(body: { ops: DashOp[] } | { action: "undo" | "reset" }): Promise<{ doc?: DashboardDoc; undo?: number; added?: string[]; error?: string; message?: string }> {
  const res = await fetch("/api/dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { doc?: DashboardDoc; undo?: number; added?: string[]; error?: string; message?: string };
  if (!res.ok) return { error: data.message || data.error || `HTTP ${res.status}` };
  return data;
}

function WidgetMenu({ onAsk, onConfigure, onRefresh, onRemove }: { onAsk: () => void; onConfigure: () => void; onRefresh: () => void; onRemove: () => void }) {
  const t = useTranslations("dashboard.menu");
  const { open, toggle, setOpen, ref } = usePopover();
  const item = (icon: ReactNode, label: string, fn: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        fn();
      }}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${danger ? "text-danger" : "text-ink"}`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("label")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute top-8 right-0 z-30 w-60 p-1">
          {item(<Sparkles size={14} aria-hidden />, t("ask"), onAsk)}
          {item(<Pencil size={14} aria-hidden />, t("configure"), onConfigure)}
          {item(<RotateCw size={14} aria-hidden />, t("refresh"), onRefresh)}
          {item(<Trash2 size={14} aria-hidden />, t("remove"), onRemove, true)}
        </div>
      )}
    </div>
  );
}

export function DashboardApp({ initialDoc, initialChat, initialUndo }: { initialDoc: DashboardDoc; initialChat: ChatState; initialUndo: number }) {
  const t = useTranslations("dashboard");
  const [doc, setDoc] = useState(initialDoc);
  const [chat, setChat] = useState(initialChat);
  const [undo, setUndo] = useState(initialUndo);
  const [editing, setEditing] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<"widgets" | "claude">("widgets");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [refresh, setRefresh] = useState<Record<string, number>>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(0);
  const versionRef = useRef(initialDoc.version);

  const accept = useCallback((next: DashboardDoc) => {
    if (next.version < versionRef.current) return;
    versionRef.current = next.version;
    setDoc(next);
  }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem(CHAT_PREF) === "closed") setChatOpen(false);
    } catch {}
  }, []);
  const setChatPanel = (open: boolean) => {
    setChatOpen(open);
    try {
      localStorage.setItem(CHAT_PREF, open ? "open" : "closed");
    } catch {}
  };

  // Live updates: the document (from Claude, other tabs, this tab) and the chat state.
  useEffect(() => {
    const es = new EventSource("/api/dashboard/events");
    es.addEventListener("doc", (e) => {
      try {
        // A local edit in flight wins; its response carries the saved document.
        if (!pending.current) accept(JSON.parse((e as MessageEvent).data) as DashboardDoc);
      } catch {}
    });
    es.addEventListener("chat", (e) => {
      try {
        setChat(JSON.parse((e as MessageEvent).data) as ChatState);
      } catch {}
    });
    return () => es.close();
  }, [accept]);

  // The undo counter follows document changes made elsewhere.
  useEffect(() => {
    const id = setTimeout(() => {
      fetch("/api/dashboard", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { undo?: number } | null) => d && typeof d.undo === "number" && setUndo(d.undo))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(id);
  }, [doc.version]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const run = useCallback(
    async (body: { ops: DashOp[] } | { action: "undo" | "reset" }, optimistic?: DashboardDoc): Promise<string | null> => {
      const before = doc;
      if (optimistic) setDoc(optimistic);
      pending.current++;
      try {
        const r = await postOps(body);
        if (r.doc) {
          accept(r.doc);
          if (typeof r.undo === "number") setUndo(r.undo);
          return null;
        }
        if (optimistic) setDoc(before);
        return r.error ?? t("failed");
      } catch {
        if (optimistic) setDoc(before);
        return t("failed");
      } finally {
        pending.current--;
      }
    },
    [doc, accept, t],
  );

  const act = async (body: { ops: DashOp[] } | { action: "undo" | "reset" }, optimistic?: DashboardDoc) => {
    setBusy(true);
    const err = await run(body, optimistic);
    setBusy(false);
    if (err) setToast(err);
  };

  const commitLayout = (items: { id: string; x: number; y: number; w: number; h: number }[], message: string) => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const optimistic = { ...doc, widgets: doc.widgets.map((w) => (byId.has(w.id) ? { ...w, ...byId.get(w.id)! } : w)) };
    setAnnounce(message);
    void act({ ops: [{ op: "move", items }] }, optimistic);
  };

  const remove = (w: Widget) => void act({ ops: [{ op: "remove", id: w.id }] }, { ...doc, widgets: doc.widgets.filter((x) => x.id !== w.id) });

  const add = async (type: WidgetType) => {
    setSheet(null);
    setBusy(true);
    const err = await run({ ops: [{ op: "add", widget: { type, config: starterConfig(type, (k) => t(k)) } }] });
    setBusy(false);
    if (err) setToast(err);
    else setAnnounce(t("added", { type: t(`types.${type}`) }));
  };

  const ask = (w: Widget) => {
    const name = w.title || t(`types.${w.type}`);
    setDraft(t("askPrefill", { name, id: w.id }));
    setChatPanel(true);
    if (!window.matchMedia("(min-width: 768px)").matches) setMobileTab("claude");
    setTimeout(() => {
      const el = input.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 50);
  };

  const reset = () => {
    if (window.confirm(t("resetConfirm"))) void act({ action: "reset" });
  };

  const accent = doc.theme.accent;
  const density = doc.theme.density ?? "comfortable";
  const bg = doc.theme.background ?? "plain";
  const { gap } = GRID_METRICS[density];
  const vars = { "--dash-accent": accent ?? "var(--color-accent)" } as CSSProperties;
  const canvasBg: CSSProperties =
    bg === "muted"
      ? { background: "var(--color-sheet-muted)" }
      : bg === "grid"
        ? {
            backgroundColor: "var(--color-sheet)",
            backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }
        : { background: "var(--color-sheet)" };
  const editingWidget = sheet?.kind === "config" ? doc.widgets.find((w) => w.id === sheet.id) : undefined;

  const card = (w: Widget, opts: { dragHandle: (e: React.PointerEvent) => void; resizeHandle: ReactNode; desktop: boolean }) => {
    const Icon = TYPE_ICONS[w.type];
    const title = w.title || t(`types.${w.type}`);
    const draggable = editing && opts.desktop;
    return (
      <article
        className={`relative flex h-full flex-col overflow-hidden rounded-[var(--radius-sheet)] border bg-sheet ${editing ? "border-line-strong" : "border-line"}`}
        aria-label={title}
      >
        <header
          onPointerDown={opts.dragHandle}
          className={`flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3 ${draggable ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}
        >
          <Icon size={14} aria-hidden className="shrink-0 text-[var(--dash-accent)]" />
          <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{title}</h3>
          {editing && (
            <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("menu.remove")} title={t("menu.remove")} onClick={() => remove(w)}>
              <Trash2 size={14} aria-hidden />
            </button>
          )}
          <WidgetMenu
            onAsk={() => ask(w)}
            onConfigure={() => setSheet({ kind: "config", id: w.id })}
            onRefresh={() => setRefresh((r) => ({ ...r, [w.id]: (r[w.id] ?? 0) + 1 }))}
            onRemove={() => remove(w)}
          />
        </header>
        <div className={`min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 ${editing ? "pointer-events-none select-none" : ""}`}>
          <WidgetBody
            widget={w}
            refreshKey={refresh[w.id] ?? 0}
            onNotesSave={(text) => void act({ ops: [{ op: "update", id: w.id, config: { text } }] })}
            custom={(cw) => <CustomWidget key={`${cw.id}-${refresh[cw.id] ?? 0}`} html={String(cw.config.html ?? "")} title={title} />}
          />
        </div>
        {opts.resizeHandle}
      </article>
    );
  };

  const chatPanel = (
    <ChatPanel
      chat={chat}
      draft={draft}
      setDraft={setDraft}
      inputRef={input}
      onAdded={(turn: TurnView) => setChat((c) => (c.turns.some((x) => x.id === turn.id) ? c : { ...c, turns: [...c.turns, turn] }))}
      onCollapse={() => setChatPanel(false)}
    />
  );

  const btn = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-50";

  return (
    <div className="flex min-w-0 flex-1 gap-2" style={vars}>
      <main className={`sheet relative min-w-0 flex-1 flex-col overflow-hidden ${mobileTab === "claude" ? "hidden md:flex" : "flex"}`}>
        <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-3">
          <LayoutDashboard size={18} aria-hidden className="ml-1 shrink-0 text-[var(--dash-accent)]" />
          <h1 className="ml-1.5 min-w-0 truncate text-[17px] font-semibold tracking-tight text-ink">{t("title")}</h1>
          {busy && <Loader2 size={15} aria-hidden className="shrink-0 animate-spin text-ink-mute" />}
          <div className="ml-auto flex items-center gap-1.5">
            {editing ? (
              <>
                <button type="button" className={btn} onClick={() => setSheet({ kind: "picker" })}>
                  <Plus size={14} aria-hidden />
                  <span className="hidden sm:inline">{t("addWidget")}</span>
                </button>
                <button type="button" className={btn} onClick={reset} title={t("reset")}>
                  <RotateCcw size={14} aria-hidden />
                  <span className="hidden lg:inline">{t("reset")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover"
                >
                  <Check size={14} aria-hidden />
                  {t("done")}
                </button>
              </>
            ) : (
              <button type="button" className={btn} onClick={() => setEditing(true)}>
                <Pencil size={14} aria-hidden />
                <span className="hidden sm:inline">{t("edit")}</span>
              </button>
            )}
            <button type="button" className="icon-btn !h-8 !w-8" onClick={() => void act({ action: "undo" })} disabled={!undo || busy} aria-label={t("undo")} title={t("undo")}>
              <Undo2 size={16} aria-hidden />
            </button>
            <button type="button" className="icon-btn !h-8 !w-8 md:hidden" onClick={() => setMobileTab("claude")} aria-label={t("chat.title")}>
              <Sparkles size={16} aria-hidden />
            </button>
            {!chatOpen && (
              <button type="button" className="icon-btn !hidden !h-8 !w-8 md:!inline-grid" onClick={() => setChatPanel(true)} aria-label={t("chat.expand")} title={t("chat.expand")}>
                <PanelRightOpen size={16} aria-hidden />
              </button>
            )}
          </div>
        </header>
        {editing && <p className="border-b border-line bg-sheet-muted px-4 py-1.5 text-[12.5px] text-ink-mute">{t("editHint")}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ ...canvasBg, padding: gap + 4 }}>
          {doc.widgets.length ? (
            <Grid widgets={doc.widgets} editing={editing} density={density} onCommit={commitLayout} renderCard={card} />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center">
              <div className="max-w-sm">
                <p className="text-[15px] font-medium text-ink">{t("emptyTitle")}</p>
                <p className="mt-1.5 text-[13.5px] text-ink-mute">{t("emptyBody")}</p>
                <button type="button" className={`${btn} mx-auto mt-4`} onClick={() => setSheet({ kind: "picker" })}>
                  <Plus size={14} aria-hidden />
                  {t("addWidget")}
                </button>
              </div>
            </div>
          )}
        </div>
        {toast && (
          <div role="alert" className="pop absolute bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2 px-4 py-2.5 text-[13px] text-ink">
            {toast}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
      </main>

      {/* Desktop: side panel. Phones: full screen when the Claude tab is selected. */}
      {chatOpen && <aside className="sheet hidden w-[360px] shrink-0 overflow-hidden md:flex md:flex-col xl:w-[400px]">{chatPanel}</aside>}
      {mobileTab === "claude" && (
        <aside className="sheet flex min-w-0 flex-1 flex-col overflow-hidden md:hidden">
          <div className="flex h-11 shrink-0 items-center border-b border-line px-2">
            <button type="button" onClick={() => setMobileTab("widgets")} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
              <LayoutDashboard size={14} aria-hidden />
              {t("backToWidgets")}
            </button>
          </div>
          <ChatPanel
            chat={chat}
            draft={draft}
            setDraft={setDraft}
            inputRef={input}
            onAdded={(turn: TurnView) => setChat((c) => (c.turns.some((x) => x.id === turn.id) ? c : { ...c, turns: [...c.turns, turn] }))}
          />
        </aside>
      )}

      {sheet?.kind === "picker" && <WidgetPicker onPick={add} onClose={() => setSheet(null)} />}
      {editingWidget && (
        <WidgetConfigSheet
          widget={editingWidget}
          onClose={() => setSheet(null)}
          onSave={(title: string, config: Config) => run({ ops: [{ op: "update", id: editingWidget.id, title, config, replaceConfig: true }] })}
        />
      )}
    </div>
  );
}
