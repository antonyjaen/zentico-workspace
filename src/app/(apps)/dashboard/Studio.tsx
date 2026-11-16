"use client";

// Zentico UI ("Studio"): the Dashboard and the user's rail apps, rendered from the files of their
// `Zentico UI/` Drive folder (ui.json, theme.json, keys.json, mods/). The server validates the
// files; this component renders the last valid UI, shows an error banner when the files are
// broken, follows changes live (SSE from Claude / other tabs, plus a light poll for edits made
// directly in Drive), writes the user's own layout edits back to ui.json, and runs mods (their
// confirmations, selection, events). Dashboard mode has page tabs, edit mode, gallery and the
// Claude side panel; app mode is full height with an optional sub-navigation.
import {
  AlertTriangle,
  Check,
  FolderOpen,
  LayoutDashboard,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
  Undo2,
  AppWindow,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { uiIcon } from "@/components/uiIcons";
import { usePopover } from "@/components/usePopover";
import { UI_EVENT, useUiShell, type UiActionEvent } from "@/components/UiShell";
import {
  COMPONENTS,
  findSpot,
  formatErrors,
  getAtPointer,
  shellApps,
  walk,
  type ModGrant,
  type PageTheme,
  type PointerOp,
  type UiNode,
  type UiPage,
  type UiTheme,
  type UiView,
} from "@/lib/ui/schema";
import { ChatPanel } from "./ChatPanel";
import { AppDialog, BlockPicker, ConfirmDialog, PublishDialog, type AppSettings, type BlockChoice } from "./dialogs";
import { Gallery } from "./Gallery";
import { NodeView, toRaw } from "./LayoutView";
import { isFinalTurn, type ChatState, type Config, type TurnView, type WidgetType } from "./model";
import { StudioContext, type ConfirmRequest, type LiveEvent, type Selection, type StudioApi } from "./studio-context";
import { WidgetConfigSheet } from "./WidgetSheet";

const CHAT_PREF = "zw-dashboard-chat";
const POLL_MS = 10_000;

/* ------------------------------------------------------------------- theme */

const GAPS = { compact: 8, comfortable: 12, spacious: 18 } as const;
const FONTS: Record<UiTheme["font"], string> = {
  system: "var(--font-sans)",
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
  mono: "var(--font-mono)",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
};

/** CSS for the studio root: base tokens plus light/dark overrides (values are validated server-side). */
function themeCss(theme: UiTheme, page: PageTheme, scope: string): { css: string; gap: number } {
  const density = page.density ?? theme.density;
  const background = page.background ?? theme.background;
  const gap = GAPS[density];
  const base: Record<string, string> = {
    "--dash-accent": page.accent ?? theme.accent ?? "var(--color-accent)",
    "--ui-radius": `${theme.radius ?? 12}px`,
    "--ui-gap": `${gap}px`,
    "--ui-card": "var(--color-sheet)",
    "--ui-canvas": background === "muted" ? "var(--color-sheet-muted)" : "var(--color-sheet)",
    "font-family": FONTS[theme.font],
    ...theme.vars,
  };
  const mode = (m: UiTheme["light"]) => ({
    ...(m.accent && !page.accent ? { "--dash-accent": m.accent } : {}),
    ...(m.canvas ? { "--ui-canvas": m.canvas } : {}),
    ...(m.card ? { "--ui-card": m.card } : {}),
    ...m.vars,
  });
  const decl = (o: Record<string, string>) =>
    Object.entries(o)
      .filter(([k, v]) => /^(--[a-z][a-z0-9-]*|font-family)$/.test(k) && !/[;{}<>]/.test(v))
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
  const sel = `[data-studio="${scope}"]`;
  const css = `${sel}{${decl(base)}}:root:not([data-theme="dark"]) ${sel}{${decl(mode(theme.light))}}[data-theme="dark"] ${sel}{${decl(mode(theme.dark))}}`;
  return { css, gap };
}

function canvasStyle(theme: UiTheme, page: PageTheme): CSSProperties {
  const bg = page.background ?? theme.background;
  if (bg === "grid")
    return {
      backgroundColor: "var(--ui-canvas)",
      backgroundImage: "linear-gradient(var(--color-line) 1px, transparent 1px), linear-gradient(90deg, var(--color-line) 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    };
  if (bg === "dots") return { backgroundColor: "var(--ui-canvas)", backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)", backgroundSize: "16px 16px" };
  return { background: "var(--ui-canvas)" };
}

/* ----------------------------------------------------------------- helpers */

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; errors?: unknown }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string; errors?: unknown };
    if (!res.ok) return { ok: false, status: res.status, message: data.message || data.error || `HTTP ${res.status}`, errors: data.errors };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, message: "network" };
  }
}

const uniquePageId = (pages: UiPage[], base: string) => {
  const taken = new Set(pages.map((p) => p.id));
  for (let i = 2; i < 200; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
};

function Menu({ label, icon, children }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode }) {
  const { open, toggle, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <button type="button" className="icon-btn !h-8 !w-8" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {icon}
      </button>
      {open && (
        <div role="menu" className="pop absolute top-9 right-0 z-40 w-64 p-1">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger = false, disabled = false }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover disabled:opacity-40 ${danger ? "text-danger" : "text-ink"}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ studio */

type Props = { initialView: UiView; initialChat: ChatState; mode: "dashboard" | "app"; pageId?: string | null; appId?: string; sectionId?: string | null };

type Dialog =
  | { kind: "gallery" }
  | { kind: "picker" }
  | { kind: "configure"; ptr: string }
  | { kind: "app"; pageId: string }
  | { kind: "publish"; type: "page" | "mod"; id: string; name: string; description: string }
  | null;

export function Studio({ initialView, initialChat, mode, pageId: requestedPage, appId, sectionId }: Props) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const { setShell } = useUiShell();
  const [view, setViewState] = useState(initialView);
  const [chat, setChat] = useState(initialChat);
  const [editing, setEditing] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [mobileClaude, setMobileClaude] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [asks, setAsks] = useState<{ req: ConfirmRequest; resolve: (ok: boolean) => void }[]>([]);
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const allowed = useRef(new Set<string>());
  const live = useRef(new Set<(e: LiveEvent) => void>());
  const commands = useRef(new Set<(c: { mod: string; command: string }) => void>());
  const turnWaiters = useRef(new Map<string, ((t: TurnView) => void)[]>());
  const scope = useMemo(() => Math.random().toString(36).slice(2, 10), []);

  const ui = view.ui;
  const page: UiPage | undefined = useMemo(() => {
    if (!ui) return undefined;
    if (mode === "app") return ui.pages.find((p) => p.app?.id === appId);
    return requestedPage ? ui.pages.find((p) => p.id === requestedPage) : ui.pages[0];
  }, [ui, mode, appId, requestedPage]);
  const section = mode === "app" && page?.app && sectionId ? page.app.sections.find((s) => s.id === sectionId) : undefined;
  const layout: UiNode | undefined = section?.layout ?? page?.layout;
  const pageIndex = ui && page ? ui.pages.indexOf(page) : -1;

  const setView = useCallback((v: UiView) => {
    if (v && typeof v === "object" && "sig" in v) setViewState(v);
  }, []);

  // The rail and the keyboard shortcuts follow the UI.
  useEffect(() => {
    if (!ui) return;
    setShell({ pages: ui.pages.map((p) => ({ id: p.id, title: p.title, icon: p.icon, pinned: p.pinned })), apps: shellApps(ui), keys: ui.keys });
  }, [ui, setShell]);

  useEffect(() => {
    try {
      if (localStorage.getItem(CHAT_PREF) === "closed") setChatOpen(false);
    } catch {}
    const upd = () => setDark(document.documentElement.dataset.theme === "dark");
    upd();
    const obs = new MutationObserver(upd);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(max-width: 767px)");
    const onMq = () => setNarrow(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);
  const setChatPanel = (open: boolean) => {
    setChatOpen(open);
    try {
      localStorage.setItem(CHAT_PREF, open ? "open" : "closed");
    } catch {}
  };

  const sync = useCallback(
    async (force = false) => {
      try {
        const res = await fetch(`/api/ui?${force ? "force" : "sync"}=1`, { cache: "no-store" });
        if (res.ok) setView((await res.json()) as UiView);
      } catch {}
    },
    [setView],
  );

  // Live: UI changes (Claude, other tabs), reload requests, chat state, mail/chat/calendar events.
  useEffect(() => {
    const es = new EventSource("/api/dashboard/events");
    es.addEventListener("ui", (e) => {
      try {
        setView(JSON.parse((e as MessageEvent).data) as UiView);
      } catch {}
    });
    es.addEventListener("reload", () => void sync(true));
    es.addEventListener("chat", (e) => {
      try {
        setChat(JSON.parse((e as MessageEvent).data) as ChatState);
      } catch {}
    });
    es.addEventListener("live", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as LiveEvent;
        for (const fn of live.current) fn(ev);
      } catch {}
    });
    return () => es.close();
  }, [setView, sync]);

  // Edits made directly in Drive (drive_* tools, the Drive app) are found by polling.
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && void sync(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void sync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sync]);

  // Claude turns that mods are waiting for.
  useEffect(() => {
    for (const turn of chat.turns) {
      if (!turn.commandId || !isFinalTurn(turn.status)) continue;
      const waiters = turnWaiters.current.get(turn.commandId);
      if (!waiters) continue;
      turnWaiters.current.delete(turn.commandId);
      for (const w of waiters) w(turn);
    }
  }, [chat]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const askClaude = useCallback(
    (prefill: string, send = false) => {
      if (send) {
        void postJson<{ turn: TurnView }>("/api/dashboard/chat", { text: prefill, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).then((r) => {
          if (!r.ok) setToast(r.status === 412 ? t("chat.needToken") : t("chat.sendFailed"));
        });
      } else setDraft(prefill);
      if (mode === "dashboard") {
        setChatPanel(true);
        if (window.matchMedia("(max-width: 767px)").matches) setMobileClaude(true);
        setTimeout(() => {
          const el = input.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }, 60);
      } else if (send) setToast(t("sentToClaude"));
    },
    [mode, t],
  );

  // keys.json actions and card menus.
  useEffect(() => {
    const onAction = (e: Event) => {
      const d = (e as CustomEvent<UiActionEvent>).detail;
      if (!d) return;
      if (d.action === "mod") for (const fn of commands.current) fn({ mod: d.mod, command: d.command });
      else if (d.action === "claude") askClaude("");
      else if (d.action === "edit") mode === "dashboard" && setEditing((v) => !v);
      else if (d.action === "gallery") setDialog({ kind: "gallery" });
    };
    const onConfigure = (e: Event) => setDialog({ kind: "configure", ptr: (e as CustomEvent<{ ptr: string }>).detail.ptr });
    const onPublish = (e: Event) => {
      const d = (e as CustomEvent<{ kind: "mod"; id: string; name: string; description: string }>).detail;
      setDialog({ kind: "publish", type: d.kind, id: d.id, name: d.name, description: d.description });
    };
    window.addEventListener(UI_EVENT, onAction);
    window.addEventListener("zw-ui-configure", onConfigure);
    window.addEventListener("zw-ui-publish", onPublish);
    try {
      const pending = sessionStorage.getItem("zw-ui-pending");
      if (pending) {
        sessionStorage.removeItem("zw-ui-pending");
        onAction(new CustomEvent(UI_EVENT, { detail: JSON.parse(pending) }));
      }
    } catch {}
    return () => {
      window.removeEventListener(UI_EVENT, onAction);
      window.removeEventListener("zw-ui-configure", onConfigure);
      window.removeEventListener("zw-ui-publish", onPublish);
    };
  }, [askClaude, mode]);

  const patch = useCallback(
    async (ops: PointerOp[]): Promise<string | null> => {
      setBusy(true);
      const r = await postJson<UiView>("/api/ui", { action: "patch", baseSig: viewRef.current.sig, ops });
      setBusy(false);
      if (r.ok) {
        setView(r.data);
        return null;
      }
      if (r.status === 409) void sync(true);
      return r.errors && Array.isArray(r.errors) && r.errors.length ? `${r.message}: ${formatErrors(r.errors as never).split("\n")[0]}` : r.message;
    },
    [setView, sync],
  );

  const confirm = useCallback((req: ConfirmRequest) => {
    const k = `${req.modId}:${req.key}`;
    const g = viewRef.current.grants[req.modId];
    if (allowed.current.has(k) || g?.always.includes(req.key)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setAsks((a) => [...a, { req, resolve }]));
  }, []);

  const decide = async (d: "deny" | "once" | "always") => {
    const [first, ...rest] = asks;
    if (!first) return;
    setAsks(rest);
    if (d !== "deny") allowed.current.add(`${first.req.modId}:${first.req.key}`);
    if (d === "always") {
      const r = await postJson<UiView>("/api/ui/mod", { modId: first.req.modId, op: "always", action: first.req.key });
      if (r.ok) setView(r.data);
    }
    first.resolve(d !== "deny");
  };

  const api: StudioApi | null = useMemo(() => {
    if (!page) return null;
    const userVars = { ...(ui?.theme.vars ?? {}), ...((dark ? ui?.theme.dark.vars : ui?.theme.light.vars) ?? {}) };
    return {
      view,
      pageId: page.id,
      editing,
      dark,
      gap: GAPS[page.theme.density ?? ui?.theme.density ?? "comfortable"],
      userVars,
      chat,
      grantOf: (modId: string): ModGrant | undefined => viewRef.current.grants[modId],
      setView,
      confirm,
      toast: (text: string) => setToast(text),
      openApp: (path: string) => router.push(path),
      navigate: (id: string) => {
        const p = viewRef.current.ui?.pages.find((x) => x.id === id);
        if (p) router.push(p.app ? `/x/${p.app.id}` : `/dashboard/${p.id}`);
      },
      selection,
      select: setSelection,
      subscribeLive: (fn) => {
        live.current.add(fn);
        return () => void live.current.delete(fn);
      },
      subscribeCommand: (fn) => {
        commands.current.add(fn);
        return () => void commands.current.delete(fn);
      },
      awaitTurn: (commandId: string) =>
        new Promise<TurnView>((resolve) => {
          const list = turnWaiters.current.get(commandId) ?? [];
          list.push(resolve);
          turnWaiters.current.set(commandId, list);
        }),
      patch,
      askClaude,
    };
  }, [view, page, editing, dark, chat, selection, ui, setView, confirm, router, patch, askClaude]);

  // Selection is per page.
  useEffect(() => setSelection(null), [page?.id, sectionId]);

  /* ----------------------------------------------------------- page edits */

  const act = async (body: unknown, after?: (v: UiView & { pageId?: string }) => void) => {
    setBusy(true);
    const r = await postJson<UiView & { pageId?: string }>("/api/ui", body);
    setBusy(false);
    if (!r.ok) {
      setToast(r.status === 409 && (body as { action: string }).action === "undo" ? t("nothingToUndo") : r.message);
      return;
    }
    setView(r.data);
    after?.(r.data);
  };

  const addPage = async () => {
    if (!ui) return;
    const id = uniquePageId(ui.pages, "page");
    const err = await patch([
      {
        op: "insert",
        pointer: "/pages/-",
        value: { id, title: t("newPageTitle"), icon: "layout-dashboard", layout: { type: "grid", children: [{ type: "component", component: "notes", props: { text: t("newPageNote") }, x: 0, y: 0, w: 4, h: 6 }] } },
      },
    ]);
    if (err) setToast(err);
    else {
      router.push(`/dashboard/${id}`);
      setEditing(true);
    }
  };

  const deletePage = async () => {
    if (!ui || !page || ui.pages.length < 2 || !window.confirm(t("deletePageConfirm", { title: page.title }))) return;
    const err = await patch([{ op: "remove", pointer: `/pages/${pageIndex}` }]);
    if (err) setToast(err);
    else router.push("/dashboard");
  };

  const addBlock = async (choice: BlockChoice) => {
    setDialog(null);
    if (!layout || !page) return;
    const base = section ? section.ptr : page.ptr;
    let node: Record<string, unknown>;
    let size = { w: 4, h: 6 };
    if (choice.kind === "component") {
      const spec = COMPONENTS[choice.name];
      size = { w: spec.size.w, h: spec.size.h };
      node = { type: "component", component: choice.name };
    } else {
      const m = ui?.mods[choice.id];
      size = { w: m?.size.w ?? 4, h: m?.size.h ?? 6 };
      node = { type: "mod", mod: choice.id, title: m?.name ?? choice.id };
    }
    const ops: PointerOp[] = [];
    if (layout.type === "grid") {
      const spot = findSpot(layout.children.map((c) => ({ x: c.x ?? 0, y: c.y ?? 0, w: c.w ?? 1, h: c.h ?? 1 })), size.w, size.h);
      ops.push({ op: "insert", pointer: `${layout.ptr}/children/-`, value: { ...node, ...spot, ...size } });
    } else if (layout.type === "row" || layout.type === "column") {
      ops.push({ op: "insert", pointer: `${layout.ptr}/children/-`, value: node });
      const avg = layout.sizes.reduce((a, b) => a + b, 0) / layout.sizes.length;
      ops.push({ op: "set", pointer: `${layout.ptr}/sizes`, value: [...layout.sizes.map((s) => Math.round(s * 100) / 100), Math.round(avg * 100) / 100] });
    } else if (layout.type === "tabs" || layout.type === "stack") {
      const title = choice.kind === "component" ? t(`types.${choice.name.replace(".", "_")}`) : (node.title as string);
      ops.push({ op: "insert", pointer: `${layout.ptr}/children/-`, value: { ...node, title } });
    } else {
      ops.push({ op: "set", pointer: `${base}/layout`, value: { type: "row", children: [toRaw(layout), node] } });
    }
    const err = await patch(ops);
    if (err) setToast(err);
    else setToast(t("blockAdded"));
  };

  const configNode = dialog?.kind === "configure" && layout ? findByPtr(layout, dialog.ptr) : null;

  if (!ui || !page || !layout || !api) {
    return (
      <main className="sheet grid min-w-0 flex-1 place-items-center p-8 text-center">
        <div className="max-w-sm">
          {view.errors.length ? (
            <>
              <AlertTriangle size={20} className="mx-auto text-amber" aria-hidden />
              <p className="mt-2 text-[15px] font-medium text-ink">{t("brokenTitle")}</p>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-sheet-muted p-2 text-left text-[11.5px] whitespace-pre-wrap text-ink-soft">{formatErrors(view.errors.slice(0, 8))}</pre>
              <button type="button" onClick={() => askClaude(`${t("fixPrompt")}\n${formatErrors(view.errors.slice(0, 20))}`, true)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-ink">
                <Sparkles size={14} aria-hidden />
                {t("askFix")}
              </button>
            </>
          ) : (
            <>
              <p className="text-[15px] font-medium text-ink">{mode === "app" ? t("appNotFound") : t("pageNotFound")}</p>
              <Link href="/dashboard" className="mt-3 inline-block text-[13px] font-medium text-[var(--color-accent)] hover:underline">
                {t("backToDashboard")}
              </Link>
            </>
          )}
        </div>
      </main>
    );
  }

  const { css } = themeCss(ui.theme, page.theme, scope);
  const btn = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-50";
  const folderHref = view.folderId ? `/drive?folder=${encodeURIComponent(view.folderId)}` : "/drive";

  const errorBanner = view.errors.length > 0 && (
    <div role="alert" className="border-b border-amber/40 bg-sheet-muted px-4 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle size={14} aria-hidden className="shrink-0 text-amber" />
        <span className="min-w-0 flex-1 text-ink">{t("errorsBanner", { n: view.errors.length })}</span>
        <button type="button" className="font-medium text-ink-soft underline-offset-2 hover:underline" onClick={() => setShowErrors((v) => !v)}>
          {showErrors ? t("hideErrors") : t("showErrors")}
        </button>
        <button
          type="button"
          onClick={() => askClaude(`${t("fixPrompt")}\n${formatErrors(view.errors.slice(0, 20))}`, true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-ink hover:bg-primary-hover"
        >
          <Sparkles size={13} aria-hidden />
          {t("askFix")}
        </button>
      </div>
      {showErrors && <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-sheet p-2 text-[11.5px] whitespace-pre-wrap text-ink-soft">{formatErrors(view.errors)}</pre>}
    </div>
  );

  const canvas = (
    <div className="min-h-0 flex-1 overflow-hidden" style={{ ...canvasStyle(ui.theme, page.theme), padding: GAPS[page.theme.density ?? ui.theme.density] }}>
      <div className={`h-full ${narrow ? "overflow-y-auto" : ""}`}>
        <NodeView node={layout} parent={null} narrow={narrow} />
      </div>
    </div>
  );

  const overlays = (
    <>
      {toast && (
        <div role="status" className="pop fixed bottom-5 left-1/2 z-[70] max-w-[90%] -translate-x-1/2 px-4 py-2.5 text-[13px] text-ink">
          {toast}
        </div>
      )}
      {asks[0] && <ConfirmDialog req={asks[0].req} onDecide={(d) => void decide(d)} />}
      {dialog?.kind === "gallery" && (
        <Gallery
          onClose={() => setDialog(null)}
          onInstalled={(v, kind) => {
            setView(v);
            setDialog(null);
            const p = v.pageId ? v.ui?.pages.find((x) => x.id === v.pageId) : null;
            if (p) router.push(p.app ? `/x/${p.app.id}` : `/dashboard/${p.id}`);
            else setToast(kind === "mod" ? t("modInstalled") : t("installed"));
          }}
        />
      )}
      {dialog?.kind === "picker" && <BlockPicker mods={Object.values(ui.mods)} onPick={(c) => void addBlock(c)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "configure" && configNode?.type === "component" && COMPONENTS[configNode.component]?.widget && (
        <WidgetConfigSheet
          widget={{ id: configNode.key, type: configNode.component as WidgetType, title: configNode.title ?? "", x: 0, y: 0, w: 4, h: 4, config: configNode.props }}
          onClose={() => setDialog(null)}
          onSave={async (title: string, config: Config) => {
            const raw = { ...toRaw(configNode), props: { ...config, ...(configNode.props.openIn ? { openIn: configNode.props.openIn } : {}) } } as Record<string, unknown>;
            if (title) raw.title = title;
            else delete raw.title;
            return patch([{ op: "set", pointer: configNode.ptr, value: raw }]);
          }}
        />
      )}
      {dialog?.kind === "app" &&
        (() => {
          const p = ui.pages.find((x) => x.id === dialog.pageId);
          if (!p) return null;
          const i = ui.pages.indexOf(p);
          const initial: AppSettings = { name: p.app?.name ?? p.title.slice(0, 24), icon: p.app?.icon ?? p.icon, color: p.app?.color ?? "", path: p.app?.id ?? p.id, hidden: p.app?.hidden ?? false };
          return (
            <AppDialog
              initial={initial}
              isApp={!!p.app}
              onClose={() => setDialog(null)}
              onRemove={async () => {
                const err = await patch([{ op: "remove", pointer: `/pages/${i}/app` }]);
                if (!err) router.push(`/dashboard/${p.id}`);
                return err;
              }}
              onSave={async (s) => {
                const current = (getAtPointer({ pages: ui.pages.map((x) => ({ app: x.app ? { sections: x.app.sections.map((sec) => ({ id: sec.id, title: sec.title, icon: sec.icon, layout: toRaw(sec.layout) })), order: x.app.order } : undefined })) }, `/pages/${i}/app`) ?? {}) as Record<string, unknown>;
                const value: Record<string, unknown> = { ...current, name: s.name.trim(), icon: s.icon };
                if (s.color.trim()) value.color = s.color.trim();
                else delete value.color;
                if (s.path && s.path !== p.id) value.path = s.path;
                else delete value.path;
                if (s.hidden) value.hidden = true;
                else delete value.hidden;
                if (Array.isArray(value.sections) && !(value.sections as unknown[]).length) delete value.sections;
                const err = await patch([{ op: "set", pointer: `/pages/${i}/app`, value }]);
                if (!err && !p.app) router.push(`/x/${s.path || p.id}`);
                return err;
              }}
            />
          );
        })()}
      {dialog?.kind === "publish" && (
        <PublishDialog
          kind={dialog.type}
          initial={{ id: dialog.id, name: dialog.name, description: dialog.description }}
          onClose={(done) => {
            setDialog(null);
            if (done) setToast(t("published"));
          }}
        />
      )}
    </>
  );

  /* ---------------------------------------------------------------- app mode */

  if (mode === "app" && page.app) {
    const app = page.app;
    const entries = [{ id: null as string | null, title: page.title, icon: page.icon }, ...app.sections.map((s) => ({ id: s.id as string | null, title: s.title, icon: s.icon }))];
    return (
      <StudioContext.Provider value={api}>
        <style>{css}</style>
        <div data-studio={scope} className="flex min-w-0 flex-1 gap-2" style={app.color ? ({ "--dash-accent": app.color } as CSSProperties) : undefined}>
          {app.sections.length > 0 && (
            <nav aria-label={app.name} className="hidden w-[200px] shrink-0 flex-col gap-0.5 py-2 md:flex">
              <div className="flex items-center gap-2 px-3 pb-3">
                {(() => {
                  const Icon = uiIcon(app.icon);
                  return <Icon size={18} aria-hidden className="text-[var(--dash-accent)]" />;
                })()}
                <span className="truncate text-[15px] font-semibold text-ink">{app.name}</span>
              </div>
              {entries.map((e) => {
                const Icon = uiIcon(e.icon);
                const href = e.id ? `/x/${app.id}/${e.id}` : `/x/${app.id}`;
                const active = (section?.id ?? null) === e.id;
                return (
                  <Link
                    key={e.id ?? "_"}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:font-medium aria-[current=page]:text-ink"
                  >
                    <Icon size={16} aria-hidden />
                    <span className="truncate">{e.title}</span>
                  </Link>
                );
              })}
            </nav>
          )}
          <main className="sheet relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {app.sections.length > 0 && (
              <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 md:hidden">
                {entries.map((e) => (
                  <Link
                    key={e.id ?? "_"}
                    href={e.id ? `/x/${app.id}/${e.id}` : `/x/${app.id}`}
                    aria-current={(section?.id ?? null) === e.id ? "page" : undefined}
                    className="h-8 shrink-0 rounded-lg px-3 text-[13px] leading-8 text-ink-soft aria-[current=page]:bg-primary-soft aria-[current=page]:text-ink"
                  >
                    {e.title}
                  </Link>
                ))}
              </div>
            )}
            {errorBanner}
            {canvas}
            {busy && <Loader2 size={15} aria-hidden className="absolute top-3 right-3 animate-spin text-ink-mute" />}
          </main>
        </div>
        {overlays}
      </StudioContext.Provider>
    );
  }

  /* ---------------------------------------------------------- dashboard mode */

  const chatPanel = (collapse?: () => void) => (
    <ChatPanel
      chat={chat}
      draft={draft}
      setDraft={setDraft}
      inputRef={input}
      onAdded={(turn: TurnView) => setChat((c) => (c.turns.some((x) => x.id === turn.id) ? c : { ...c, turns: [...c.turns, turn] }))}
      onCollapse={collapse}
    />
  );
  const dashPages = ui.pages;

  return (
    <StudioContext.Provider value={api}>
      <style>{css}</style>
      <div data-studio={scope} className="flex min-w-0 flex-1 gap-2">
        <main className={`sheet relative min-w-0 flex-1 flex-col overflow-hidden ${mobileClaude ? "hidden md:flex" : "flex"}`}>
          <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-3">
            <LayoutDashboard size={18} aria-hidden className="ml-1 shrink-0 text-[var(--dash-accent)]" />
            <nav aria-label={t("pages")} className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
              {dashPages.map((p, i) => {
                const Icon = uiIcon(p.icon);
                const href = i === 0 ? "/dashboard" : `/dashboard/${p.id}`;
                return (
                  <Link
                    key={p.id}
                    href={href}
                    aria-current={p.id === page.id ? "page" : undefined}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13.5px] font-medium text-ink-mute transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:text-ink"
                  >
                    <Icon size={14} aria-hidden />
                    <span className="max-w-[160px] truncate">{p.title}</span>
                    {p.app && <AppWindow size={12} aria-label={t("isApp")} className="text-ink-mute" />}
                  </Link>
                );
              })}
              <button type="button" className="icon-btn !h-8 !w-8 shrink-0" onClick={() => void addPage()} aria-label={t("newPage")} title={t("newPage")}>
                <Plus size={15} aria-hidden />
              </button>
            </nav>
            {busy && <Loader2 size={15} aria-hidden className="shrink-0 animate-spin text-ink-mute" />}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {editing ? (
                <>
                  <button type="button" className={btn} onClick={() => setDialog({ kind: "picker" })}>
                    <Plus size={14} aria-hidden />
                    <span className="hidden sm:inline">{t("addBlock")}</span>
                  </button>
                  <button type="button" onClick={() => setEditing(false)} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover">
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
              <button type="button" className={btn} onClick={() => setDialog({ kind: "gallery" })}>
                <LayoutGrid size={14} aria-hidden />
                <span className="hidden lg:inline">{t("gallery.title")}</span>
              </button>
              <button type="button" className="icon-btn !h-8 !w-8" onClick={() => void act({ action: "undo" })} disabled={!view.undo || busy} aria-label={t("undo")} title={t("undo")}>
                <Undo2 size={16} aria-hidden />
              </button>
              <Menu label={t("pageMenu")} icon={<MoreHorizontal size={16} aria-hidden />}>
                {(close) => (
                  <>
                    <MenuItem
                      icon={page.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
                      label={page.pinned ? t("unpin") : t("pin")}
                      onClick={() => {
                        close();
                        void patch([{ op: "set", pointer: `/pages/${pageIndex}/pinned`, value: !page.pinned }]).then((e) => e && setToast(e));
                      }}
                    />
                    <MenuItem
                      icon={<AppWindow size={14} aria-hidden />}
                      label={page.app ? t("appSettings") : t("convertToApp")}
                      onClick={() => {
                        close();
                        setDialog({ kind: "app", pageId: page.id });
                      }}
                    />
                    <MenuItem
                      icon={<Share2 size={14} aria-hidden />}
                      label={t("publishPage")}
                      onClick={() => {
                        close();
                        setDialog({ kind: "publish", type: "page", id: page.id, name: page.title, description: "" });
                      }}
                    />
                    <MenuItem
                      icon={<Sparkles size={14} aria-hidden />}
                      label={t("askPage")}
                      onClick={() => {
                        close();
                        askClaude(t("askPagePrefill", { title: page.title, id: page.id }));
                      }}
                    />
                    <MenuItem
                      icon={<FolderOpen size={14} aria-hidden />}
                      label={t("openFiles")}
                      onClick={() => {
                        close();
                        router.push(folderHref);
                      }}
                    />
                    <MenuItem
                      icon={<RotateCcw size={14} aria-hidden />}
                      label={t("reset")}
                      onClick={() => {
                        close();
                        if (window.confirm(t("resetConfirm"))) void act({ action: "reset" });
                      }}
                    />
                    <MenuItem
                      icon={<Trash2 size={14} aria-hidden />}
                      label={t("deletePage")}
                      danger
                      disabled={dashPages.length < 2}
                      onClick={() => {
                        close();
                        void deletePage();
                      }}
                    />
                  </>
                )}
              </Menu>
              <button type="button" className="icon-btn !h-8 !w-8 md:hidden" onClick={() => setMobileClaude(true)} aria-label={t("chat.title")}>
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
          {errorBanner}
          {canvas}
        </main>

        {chatOpen && <aside className="sheet hidden w-[360px] shrink-0 overflow-hidden md:flex md:flex-col xl:w-[400px]">{chatPanel(() => setChatPanel(false))}</aside>}
        {mobileClaude && (
          <aside className="sheet flex min-w-0 flex-1 flex-col overflow-hidden md:hidden">
            <div className="flex h-11 shrink-0 items-center border-b border-line px-2">
              <button type="button" onClick={() => setMobileClaude(false)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ink-soft hover:bg-hover hover:text-ink">
                <LayoutDashboard size={14} aria-hidden />
                {t("backToWidgets")}
              </button>
            </div>
            {chatPanel()}
          </aside>
        )}
      </div>
      {overlays}
    </StudioContext.Provider>
  );
}

function findByPtr(root: UiNode, ptr: string): UiNode | null {
  let hit: UiNode | null = null;
  walk(root, (n) => {
    if (n.ptr === ptr) hit = n;
  });
  return hit;
}
