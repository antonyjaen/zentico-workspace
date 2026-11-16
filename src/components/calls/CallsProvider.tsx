"use client";

// Ringing calls on the client, mounted once in the apps layout (inside MeetingProvider) so a call
// can ring, be answered and be placed from any page.
// - State comes from GET /api/calls and the call.ring / call.update events of the notifications
//   stream (re-dispatched in every tab by NotificationsProvider as CALL_EVENT).
// - Incoming: a modal (Accept / Accept without video / Decline, quick replies; Esc minimizes to a
//   ringing chip, never declines), or a compact banner while already in another call. Every tab
//   shows it; one tab per browser plays the ringtone and, when hidden, raises the desktop
//   notification (Web Lock, focused tab first). Answering anywhere (tab: BroadcastChannel;
//   device: server state) stops the ringing everywhere.
// - Outgoing: the caller joins the room at once (in-app via MeetingProvider) and sees
//   "Calling …" with a ringback tone until someone answers; cancel, timeout or everyone declining
//   ends it and the caller is hung up if still alone.
// - Leaving the room tells the server (end / cancel), so calls end and cards show the duration.
import { ChevronDown, MessageSquare, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { avatarGradient, initials, isCallActive, type CallMedia, type CallView } from "@/app/(apps)/chat/shared";
import { useMeeting } from "@/app/(apps)/meet/MeetingProvider";
import { meetHref } from "@/app/(apps)/meet/shared";
import type { NotifyEvent } from "@/lib/notifications/types";
import { CALL_EVENT, CALL_SYNC_EVENT, useNotifications } from "../notifications/NotificationsProvider";
import { startRingback, startRingtone, unlockAudio } from "../notifications/sound";

const CHANNEL = "zw-calls";
const RING_LOCK = "zw-call-ring";
/** Ended calls stay this long (outcome shown to the caller, auto hang-up). */
const KEEP_ENDED_MS = 6000;

type JoinInfo = { call: CallView | null; conversationId: string; room: string; media: CallMedia; videoRecording: boolean };
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type CallTarget = { conversationId: string } | { with: { email: string; name: string } };
export type StartOutcome = { ok: true; conversationId: string } | { ok: false; error: string };

type Ctx = {
  /** Calls I'm in that are still live. */
  calls: CallView[];
  /** Calls (or joins the live call of) a conversation, or a person (their DM). */
  startCall: (target: CallTarget, media: CallMedia, opts?: { ringAll?: boolean }) => Promise<StartOutcome>;
  starting: boolean;
};

const CallsContext = createContext<Ctx | null>(null);

export function useCalls(): Ctx {
  const ctx = useContext(CallsContext);
  if (!ctx) throw new Error("useCalls outside CallsProvider");
  return ctx;
}

async function api<T = null>(action: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/calls/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (res.status === 204) return { ok: true, data: null as T };
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !data) return { ok: false, error: data?.error ?? "failed" };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "failed" };
  }
}

const lower = (s: string) => s.trim().toLowerCase();

function CallAvatar({ name, email, size }: { name: string; email: string; size: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white select-none"
      style={{ width: size, height: size, background: avatarGradient(email || name), fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {initials(name || email)}
    </span>
  );
}

export function CallsProvider({ email, children }: { email: string; children: React.ReactNode }) {
  const t = useTranslations("calls");
  const router = useRouter();
  const meeting = useMeeting();
  const { prefs, permission } = useNotifications();
  const me = lower(email);

  const [calls, setCalls] = useState<Record<string, CallView>>({});
  const [handled, setHandled] = useState<Record<string, true>>({});
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});
  const [local, setLocal] = useState<Record<string, true>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState(0);

  const callsRef = useRef(calls);
  callsRef.current = calls;
  const localRef = useRef(local);
  localRef.current = local;
  const live = useRef({ meeting, router });
  live.current = { meeting, router };
  const bcRef = useRef<BroadcastChannel | null>(null);
  const startingRef = useRef(false);
  /** Remote participants per room, as last seen while connected (survives the disconnect). */
  const remotesByRoom = useRef<Record<string, number>>({});
  const hadRemote = useRef<Record<string, boolean>>({});
  const dropTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const upsert = useCallback((c: CallView) => {
    setCalls((prev) => ({ ...prev, [c.id]: c }));
    const timers = dropTimers.current;
    clearTimeout(timers.get(c.id));
    if (!isCallActive(c)) {
      timers.set(
        c.id,
        setTimeout(() => {
          timers.delete(c.id);
          setCalls(({ [c.id]: _, ...rest }) => rest);
        }, KEEP_ENDED_MS),
      );
    }
  }, []);

  const sync = useCallback(async () => {
    try {
      const res = await fetch("/api/calls", { cache: "no-store" });
      if (!res.ok) return;
      const { calls: list } = (await res.json()) as { calls: CallView[] };
      setCalls((prev) => {
        const next: Record<string, CallView> = {};
        // Keep recently ended ones (outcome on screen); live ones come from the server.
        for (const c of Object.values(prev)) if (!isCallActive(c)) next[c.id] = c;
        for (const c of list) next[c.id] = c;
        return next;
      });
    } catch {}
  }, []);

  const markHandled = useCallback((id: string) => {
    setHandled((h) => ({ ...h, [id]: true }));
    bcRef.current?.postMessage({ t: "handled", id });
  }, []);

  // Live updates, initial load, cross-tab "handled".
  useEffect(() => {
    const onEvent = (e: Event) => {
      const ev = (e as CustomEvent<NotifyEvent>).detail;
      if (ev.type === "call.ring" || ev.type === "call.update") upsert(ev.call);
    };
    const onSync = () => void sync();
    const onVisible = () => document.visibilityState === "visible" && void sync();
    window.addEventListener(CALL_EVENT, onEvent);
    window.addEventListener(CALL_SYNC_EVENT, onSync);
    document.addEventListener("visibilitychange", onVisible);
    const bc = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;
    bcRef.current = bc;
    if (bc) {
      bc.onmessage = (e: MessageEvent<{ t: string; id: string }>) => {
        if (e.data?.t === "handled" && typeof e.data.id === "string") setHandled((h) => ({ ...h, [e.data.id]: true }));
      };
    }
    void sync();
    const timers = dropTimers.current;
    return () => {
      window.removeEventListener(CALL_EVENT, onEvent);
      window.removeEventListener(CALL_SYNC_EVENT, onSync);
      document.removeEventListener("visibilitychange", onVisible);
      bc?.close();
      bcRef.current = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [sync, upsert]);

  const list = useMemo(() => Object.values(calls).sort((a, b) => a.created - b.created), [calls]);
  const myState = useCallback((c: CallView) => c.callees.find((x) => lower(x.email) === me)?.state ?? null, [me]);

  const incoming = useMemo(
    () => list.filter((c) => isCallActive(c) && !handled[c.id] && lower(c.caller.email) !== me && myState(c) === "ringing"),
    [list, handled, me, myState],
  );
  const outgoing = useMemo(
    () => list.find((c) => local[c.id] && lower(c.caller.email) === me && c.state !== "answered" && c.state !== "ended") ?? null,
    [list, local, me],
  );

  const dnd = prefs.dndUntil > Date.now();
  const isMin = useCallback((c: CallView) => minimized[c.id] ?? dnd, [minimized, dnd]);

  /* ----------------------------------------------------------- actions */

  const join = useCallback(async (info: JoinInfo, video: boolean): Promise<boolean> => {
    const m = live.current.meeting;
    let ok = true;
    if (m.call?.roomName !== info.room) {
      if (m.call) await m.leave();
      ok = await m.join(info.room, { audio: true, video }, info.videoRecording);
    }
    // Failed joins land on the room's page, which shows the error and lets them retry.
    live.current.router.push(meetHref(info.room));
    return ok;
  }, []);

  const startCall = useCallback(
    async (target: CallTarget, media: CallMedia, opts?: { ringAll?: boolean }): Promise<StartOutcome> => {
      if (startingRef.current) return { ok: false, error: "busy" };
      startingRef.current = true;
      setStarting(true);
      unlockAudio();
      try {
        const r = await api<JoinInfo>("start", { ...target, media, ringAll: !!opts?.ringAll });
        if (!r.ok) return r;
        const info = r.data;
        const placed = info.call && lower(info.call.caller.email) === me && info.call.state === "ringing" ? info.call : null;
        if (info.call) upsert(info.call);
        if (placed) setLocal((l) => ({ ...l, [placed.id]: true }));
        const joined = await join(info, info.media === "video");
        if (!joined && placed) void api("cancel", { id: placed.id });
        return { ok: true, conversationId: info.conversationId };
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [join, me, upsert],
  );

  const accept = useCallback(
    async (c: CallView, video: boolean) => {
      markHandled(c.id);
      unlockAudio();
      const r = await api<JoinInfo>("answer", { id: c.id });
      if (!r.ok) {
        setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}` as "errors.failed") : t("errors.failed"));
        return;
      }
      if (r.data.call) upsert(r.data.call);
      await join(r.data, video);
    },
    [join, markHandled, t, upsert],
  );

  const decline = useCallback(
    (c: CallView, reply?: string) => {
      markHandled(c.id);
      void api("decline", { id: c.id, ...(reply ? { reply } : {}) });
    },
    [markHandled],
  );

  const cancel = useCallback(async (c: CallView) => {
    await api("cancel", { id: c.id });
    const m = live.current.meeting;
    if (m.call?.roomName === c.room && (remotesByRoom.current[c.room] ?? 0) === 0) await m.leave();
  }, []);

  /* ------------------------------------------------------ side effects */

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error]);

  // Ringtone + desktop notification: one tab per browser (focused first, then visible, then any).
  const lead = incoming[0] ?? null;
  const ringing = !!lead;
  const silent = dnd || !prefs.ringtone;
  const desktop = !dnd && prefs.desktop && permission === "granted";
  const leadRef = useRef(lead);
  leadRef.current = lead;
  useEffect(() => {
    if (!ringing) return;
    let cancelled = false;
    let stopTone: (() => void) | null = null;
    let note: Notification | null = null;
    let release: (() => void) | null = null;
    const own = () => {
      if (!silent) stopTone = startRingtone();
      const c = leadRef.current;
      if (c && desktop && document.visibilityState !== "visible") {
        try {
          note = new Notification(t("desktopTitle", { name: c.caller.name }), {
            body: [c.media === "video" ? t("incomingVideo") : t("incomingAudio"), c.conversationName ?? ""].filter(Boolean).join(" · "),
            tag: `call:${c.id}`,
            requireInteraction: true,
          });
          note.onclick = () => {
            window.focus();
            setMinimized((m) => ({ ...m, [c.id]: false }));
            note?.close();
          };
        } catch {}
      }
    };
    const delay = document.hasFocus() ? 0 : document.visibilityState === "visible" ? 100 : 250;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (!locks) {
        if (document.visibilityState === "visible") own();
        return;
      }
      void locks
        .request(RING_LOCK, { ifAvailable: true }, (lock) => {
          if (!lock || cancelled) return;
          own();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => {});
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stopTone?.();
      note?.close();
      release?.();
    };
  }, [ringing, lead?.id, silent, desktop, t]);

  // Hidden tab: flash the title while ringing.
  useEffect(() => {
    if (!lead) return;
    const flash = t("titleFlash", { name: lead.caller.name });
    let base: string | null = null;
    let on = false;
    const tick = () => {
      if (document.visibilityState === "visible") {
        if (base !== null) document.title = base;
        base = null;
        return;
      }
      base ??= document.title;
      on = !on;
      document.title = on ? flash : base;
    };
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      if (base !== null) document.title = base;
    };
  }, [lead, t]);

  // Ringback while my call rings the others.
  const ringback = outgoing?.state === "ringing";

  // While anything rings, re-check the server now and then (a missed event must not ring forever).
  useEffect(() => {
    if (!ringing && !ringback) return;
    const id = setInterval(() => void sync(), 15_000);
    return () => clearInterval(id);
  }, [ringing, ringback, sync]);
  useEffect(() => {
    if (!ringback) return;
    return startRingback();
  }, [ringback]);

  // Closing the calling tab cancels its ringing call.
  useEffect(() => {
    const onHide = () => {
      for (const c of Object.values(callsRef.current)) {
        if (localRef.current[c.id] && c.state === "ringing") navigator.sendBeacon?.("/api/calls/cancel", JSON.stringify({ id: c.id }));
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const roomName = meeting.call?.roomName ?? null;
  const room = meeting.call?.room ?? null;

  // Joined a room that is ringing me (e.g. from the card's Join link): that answers it.
  useEffect(() => {
    if (!roomName) return;
    for (const c of incoming) {
      if (c.room !== roomName) continue;
      markHandled(c.id);
      void api("answer", { id: c.id });
    }
  }, [roomName, incoming, markHandled]);

  // Left a call's room: tell the server (cancels my unanswered call; ends a DM call, or a group
  // call when I was the last one). Not when the same account took the seat on another device.
  const prevRoom = useRef<string | null>(null);
  const endedRef = useRef(meeting.ended);
  endedRef.current = meeting.ended;
  useEffect(() => {
    const prev = prevRoom.current;
    prevRoom.current = roomName;
    if (!prev || prev === roomName) return;
    if (endedRef.current?.roomName === prev && endedRef.current.reason === "duplicate") return;
    const last = (remotesByRoom.current[prev] ?? 0) === 0;
    for (const c of Object.values(callsRef.current)) {
      if (c.room !== prev || !isCallActive(c)) continue;
      if (lower(c.caller.email) === me || myState(c) === "accepted") void api("end", { id: c.id, last });
    }
  }, [roomName, me, myState]);

  // Who else is in the room I'm in.
  useEffect(() => {
    if (!room || !roomName) return;
    let disposed = false;
    let off = () => {};
    const update = () => {
      const n = room.remoteParticipants.size;
      remotesByRoom.current[roomName] = n;
      if (n > 0) hadRemote.current[roomName] = true;
      setRemotes(n);
    };
    update();
    void import("livekit-client").then(({ RoomEvent }) => {
      if (disposed) return;
      room.on(RoomEvent.ParticipantConnected, update).on(RoomEvent.ParticipantDisconnected, update);
      off = () => {
        room.off(RoomEvent.ParticipantConnected, update);
        room.off(RoomEvent.ParticipantDisconnected, update);
      };
    });
    return () => {
      disposed = true;
      off();
    };
  }, [room, roomName]);

  // Hang up when the call is over and I'm alone in its room: it ended unanswered (after showing
  // why), it ended, or the other person left a DM call.
  useEffect(() => {
    if (!roomName || remotes > 0) return;
    const c = list.filter((x) => x.room === roomName).at(-1);
    if (!c) return;
    const involved = lower(c.caller.email) === me || myState(c) === "accepted";
    if (!involved) return;
    let wait = 0;
    if (!isCallActive(c)) wait = c.state === "ended" ? 800 : 2500;
    else if (c.state === "answered" && c.conversationKind === "dm" && hadRemote.current[roomName]) wait = 2000;
    else return;
    const id = setTimeout(() => {
      if ((remotesByRoom.current[roomName] ?? 0) === 0) void live.current.meeting.leave();
    }, wait);
    return () => clearTimeout(id);
  }, [list, roomName, remotes, me, myState]);

  const value = useMemo<Ctx>(() => ({ calls: list.filter(isCallActive), startCall, starting }), [list, startCall, starting]);

  // What to show for incoming calls: the first full one as a modal (or a banner when already in
  // a call), the rest as chips.
  const inOtherCall = (c: CallView) => !!roomName && roomName !== c.room;
  const full = incoming.find((c) => !isMin(c)) ?? null;
  const chips = incoming.filter((c) => c !== full);

  return (
    <CallsContext.Provider value={value}>
      {children}
      {full &&
        (inOtherCall(full) ? (
          <IncomingBanner
            key={full.id}
            call={full}
            onAccept={() => void accept(full, full.media === "video")}
            onDecline={() => decline(full)}
            onMinimize={() => setMinimized((m) => ({ ...m, [full.id]: true }))}
          />
        ) : (
          <IncomingDialog
            key={full.id}
            call={full}
            onAccept={(video) => void accept(full, video)}
            onDecline={(reply) => decline(full, reply)}
            onMinimize={() => setMinimized((m) => ({ ...m, [full.id]: true }))}
          />
        ))}
      {(chips.length > 0 || outgoing || error) && (
        <div className="pointer-events-none fixed top-3 left-1/2 z-[95] flex w-[min(420px,calc(100vw-1.5rem))] -translate-x-1/2 flex-col gap-2">
          {outgoing && <OutgoingCard call={outgoing} onCancel={() => void cancel(outgoing)} />}
          {chips.map((c) => (
            <RingingChip
              key={c.id}
              call={c}
              silent={silent}
              onExpand={() => setMinimized((m) => ({ ...m, [c.id]: false }))}
              onAccept={() => void accept(c, c.media === "video" && !inOtherCall(c))}
              onDecline={() => decline(c)}
            />
          ))}
          {error && (
            <p role="alert" className="pop pointer-events-auto px-4 py-2.5 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </CallsContext.Provider>
  );
}

/* ------------------------------------------------------------------- UI */

const ROUND_BASE =
  "grid h-12 w-12 place-items-center rounded-full transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
const ROUND = `${ROUND_BASE} text-white`;
const DECLINE_BG = { background: "var(--color-danger, #dc2626)" };
const ACCEPT_BG = { background: "var(--color-signal, #16a34a)" };

function useCallLabels(call: CallView) {
  const t = useTranslations("calls");
  const kind = call.media === "video" ? t("incomingVideo") : t("incomingAudio");
  const where =
    call.conversationKind === "dm"
      ? null
      : call.conversationKind === "channel"
        ? `#${call.conversationName ?? ""}`
        : (call.conversationName ?? null);
  return { kind, where };
}

/** Full incoming-call modal: focus trapped, Enter accepts, Esc minimizes (never declines). */
function IncomingDialog({
  call,
  onAccept,
  onDecline,
  onMinimize,
}: {
  call: CallView;
  onAccept: (video: boolean) => void;
  onDecline: (reply?: string) => void;
  onMinimize: () => void;
}) {
  const t = useTranslations("calls");
  const { kind, where } = useCallLabels(call);
  const ref = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const [replies, setReplies] = useState(false);
  const video = call.media === "video";

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    acceptRef.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onMinimize();
      return;
    }
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      onAccept(video);
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[96] grid place-items-center bg-black/45 p-4">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="zw-call-title"
        aria-describedby="zw-call-desc"
        onKeyDown={onKeyDown}
        className="pop relative w-full max-w-sm px-6 pt-8 pb-6 text-center"
      >
        <button
          type="button"
          onClick={onMinimize}
          className="icon-btn absolute top-2 right-2 h-8 w-8"
          aria-label={t("minimize")}
          title={t("minimize")}
        >
          <ChevronDown size={16} aria-hidden />
        </button>
        <span className="relative mx-auto grid h-20 w-20 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full opacity-25" style={ACCEPT_BG} aria-hidden />
          <CallAvatar name={call.caller.name} email={call.caller.email} size={80} />
        </span>
        <h2 id="zw-call-title" className="mt-5 truncate text-[18px] font-semibold text-ink">
          {call.caller.name}
        </h2>
        <p id="zw-call-desc" className="mt-1 flex items-center justify-center gap-1.5 text-[13.5px] text-ink-soft">
          {video ? <Video size={14} aria-hidden /> : <Phone size={14} aria-hidden />}
          <span className="truncate">{where ? `${kind} · ${where}` : kind}</span>
        </p>

        <div className="mt-7 flex items-start justify-center gap-6">
          <div className="flex flex-col items-center gap-1.5">
            <button type="button" onClick={() => onDecline()} className={ROUND} style={DECLINE_BG} aria-label={t("decline")}>
              <PhoneOff size={20} aria-hidden />
            </button>
            <span className="text-[12px] text-ink-soft" aria-hidden>
              {t("decline")}
            </span>
          </div>
          {video && (
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => onAccept(false)}
                className={`${ROUND_BASE} border border-line-strong text-ink hover:bg-hover`}
                aria-label={t("acceptAudioOnly")}
              >
                <VideoOff size={20} aria-hidden />
              </button>
              <span className="max-w-20 text-[12px] leading-tight text-ink-soft" aria-hidden>
                {t("acceptAudioOnly")}
              </span>
            </div>
          )}
          <div className="flex flex-col items-center gap-1.5">
            <button ref={acceptRef} type="button" onClick={() => onAccept(video)} className={ROUND} style={ACCEPT_BG} aria-label={t("accept")}>
              {video ? <Video size={20} aria-hidden /> : <Phone size={20} aria-hidden />}
            </button>
            <span className="text-[12px] text-ink-soft" aria-hidden>
              {t("accept")}
            </span>
          </div>
        </div>

        <div className="mt-6 border-t border-line pt-3">
          {replies ? (
            <div className="flex flex-wrap justify-center gap-2" role="group" aria-label={t("quickReply")}>
              {[t("replyBusy"), t("replyLater")].map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => onDecline(text)}
                  className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink"
                >
                  {text}
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setReplies(true)}
              className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-mute hover:text-ink"
            >
              <MessageSquare size={13} aria-hidden />
              {t("quickReply")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Incoming call while already in another one: accepting switches calls. Not modal. */
function IncomingBanner({
  call,
  onAccept,
  onDecline,
  onMinimize,
}: {
  call: CallView;
  onAccept: () => void;
  onDecline: () => void;
  onMinimize: () => void;
}) {
  const t = useTranslations("calls");
  const { kind, where } = useCallLabels(call);
  return (
    <div
      role="alertdialog"
      aria-labelledby="zw-call-banner"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onMinimize();
        }
      }}
      className="pop fixed top-3 left-1/2 z-[96] flex w-[min(460px,calc(100vw-1.5rem))] -translate-x-1/2 items-center gap-3 p-3"
    >
      <CallAvatar name={call.caller.name} email={call.caller.email} size={36} />
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] font-medium tracking-wide text-ink-mute uppercase">{t("incomingShort")}</p>
        <p id="zw-call-banner" className="truncate text-[13.5px] font-medium text-ink">
          {call.caller.name}
          <span className="font-normal text-ink-mute"> · {where ? `${kind} · ${where}` : kind}</span>
        </p>
      </div>
      <button type="button" onClick={onDecline} className="grid h-9 w-9 place-items-center rounded-full text-white" style={DECLINE_BG} aria-label={t("decline")} title={t("decline")}>
        <PhoneOff size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onAccept}
        className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-white"
        style={ACCEPT_BG}
        title={t("switchHint")}
      >
        <Phone size={15} aria-hidden />
        {t("switch")}
      </button>
    </div>
  );
}

/** A minimized incoming call: keeps ringing, one click to answer, decline or reopen. */
function RingingChip({
  call,
  silent,
  onExpand,
  onAccept,
  onDecline,
}: {
  call: CallView;
  silent: boolean;
  onExpand: () => void;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const t = useTranslations("calls");
  const { kind } = useCallLabels(call);
  return (
    <div role="group" aria-label={t("desktopTitle", { name: call.caller.name })} className="pop pointer-events-auto flex items-center gap-2.5 py-2 pr-2 pl-3">
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={ACCEPT_BG} />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={ACCEPT_BG} />
      </span>
      <button type="button" onClick={onExpand} className="min-w-0 flex-1 truncate text-left text-[13px] text-ink" title={t("expand")}>
        <span className="font-medium">{call.caller.name}</span>
        <span className="text-ink-mute">
          {" "}
          · {kind}
          {silent ? ` · ${t("silent")}` : ""}
        </span>
      </button>
      <button type="button" onClick={onDecline} className="grid h-8 w-8 place-items-center rounded-full text-white" style={DECLINE_BG} aria-label={t("decline")} title={t("decline")}>
        <PhoneOff size={14} aria-hidden />
      </button>
      <button type="button" onClick={onAccept} className="grid h-8 w-8 place-items-center rounded-full text-white" style={ACCEPT_BG} aria-label={t("accept")} title={t("accept")}>
        {call.media === "video" ? <Video size={14} aria-hidden /> : <Phone size={14} aria-hidden />}
      </button>
    </div>
  );
}

/** The caller's "Calling Ana…" card, then why it ended if nobody answered. */
function OutgoingCard({ call, onCancel }: { call: CallView; onCancel: () => void }) {
  const t = useTranslations("calls");
  const locale = useLocale();
  const names = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    call.callees.slice(0, 3).map((c) => c.name.split(" ")[0] || c.name),
  );
  const more = call.callees.length > 3 ? ` +${call.callees.length - 3}` : "";
  const ringing = call.state === "ringing";
  const declined = call.callees.filter((c) => c.state === "declined").length;
  const text = ringing
    ? t("calling", { names: names + more })
    : call.state === "declined"
      ? t("outcome.declined")
      : call.state === "cancelled"
        ? t("outcome.cancelled")
        : t("outcome.missed");
  return (
    <div role="status" aria-live="polite" className="pop pointer-events-auto flex items-center gap-3 p-3">
      <span className="flex shrink-0 -space-x-2">
        {call.callees.slice(0, 3).map((c) => (
          <span key={c.id} className={`rounded-full ring-2 ring-sheet ${c.state === "declined" ? "opacity-40" : ""}`}>
            <CallAvatar name={c.name} email={c.email} size={34} />
          </span>
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-ink">{text}</p>
        <p className="truncate text-[12px] text-ink-mute">
          {call.media === "video" ? t("videoCall") : t("voiceCall")}
          {ringing && declined > 0 ? ` · ${t("declinedCount", { count: declined })}` : ""}
        </p>
      </div>
      {ringing && (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-white"
          style={DECLINE_BG}
        >
          <PhoneOff size={15} aria-hidden />
          {t("cancel")}
        </button>
      )}
    </div>
  );
}
