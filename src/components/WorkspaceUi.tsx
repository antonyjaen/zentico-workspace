"use client";

// Zentico UI outside the Dashboard: "Customize with Claude" from any app (a drawer with the
// Dashboard's own Claude chat, told which app the user is in, plus undo / theme presets / restore),
// the mod slots (a right-side panel in Mail, Chat, Calendar and Drive, and the top bar) running the
// same sandboxed ModFrame as the Dashboard, and the notices for broken customization and safe mode.
// The live connection (UI changes, chat state, live events) opens only while something needs it.
import { AlertTriangle, PanelRightClose, PanelRightOpen, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChatPanel } from "@/app/(apps)/dashboard/ChatPanel";
import { ConfirmDialog } from "@/app/(apps)/dashboard/dialogs";
import { ModFrame } from "@/app/(apps)/dashboard/ModFrame";
import { isFinalTurn, type ChatState, type TurnView } from "@/app/(apps)/dashboard/model";
import { StudioContext, type ConfirmRequest, type LiveEvent, type Selection, type StudioApi } from "@/app/(apps)/dashboard/studio-context";
import { CUSTOMIZE_KEY, formatErrors, shellFromUi, type PointerOp, type ShellSlot, type SlotName, type UiView } from "@/lib/ui/schema";
import { SAFE_PATH } from "@/lib/ui/workspace";
import { CUSTOMIZE_EVENT, openCustomize, UI_EVENT, useUiShell } from "./UiShell";

const PRESETS: { id: string; swatch: string; label: { en: string; es: string } }[] = [
  { id: "calm", swatch: "#0f7f74", label: { en: "Calm teal", es: "Turquesa" } },
  { id: "compact", swatch: "#3b6cf6", label: { en: "Compact pro", es: "Compacto" } },
  { id: "paper", swatch: "#a8481f", label: { en: "Warm paper", es: "Papel cálido" } },
];

/** The app a path belongs to (context for Claude, side slot). */
export function appOfPath(path: string): string {
  const seg = path.split("/")[1] ?? "";
  if (seg === "x") return `app:${path.split("/")[2] ?? ""}`;
  if (seg === "docs") return "drive";
  return seg || "mail";
}
const SIDE_SLOTS: Record<string, SlotName> = { mail: "mail.side", chat: "chat.side", calendar: "calendar.side", drive: "drive.side" };

async function postUi(body: unknown): Promise<{ ok: boolean; status: number; data?: UiView }> {
  try {
    const res = await fetch("/api/ui", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: res.ok ? ((await res.json()) as UiView) : undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}

type Ctx = { view: UiView | null; toast: (t: string) => void; restore: () => Promise<boolean> };
const WorkspaceContext = createContext<Ctx | null>(null);
export const useWorkspaceUi = () => useContext(WorkspaceContext);

export function WorkspaceUiProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("dashboard.workspace");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { shell, setShell } = useUiShell();
  const [open, setOpen] = useState(false);
  const [view, setViewState] = useState<UiView | null>(null);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [asks, setAsks] = useState<{ req: ConfirmRequest; resolve: (ok: boolean) => void }[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dark, setDark] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const allowed = useRef(new Set<string>());
  const live = useRef(new Set<(e: LiveEvent) => void>());
  const commands = useRef(new Set<(c: { mod: string; command: string }) => void>());
  const waiters = useRef(new Map<string, ((t: TurnView) => void)[]>());

  const onStudio = pathname.startsWith("/dashboard");
  const slots = shell.prefs.slots;
  const hasSlotHere = !!slots.topbar || !!slots[SIDE_SLOTS[appOfPath(pathname)]];
  // The Dashboard has its own connection and chat panel (only a top-bar slot needs ours there).
  const active = (open && !onStudio) || hasSlotHere;

  const setView = useCallback(
    (v: UiView) => {
      if (!v || typeof v !== "object" || !("sig" in v)) return;
      setViewState(v);
      // Theme, rail and slots follow the UI live (Claude's edits show up without a reload).
      setShell(shellFromUi(v.ui, v.errors, shellRef.current.safe));
    },
    [setShell],
  );

  useEffect(() => {
    if (!active) return;
    const es = new EventSource("/api/dashboard/events");
    const json = <T,>(e: Event) => {
      try {
        return JSON.parse((e as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };
    es.addEventListener("ui", (e) => {
      const v = json<UiView>(e);
      if (v) setView(v);
    });
    es.addEventListener("chat", (e) => {
      const c = json<ChatState>(e);
      if (c) setChat(c);
    });
    es.addEventListener("live", (e) => {
      const ev = json<LiveEvent>(e);
      if (ev) for (const fn of live.current) fn(ev);
    });
    es.addEventListener("reload", () => void fetch("/api/ui?force=1", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((v) => v && setView(v as UiView)).catch(() => undefined));
    return () => es.close();
  }, [active, setView]);

  useEffect(() => {
    for (const turn of chat?.turns ?? []) {
      if (!turn.commandId || !isFinalTurn(turn.status)) continue;
      const list = waiters.current.get(turn.commandId);
      if (!list) continue;
      waiters.current.delete(turn.commandId);
      for (const w of list) w(turn);
    }
  }, [chat]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const upd = () => setDark(document.documentElement.dataset.theme === "dark");
    upd();
    const obs = new MutationObserver(upd);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  const show = useCallback(
    (prefill: string) => {
      // On the Dashboard, its own Claude panel is the place.
      if (pathname.startsWith("/dashboard")) {
        window.dispatchEvent(new CustomEvent(UI_EVENT, { detail: { action: "claude" } }));
        return;
      }
      if (prefill) setDraft(prefill);
      setOpen(true);
      setTimeout(() => input.current?.focus(), 80);
    },
    [pathname],
  );

  // Global entry points: the settings menu, keys.json "claude", and the fixed Alt+Shift+K.
  useEffect(() => {
    const onOpen = (e: Event) => show(String((e as CustomEvent).detail ?? ""));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(false);
      const [mods, key] = [CUSTOMIZE_KEY.split("+").slice(0, -1), CUSTOMIZE_KEY.split("+").pop()];
      if (e.code === `Key${key?.toUpperCase()}` && e.altKey === mods.includes("alt") && e.shiftKey === mods.includes("shift") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (open) setOpen(false);
        else show("");
      }
    };
    const onAction = (e: Event) => {
      const d = (e as CustomEvent<{ action: string; mod?: string; command?: string }>).detail;
      if (d?.action === "mod" && d.mod && d.command) for (const fn of commands.current) fn({ mod: d.mod, command: d.command });
    };
    window.addEventListener(CUSTOMIZE_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    window.addEventListener(UI_EVENT, onAction);
    return () => {
      window.removeEventListener(CUSTOMIZE_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(UI_EVENT, onAction);
    };
  }, [show, open]);

  const restore = useCallback(async () => {
    const r = await postUi({ action: "restore" });
    if (!r.ok || !r.data) {
      setToast(t("restoreFailed"));
      router.push(SAFE_PATH);
      return false;
    }
    setView(r.data);
    setToast(t("restored"));
    router.refresh();
    return true;
  }, [router, setView, t]);

  const act = async (body: unknown, done: string) => {
    const r = await postUi(body);
    if (r.ok && r.data) {
      setView(r.data);
      setToast(done);
    } else setToast(r.status === 409 && (body as { action: string }).action === "undo" ? t("nothingToUndo") : t("failed"));
  };

  const confirm = useCallback((req: ConfirmRequest) => {
    const k = `${req.modId}:${req.key}`;
    if (allowed.current.has(k) || viewRef.current?.grants[req.modId]?.always.includes(req.key)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setAsks((a) => [...a, { req, resolve }]));
  }, []);

  const decide = async (d: "deny" | "once" | "always") => {
    const [first, ...rest] = asks;
    if (!first) return;
    setAsks(rest);
    if (d !== "deny") allowed.current.add(`${first.req.modId}:${first.req.key}`);
    if (d === "always") {
      const res = await fetch("/api/ui/mod", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modId: first.req.modId, op: "always", action: first.req.key }) }).catch(() => null);
      if (res?.ok) setView((await res.json()) as UiView);
    }
    first.resolve(d !== "deny");
  };

  // The runtime the slots' mods get (same contract as on the Dashboard).
  const api: StudioApi | null = useMemo(() => {
    if (!view) return null;
    const ui = view.ui;
    return {
      view,
      pageId: "workspace",
      editing: false,
      dark,
      gap: 12,
      userVars: { ...(ui?.theme.vars ?? {}), ...((dark ? ui?.theme.dark.vars : ui?.theme.light.vars) ?? {}) },
      chat: chat ?? { turns: [], confirmations: [], bridge: { connected: false, lastSeen: null }, hasWriteToken: false },
      grantOf: (modId) => viewRef.current?.grants[modId],
      setView,
      confirm,
      toast: (text) => setToast(text),
      openApp: (path) => router.push(path),
      navigate: (id) => {
        const p = viewRef.current?.ui?.pages.find((x) => x.id === id);
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
      awaitTurn: (commandId) =>
        new Promise<TurnView>((resolve) => {
          const list = waiters.current.get(commandId) ?? [];
          list.push(resolve);
          waiters.current.set(commandId, list);
        }),
      patch: async (ops: PointerOp[]) => {
        const r = await postUi({ action: "patch", baseSig: viewRef.current?.sig ?? null, ops });
        if (r.ok && r.data) {
          setView(r.data);
          return null;
        }
        return t("failed");
      },
      askClaude: (prefill) => show(prefill),
    };
  }, [view, dark, chat, selection, setView, confirm, router, show, t]);

  const app = appOfPath(pathname);
  const appName = app.startsWith("app:") ? (shell.apps.find((a) => `app:${a.id}` === app)?.name ?? app.slice(4)) : app;
  const ctx = useMemo(() => ({ view, toast: setToast, restore }), [view, restore]);
  const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink disabled:opacity-50";

  const content = (
    <>
      {children}
      {open && !onStudio && (
        <div className="fixed inset-0 z-[60] flex justify-end bg-black/20" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <aside
            role="dialog"
            aria-label={t("customize")}
            className="sheet m-0 flex h-full w-full max-w-[420px] flex-col overflow-hidden rounded-none sm:m-2 sm:h-[calc(100%-1rem)] sm:rounded-[var(--radius-sheet)]"
            style={{ "--dash-accent": "var(--color-accent)", boxShadow: "var(--shadow-pop)" } as CSSProperties}
          >
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
              <span className="mr-auto rounded-md bg-sheet-muted px-2 py-1 text-[12px] text-ink-soft">{t("inApp", { app: appName })}</span>
              <button type="button" className={btn} disabled={!view?.undo} onClick={() => void act({ action: "undo" }, t("undone"))} title={t("undo")}>
                <Undo2 size={13} aria-hidden />
                <span className="hidden sm:inline">{t("undo")}</span>
              </button>
              <button type="button" className={btn} onClick={() => window.confirm(t("restoreConfirm")) && void restore()} title={t("restore")}>
                <RotateCcw size={13} aria-hidden />
              </button>
              <button type="button" className="icon-btn !h-8 !w-8" onClick={() => setOpen(false)} aria-label={t("close")}>
                <X size={16} aria-hidden />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-2">
              <span className="shrink-0 text-[12px] text-ink-mute">{t("presets")}</span>
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={btn} onClick={() => void act({ action: "preset", id: p.id }, t("presetApplied"))}>
                  <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: p.swatch }} />
                  {locale === "en" ? p.label.en : p.label.es}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {chat ? (
                <ChatPanel
                  chat={chat}
                  draft={draft}
                  setDraft={setDraft}
                  inputRef={input}
                  where={{ app, path: pathname }}
                  examples={t.raw("examples") as string[]}
                  onAdded={(turn) => setChat((c) => (c && !c.turns.some((x) => x.id === turn.id) ? { ...c, turns: [...c.turns, turn] } : c))}
                />
              ) : (
                <div className="grid h-full place-items-center text-[13px] text-ink-mute">
                  <Sparkles size={16} aria-hidden className="animate-pulse" />
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
      {toast && (
        <div role="status" className="pop fixed bottom-5 left-1/2 z-[80] max-w-[90%] -translate-x-1/2 px-4 py-2.5 text-[13px] text-ink">
          {toast}
        </div>
      )}
      {asks[0] && <ConfirmDialog req={asks[0].req} onDecide={(d) => void decide(d)} />}
    </>
  );

  return (
    <WorkspaceContext.Provider value={ctx}>
      {api ? <StudioContext.Provider value={api}>{content}</StudioContext.Provider> : content}
    </WorkspaceContext.Provider>
  );
}

/** Problems in the shell / theme files, or safe mode: one line under the top bar. */
export function WorkspaceNotice() {
  const t = useTranslations("dashboard.workspace");
  const { shell } = useUiShell();
  const ws = useWorkspaceUi();
  if (shell.safe)
    return (
      <div role="status" className="zw-safe mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-sheet px-3 py-1.5 text-[12.5px] text-ink md:mx-0 md:mr-3">
        <AlertTriangle size={14} aria-hidden className="text-amber" />
        <span className="flex-1">{t("safeOn")}</span>
        <a href={SAFE_PATH} className="font-medium underline underline-offset-2">
          {t("leaveSafe")}
        </a>
      </div>
    );
  if (!shell.issues) return null;
  return (
    <div role="alert" className="zw-safe mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-sheet px-3 py-1.5 text-[12.5px] text-ink md:mx-0 md:mr-3">
      <AlertTriangle size={14} aria-hidden className="text-amber" />
      <span className="min-w-0 flex-1">{t("issues", { n: shell.issues })}</span>
      <button
        type="button"
        className="font-medium underline underline-offset-2"
        onClick={() => {
          const errs = ws?.view?.errors.filter((e) => e.file === "theme.json" || e.pointer.startsWith("/shell")) ?? [];
          openCustomize(`${t("fixPrompt")}${errs.length ? `\n${formatErrors(errs.slice(0, 20))}` : ""}`);
        }}
      >
        {t("fix")}
      </button>
      <button type="button" className="font-medium underline underline-offset-2" onClick={() => window.confirm(t("restoreConfirm")) && void ws?.restore()}>
        {t("restore")}
      </button>
    </div>
  );
}

function useSlotMod(slot: ShellSlot | undefined) {
  const ws = useWorkspaceUi();
  const mod = slot ? ws?.view?.ui?.mods[slot.mod] : undefined;
  return mod && ws?.view ? mod : null;
}

/** A mod in the right-side panel of Mail, Chat, Calendar or Drive (ui.json shell.slots["<app>.side"]). */
export function SideSlot() {
  const t = useTranslations("dashboard.workspace");
  const pathname = usePathname();
  const { shell } = useUiShell();
  const name = SIDE_SLOTS[appOfPath(pathname)];
  const slot = name ? shell.prefs.slots[name] : undefined;
  const mod = useSlotMod(slot);
  const key = `zw-slot-${name}`;
  const [open, setOpen] = useState<boolean | null>(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      setOpen(v ? v === "open" : null);
    } catch {}
  }, [key]);
  if (!slot || !mod) return null;
  const isOpen = open ?? slot.open;
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(key, v ? "open" : "closed");
    } catch {}
  };
  const title = slot.title ?? mod.name;
  const frame = <ModFrame mod={mod} instance={`slot-${name}`} config={slot.config} title={title} />;
  const header = (onClose: () => void, icon: ReactNode) => (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{title}</span>
      <button type="button" className="icon-btn !h-7 !w-7" onClick={onClose} aria-label={t("collapsePanel")}>
        {icon}
      </button>
    </div>
  );
  return (
    <>
      {isOpen ? (
        <aside aria-label={title} className="sheet ml-2 hidden shrink-0 flex-col overflow-hidden md:flex" style={{ width: slot.width }}>
          {header(() => set(false), <PanelRightClose size={15} aria-hidden />)}
          <div className="min-h-0 flex-1">{frame}</div>
        </aside>
      ) : (
        <button type="button" onClick={() => set(true)} className="icon-btn ml-1 !hidden self-start md:!inline-grid" aria-label={t("openPanel", { title })} title={title}>
          <PanelRightOpen size={17} aria-hidden />
        </button>
      )}
      <button
        type="button"
        onClick={() => setMobile(true)}
        className="pop fixed right-4 bottom-20 z-40 grid h-11 w-11 place-items-center !rounded-full text-ink md:hidden"
        aria-label={t("openPanel", { title })}
      >
        <PanelRightOpen size={18} aria-hidden />
      </button>
      {mobile && (
        <div className="fixed inset-0 z-[55] flex flex-col bg-sheet md:hidden">
          {header(() => setMobile(false), <X size={16} aria-hidden />)}
          <div className="min-h-0 flex-1">{frame}</div>
        </div>
      )}
    </>
  );
}

/** A small mod in the top bar (ui.json shell.slots.topbar), 36 px high. */
export function TopSlot() {
  const { shell } = useUiShell();
  const slot = shell.prefs.slots.topbar;
  const mod = useSlotMod(slot);
  if (!slot || !mod) return null;
  return (
    <div className="hidden h-9 shrink-0 overflow-hidden rounded-lg sm:block" style={{ width: slot.width }}>
      <ModFrame mod={mod} instance="slot-topbar" config={slot.config} title={slot.title ?? mod.name} />
    </div>
  );
}
