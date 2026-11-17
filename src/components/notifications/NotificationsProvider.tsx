"use client";

// Client side of the notification system, mounted once in the apps layout.
// - Every tab loads the center (GET /api/notifications) and keeps it in sync.
// - One tab per browser is the leader (Web Locks): it alone holds the SSE stream
//   (/api/notifications/stream), relays events to the other tabs over a BroadcastChannel,
//   schedules calendar reminders and decides how to surface each new notification:
//   nothing when some visible tab is already looking at that thing; otherwise an in-app toast
//   (high priority, in the focused tab) or a desktop notification (if the user opted in), plus an
//   optional chime. Do Not Disturb silences all three. Each id+count is surfaced once.
// - Unread count prefixes the tab title: "(3) Mail · Zentico Workspace". A hidden tab without
//   desktop notifications flashes "New message from X" for direct messages until it is seen.
// - Chat toasts show who wrote, a preview, the burst count and an inline quick reply.
// - Call events (call.ring / call.update) are re-dispatched in every tab as CALL_EVENT for the
//   CallsProvider; CALL_SYNC_EVENT tells it to reload calls after a (re)load of the center.
import { Reply, Send, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { sendMessage } from "@/app/(apps)/chat/actions";
import { avatarGradient, initials, isConversationId, OPEN_CONVERSATION_EVENT, UNREAD_EVENT } from "@/app/(apps)/chat/shared";
import { OPEN_TASK_EVENT, type OpenTaskDetail } from "@/app/(apps)/chat/tasks-shared";
import {
  DEFAULT_PREFS,
  LIST_LIMIT,
  type AppNotification,
  type NotificationPrefs,
  type NotificationsResponse,
  type NotifyEvent,
  type UpcomingEvent,
} from "@/lib/notifications/types";
import { CATEGORY_ICON, describe } from "./display";
import { playChime, unlockAudio } from "./sound";

const CHANNEL = "zw-notifications";
const LOCK = "zw-notifications-leader";
const PROBE_MS = 180;
const FRESH_MS = 2 * 60_000;
const UPCOMING_EVERY_MS = 10 * 60_000;
const TOAST_MS = 10_000;

/** localStorage flag: the "enable desktop notifications" prompt was answered (bell and Chat share it). */
export const DESKTOP_PROMPT_KEY = "zw_notify_prompt_dismissed";

/** Window event (detail: the NotifyEvent) for call.ring / call.update, in every tab. */
export const CALL_EVENT = "zw-call-event";
/** Window event: the notification center was (re)loaded; live calls may have changed meanwhile. */
export const CALL_SYNC_EVENT = "zw-call-sync";

type Claim = { visible: boolean; focused: boolean; inView: boolean; tab: string };
type Wire =
  | { t: "event"; ev: NotifyEvent }
  | { t: "sync"; data: NotificationsResponse }
  | { t: "probe"; n: AppNotification }
  | { t: "claim"; id: string; claim: Claim }
  | { t: "toast"; tab: string; n: AppNotification }
  | { t: "sound"; tab: string; kind: "message" | "meeting" };

type Permission = NotificationPermission | "unsupported";

type Ctx = {
  items: AppNotification[];
  unread: number;
  prefs: NotificationPrefs;
  loaded: boolean;
  permission: Permission;
  markRead: (ids: string[]) => void;
  markAllRead: () => void;
  dismiss: (ids: string[]) => void;
  clearAll: () => void;
  savePrefs: (patch: Partial<NotificationPrefs>) => Promise<boolean>;
  /** Asks the browser for permission (call from a click) and turns desktop notifications on. */
  enableDesktop: () => Promise<boolean>;
  openNotification: (n: AppNotification) => void;
};

const NotificationsContext = createContext<Ctx | null>(null);

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications outside NotificationsProvider");
  return ctx;
}

const currentPermission = (): Permission =>
  typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";

const dndActive = (p: NotificationPrefs) => p.dndUntil > Date.now();

/** Is this tab, right now, showing the thing the notification is about? */
function inView(n: AppNotification): boolean {
  const path = window.location.pathname;
  const conv = new URLSearchParams(window.location.search).get("c");
  switch (n.category) {
    case "chat":
      return path === "/chat" && !!n.ref && conv === n.ref;
    case "meet":
      return (path === "/chat" && !!n.ref && conv === n.ref) || path === n.href;
    case "mail":
      return path === "/mail" || path.startsWith("/mail/");
    case "calendar":
      return n.kind === "invite" && path.startsWith("/calendar");
    case "claude":
      return path === n.href;
  }
}

const soundFor = (n: AppNotification): "message" | "meeting" | null =>
  n.kind === "meeting" ? "meeting" : n.kind === "dm" || n.kind === "mention" ? "message" : null;

async function post(body: unknown): Promise<Response | null> {
  try {
    return await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

async function fetchCenter(): Promise<NotificationsResponse | null> {
  try {
    const res = await fetch("/api/notifications", { cache: "no-store" });
    return res.ok ? ((await res.json()) as NotificationsResponse) : null;
  } catch {
    return null;
  }
}

type State = { items: AppNotification[]; unread: number; prefs: NotificationPrefs; loaded: boolean };
type Action = { type: "center"; data: NotificationsResponse } | { type: "event"; ev: NotifyEvent } | { type: "prefs"; prefs: NotificationPrefs };

function reducer(state: State, action: Action): State {
  if (action.type === "center") return { items: action.data.items, unread: action.data.unread, prefs: action.data.prefs, loaded: true };
  if (action.type === "prefs") return { ...state, prefs: action.prefs };
  const ev = action.ev;
  switch (ev.type) {
    case "notification": {
      const n = ev.notification;
      const prev = state.items.find((x) => x.id === n.id);
      const items = [n, ...state.items.filter((x) => x.id !== n.id)].sort((a, b) => b.created - a.created).slice(0, LIST_LIMIT);
      return { ...state, items, unread: state.unread + (!prev || prev.read ? 1 : 0) };
    }
    case "read": {
      const ids = new Set(ev.ids);
      const hits = state.items.filter((x) => ids.has(x.id) && !x.read).length;
      if (!hits) return state;
      return { ...state, items: state.items.map((x) => (ids.has(x.id) ? { ...x, read: true } : x)), unread: Math.max(0, state.unread - hits) };
    }
    case "readAll":
      return { ...state, items: state.items.map((x) => (x.read ? x : { ...x, read: true })), unread: 0 };
    case "removed": {
      const ids = new Set(ev.ids);
      const gone = state.items.filter((x) => ids.has(x.id));
      if (!gone.length) return state;
      const unreadGone = gone.filter((x) => !x.read).length;
      return { ...state, items: state.items.filter((x) => !ids.has(x.id)), unread: Math.max(0, state.unread - unreadGone) };
    }
    case "cleared":
      return { ...state, items: [], unread: 0 };
    case "prefs":
      return { ...state, prefs: ev.prefs };
    case "call.ring":
    case "call.update":
      return state;
  }
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const router = useRouter();
  const [{ items, unread, prefs, loaded }, dispatch] = useReducer(reducer, { items: [], unread: 0, prefs: DEFAULT_PREFS, loaded: false });
  const [permission, setPermission] = useState<Permission>("unsupported");
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  /** Sender of the newest direct message that arrived while this tab was hidden. */
  const [flashFrom, setFlashFrom] = useState<string | null>(null);

  // Latest values for the long-lived handlers below.
  const live = useRef({ prefs, t, locale, router });
  live.current = { prefs, t, locale, router };
  const tabId = useMemo(() => Math.random().toString(36).slice(2), []);
  const bcRef = useRef<BroadcastChannel | null>(null);

  const showToast = useCallback((n: AppNotification) => {
    setToasts((list) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, 3));
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((list) => list.filter((x) => x.id !== id)), []);

  const applyCenter = useCallback((data: NotificationsResponse) => {
    dispatch({ type: "center", data });
    window.dispatchEvent(new CustomEvent(CALL_SYNC_EVENT));
  }, []);

  /** Applies a server event to this tab's state. */
  const applyEvent = useCallback((ev: NotifyEvent) => {
    if (ev.type === "call.ring" || ev.type === "call.update") {
      window.dispatchEvent(new CustomEvent(CALL_EVENT, { detail: ev }));
      return;
    }
    dispatch({ type: "event", ev });
    if (ev.type === "notification") {
      const n = ev.notification;
      const p = live.current.prefs;
      if (
        n.category === "chat" &&
        n.priority === "high" &&
        !n.read &&
        Date.now() - n.created < FRESH_MS &&
        document.visibilityState === "hidden" &&
        !(p.desktop && currentPermission() === "granted") &&
        !dndActive(p)
      ) {
        setFlashFrom(n.title.split(" · ")[0] || n.title);
      }
    }
    // Chat rail badge: refresh it right away.
    if (ev.type === "notification" && ev.notification.category === "chat") window.dispatchEvent(new CustomEvent(UNREAD_EVENT));
  }, []);

  const openNotification = useCallback(
    (n: AppNotification) => {
      if (!n.read) {
        applyEvent({ type: "read", ids: [n.id] });
        void post({ action: "read", ids: [n.id] });
      }
      dismissToast(n.id);
      // Chat already on screen: let it switch conversations itself (it keeps its own URL state).
      const [, conv, task] = n.href.match(/^\/chat\?c=([a-z0-9]{16})(?:&task=([a-z0-9]{16}))?$/) ?? [];
      if (conv && window.location.pathname === "/chat") {
        if (task) window.dispatchEvent(new CustomEvent<OpenTaskDetail>(OPEN_TASK_EVENT, { detail: { conversationId: conv, taskId: task } }));
        else window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: conv }));
        return;
      }
      live.current.router.push(n.href);
    },
    [applyEvent, dismissToast],
  );

  // Initial load, permission state, audio unlock on first gesture.
  useEffect(() => {
    setPermission(currentPermission());
    void fetchCenter().then((d) => d && applyCenter(d));
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [applyCenter]);

  // Leader election, live stream, cross-tab relay, reminders.
  useEffect(() => {
    const bc = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;
    bcRef.current = bc;
    const send = (m: Wire) => bc?.postMessage(m);
    const surfaced = new Set<string>();
    const probes = new Map<string, Claim[]>();
    let stopLeader: (() => void) | null = null;
    let release: (() => void) | null = null;
    let disposed = false;

    const myClaim = (n: AppNotification): Claim => ({
      tab: tabId,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      inView: document.visibilityState === "visible" && inView(n),
    });

    const desktop = (n: AppNotification) => {
      const { t: tr, locale: loc } = live.current;
      const d = describe(n, tr, loc);
      try {
        const note = new Notification(d.title, {
          body: [d.title === d.label ? "" : d.label, d.body].filter(Boolean).join(" · "),
          tag: n.id,
          lang: loc,
        });
        note.onclick = () => {
          window.focus();
          note.close();
          openNotification(n);
        };
      } catch {
        // e.g. mobile browsers that only allow notifications from a service worker
      }
    };

    /** Leader: decide how to surface a fresh notification, after asking the other tabs. */
    const decide = (n: AppNotification) => {
      const sig = `${n.id}:${n.count}`;
      if (n.read || surfaced.has(sig) || Date.now() - n.created > FRESH_MS) return;
      surfaced.add(sig);
      if (surfaced.size > 500) surfaced.clear();
      probes.set(n.id, []);
      send({ t: "probe", n });
      setTimeout(() => {
        const claims = [myClaim(n), ...(probes.get(n.id) ?? [])];
        probes.delete(n.id);
        const p = live.current.prefs;
        if (claims.some((c) => c.inView) || dndActive(p)) return;
        const focused = claims.find((c) => c.visible && c.focused);
        const visible = focused ?? claims.find((c) => c.visible);
        const deliver = (m: Wire & { tab: string }) => (m.tab === tabId ? onWire(m) : send(m));
        if (n.priority === "high" && visible && (focused || !p.desktop || currentPermission() !== "granted")) {
          deliver({ t: "toast", tab: visible.tab, n });
        } else if (p.desktop && currentPermission() === "granted") {
          desktop(n);
        }
        const sound = soundFor(n);
        if (p.sound && sound) deliver({ t: "sound", tab: (focused ?? visible)?.tab ?? tabId, kind: sound });
      }, PROBE_MS);
    };

    const onWire = (m: Wire) => {
      switch (m.t) {
        case "event":
          applyEvent(m.ev);
          break;
        case "sync":
          applyCenter(m.data);
          break;
        case "probe":
          send({ t: "claim", id: m.n.id, claim: myClaim(m.n) });
          break;
        case "claim":
          probes.get(m.id)?.push(m.claim);
          break;
        case "toast":
          if (m.tab === tabId) showToast(m.n);
          break;
        case "sound":
          if (m.tab === tabId) playChime(m.kind);
          break;
      }
    };
    if (bc) bc.onmessage = (e: MessageEvent<Wire>) => onWire(e.data);

    const startLeader = (): (() => void) => {
      let es: EventSource | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let stopped = false;
      const timers = new Map<string, ReturnType<typeof setTimeout>>();

      const resync = async () => {
        const data = await fetchCenter();
        if (!data || stopped) return;
        applyCenter(data);
        send({ t: "sync", data });
      };

      const connect = () => {
        if (stopped) return;
        es = new EventSource("/api/notifications/stream");
        es.onopen = () => {
          attempt = 0;
          void resync(); // catch up on anything missed while disconnected
        };
        es.onmessage = (msg: MessageEvent<string>) => {
          let ev: NotifyEvent;
          try {
            ev = JSON.parse(msg.data) as NotifyEvent;
          } catch {
            return;
          }
          applyEvent(ev);
          send({ t: "event", ev });
          if (ev.type === "notification") decide(ev.notification);
        };
        es.onerror = () => {
          // The browser retries dropped streams itself, but gives up on HTTP errors; retry those.
          if (es?.readyState === EventSource.CLOSED && !stopped) {
            attempt += 1;
            retry = setTimeout(connect, Math.min(60_000, 5000 * 2 ** Math.min(attempt, 4)));
          }
        };
      };

      const loadUpcoming = async () => {
        if (stopped || !live.current.prefs.calendar) return;
        let events: UpcomingEvent[] = [];
        try {
          const res = await fetch("/api/notifications/upcoming", { cache: "no-store" });
          if (!res.ok) return;
          events = ((await res.json()) as { events?: UpcomingEvent[] }).events ?? [];
        } catch {
          return;
        }
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        const now = Date.now();
        for (const e of events) {
          for (const minutes of new Set(e.alerts)) {
            const due = e.start - minutes * 60_000;
            if (due < now - 60_000 || due > now + 26 * 3_600_000) continue;
            const key = `${e.id}:${e.start}:${minutes}`;
            timers.set(
              key,
              setTimeout(() => {
                timers.delete(key);
                void post({ action: "reminder", eventId: e.id, title: e.title, start: e.start, minutes, date: e.date, meet: e.meet });
              }, Math.max(0, due - now)),
            );
          }
        }
      };

      connect();
      void loadUpcoming();
      const upcoming = setInterval(loadUpcoming, UPCOMING_EVERY_MS);
      return () => {
        stopped = true;
        clearTimeout(retry);
        clearInterval(upcoming);
        for (const timer of timers.values()) clearTimeout(timer);
        es?.close();
      };
    };

    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) {
      locks
        .request(
          LOCK,
          () =>
            new Promise<void>((resolve) => {
              if (disposed) return resolve();
              release = resolve;
              stopLeader = startLeader();
            }),
        )
        .catch(() => {});
    } else {
      stopLeader = startLeader();
    }

    return () => {
      disposed = true;
      stopLeader?.();
      release?.();
      bc?.close();
      bcRef.current = null;
    };
  }, [applyCenter, applyEvent, openNotification, showToast, tabId]);

  // Hidden tab: alternate the title with "New message from X" until the tab is seen again.
  useEffect(() => {
    if (!flashFrom) return;
    const text = t("titleFlash", { name: flashFrom });
    let base: string | null = null;
    let on = false;
    const strip = (s: string) => s.replace(/^\(\d+\+?\) /, "");
    const stop = () => {
      if (document.visibilityState === "visible") setFlashFrom(null);
    };
    const id = setInterval(() => {
      if (document.visibilityState === "visible") return stop();
      base ??= strip(document.title);
      on = !on;
      document.title = on ? text : base;
    }, 1200);
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("focus", stop);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("focus", stop);
      if (base !== null) document.title = base;
    };
  }, [flashFrom, t]);

  // "(3) Mail · Zentico Workspace": keep the prefix through Next's title updates.
  useEffect(() => {
    const strip = (s: string) => s.replace(/^\(\d+\+?\) /, "");
    const apply = () => {
      const base = strip(document.title);
      const next = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      document.title = strip(document.title);
    };
  }, [unread]);

  const markRead = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      applyEvent({ type: "read", ids });
      void post({ action: "read", ids });
    },
    [applyEvent],
  );

  const markAllRead = useCallback(() => {
    applyEvent({ type: "readAll" });
    void post({ action: "readAll" });
  }, [applyEvent]);

  const dismiss = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      applyEvent({ type: "removed", ids });
      void post({ action: "dismiss", ids });
    },
    [applyEvent],
  );

  const clearAll = useCallback(() => {
    applyEvent({ type: "cleared" });
    void post({ action: "clear" });
  }, [applyEvent]);

  const savePrefs = useCallback(async (patch: Partial<NotificationPrefs>) => {
    const previous = live.current.prefs;
    const next = { ...previous, ...patch };
    live.current.prefs = next;
    dispatch({ type: "prefs", prefs: next });
    const res = await post({ action: "prefs", prefs: next });
    if (!res?.ok) {
      dispatch({ type: "prefs", prefs: previous });
      return false;
    }
    const body = (await res.json().catch(() => null)) as { prefs?: NotificationPrefs } | null;
    if (body?.prefs) dispatch({ type: "prefs", prefs: body.prefs });
    return true;
  }, []);

  const enableDesktop = useCallback(async () => {
    if (!("Notification" in window)) return false;
    let result = Notification.permission;
    if (result === "default") {
      try {
        result = await Notification.requestPermission();
      } catch {
        result = Notification.permission;
      }
    }
    setPermission(result);
    if (result !== "granted") return false;
    return savePrefs({ desktop: true });
  }, [savePrefs]);

  const value = useMemo<Ctx>(
    () => ({ items, unread, prefs, loaded, permission, markRead, markAllRead, dismiss, clearAll, savePrefs, enableDesktop, openNotification }),
    [items, unread, prefs, loaded, permission, markRead, markAllRead, dismiss, clearAll, savePrefs, enableDesktop, openNotification],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <Toasts
        toasts={toasts}
        onOpen={openNotification}
        onDismiss={dismissToast}
        onReplied={(n) => {
          // Replying means it was read.
          markRead([n.id]);
          dismissToast(n.id);
        }}
        label={t("toastRegion")}
      />
    </NotificationsContext.Provider>
  );
}

function Toasts({
  toasts,
  onOpen,
  onDismiss,
  onReplied,
  label,
}: {
  toasts: AppNotification[];
  onOpen: (n: AppNotification) => void;
  onDismiss: (id: string) => void;
  onReplied: (n: AppNotification) => void;
  label: string;
}) {
  return (
    <section aria-label={label} aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((n) => (
        <Toast key={`${n.id}:${n.count}`} n={n} onOpen={onOpen} onDismiss={onDismiss} onReplied={onReplied} />
      ))}
    </section>
  );
}

function Toast({
  n,
  onOpen,
  onDismiss,
  onReplied,
}: {
  n: AppNotification;
  onOpen: (n: AppNotification) => void;
  onDismiss: (id: string) => void;
  onReplied: (n: AppNotification) => void;
}) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const [hover, setHover] = useState(false);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const d = describe(n, t, locale);
  const { icon: Icon, color } = CATEGORY_ICON[n.category];
  const joinable = n.href.startsWith("/meet/");
  const chat = n.category === "chat";
  const sender = chat ? n.title.split(" · ")[0] || n.title : "";
  const where = chat ? n.title.slice(sender.length + 3) : "";
  const canReply = chat && isConversationId(n.ref);
  const preview = d.body.length > 120 ? `${d.body.slice(0, 120)}…` : d.body;

  const reply = async () => {
    const body = text.trim();
    if (!body || sending || !n.ref) return;
    setSending(true);
    setFailed(false);
    const r = await sendMessage(n.ref, body, null).catch(() => null);
    setSending(false);
    if (!r?.ok) return setFailed(true);
    onReplied(n);
  };

  useEffect(() => {
    if (hover || replying) return;
    const id = setTimeout(() => onDismiss(n.id), n.kind === "confirm" ? TOAST_MS * 2 : TOAST_MS);
    return () => clearTimeout(id);
  }, [hover, replying, n.id, n.kind, onDismiss]);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pop pointer-events-auto flex items-start gap-3 p-3 text-[13px]"
    >
      {chat ? (
        <span
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white"
          style={{ background: avatarGradient(sender) }}
          aria-hidden
        >
          {initials(sender)}
        </span>
      ) : (
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-sheet-muted" style={{ color }} aria-hidden>
          <Icon size={15} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] text-ink-mute">
          {chat && where ? `${d.label} · ${where}` : d.label}
          {n.count > 1 && <span className="ml-1 font-medium text-ink-soft">· {t("count", { count: n.count })}</span>}
        </p>
        <p className="truncate font-medium text-ink">{chat ? sender : d.title}</p>
        {preview && <p className="mt-0.5 line-clamp-2 break-words text-ink-soft">{preview}</p>}
        {replying ? (
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void reply();
            }}
          >
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setReplying(false);
                }
              }}
              maxLength={2000}
              placeholder={t("replyPlaceholder")}
              aria-label={t("replyPlaceholder")}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-sheet px-2 text-[13px] text-ink outline-none focus:border-ink-mute"
            />
            <button
              type="submit"
              disabled={!text.trim() || sending}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-ink hover:bg-primary-hover disabled:opacity-50"
              aria-label={t("send")}
              title={t("send")}
            >
              <Send size={14} aria-hidden />
            </button>
          </form>
        ) : (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onOpen(n)}
              className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-ink hover:bg-primary-hover"
            >
              {joinable && n.kind === "meeting" ? t("join") : t("open")}
            </button>
            {canReply && (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink"
              >
                <Reply size={13} aria-hidden />
                {t("reply")}
              </button>
            )}
          </div>
        )}
        {failed && (
          <p role="alert" className="mt-1 text-[12px] text-danger">
            {t("replyFailed")}
          </p>
        )}
      </div>
      <button type="button" onClick={() => onDismiss(n.id)} className="icon-btn h-7 w-7" aria-label={t("dismiss")} title={t("dismiss")}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
