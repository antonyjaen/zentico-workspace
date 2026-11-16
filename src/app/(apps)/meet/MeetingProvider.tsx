"use client";

import type { Room } from "livekit-client";
import { PhoneOff, X } from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resetLocalStt } from "./localWhisper";
import type { JoinSettings } from "./PreJoin";
import { meetHref } from "./shared";

// The call UI (and livekit-client) only loads once a call starts, not on every app page.
const InCall = dynamic(() => import("./InCall").then((m) => m.InCall), { ssr: false });

export type LeftReason = "self" | "duplicate" | "ended" | "lost";
type ActiveCall = { roomName: string; room: Room; videoRecording: boolean };

type MeetingContext = {
  call: ActiveCall | null;
  /** The last call that ended, until the user moves on (shown as "You left the meeting" etc.). */
  ended: { roomName: string; reason: LeftReason } | null;
  joiningRoom: string | null;
  error: { roomName: string; message: string } | null;
  /** Resolves true once connected (false: failed, or another call/join is in progress). */
  join: (roomName: string, settings: JoinSettings, videoRecording: boolean) => Promise<boolean>;
  /** Hangs up; resolves once disconnected. */
  leave: () => Promise<void>;
  dismissEnded: () => void;
  /** Shows the full call UI inside `el` until the returned cleanup runs. */
  attachSlot: (el: HTMLElement) => () => void;
};

const Ctx = createContext<MeetingContext | null>(null);

export function useMeeting(): MeetingContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMeeting outside MeetingProvider");
  return ctx;
}

/**
 * Owns the live call for the whole app shell, so moving between apps keeps it connected.
 * The call UI (InCall) stays mounted here; its full view is a DOM node that moves into the
 * /meet/<room> page's slot while that page is shown and is parked (hidden) otherwise, when
 * InCall shows a floating mini window instead. Remote audio is rendered outside that node.
 */
export function MeetingProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("meet");
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const [call, setCall] = useState<ActiveCall | null>(null);
  const [ended, setEnded] = useState<MeetingContext["ended"]>(null);
  const [joiningRoom, setJoiningRoom] = useState<string | null>(null);
  const [error, setError] = useState<MeetingContext["error"]>(null);
  const roomRef = useRef<Room | null>(null);
  const joiningRef = useRef(false);

  // The full call view's node. Created on the client only (no call exists during SSR).
  const [host] = useState(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.style.cssText = "display:flex;flex-direction:column;flex:1 1 0%;min-height:0;min-width:0;position:relative";
    return el;
  });
  const parkRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLElement | null>(null);
  const [slotted, setSlotted] = useState(false);

  // Moves are synchronous and always between attached nodes, so <video> elements never leave the
  // document (which would pause them).
  const place = useCallback(() => {
    const target = slotRef.current ?? parkRef.current;
    if (host && target && host.parentNode !== target) target.appendChild(host);
  }, [host]);
  useLayoutEffect(place, [place, call]);

  const attachSlot = useCallback(
    (el: HTMLElement) => {
      slotRef.current = el;
      place();
      setSlotted(true);
      return () => {
        if (slotRef.current !== el) return;
        slotRef.current = null;
        place();
        setSlotted(false);
      };
    },
    [place],
  );

  // A full reload or closing the tab ends the call: ask first. Leaving the app shell (sign-out)
  // unmounts this provider and hangs up.
  useEffect(() => {
    if (!call) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [call]);
  useEffect(
    () => () => {
      void roomRef.current?.disconnect(true);
      roomRef.current = null;
    },
    [],
  );

  const join = useCallback(
    async (roomName: string, settings: JoinSettings, videoRecording: boolean): Promise<boolean> => {
      // One Room at a time: double clicks and a second join while connected are ignored.
      if (joiningRef.current || roomRef.current) return false;
      joiningRef.current = true;
      setJoiningRoom(roomName);
      setError(null);
      setEnded(null);
      let room: Room | null = null;
      try {
        const res = await fetch("/api/meet/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: roomName }),
        });
        // Expired session: middleware redirects to sign-in, the route itself answers 401.
        if (res.status === 401 || res.redirected) {
          window.location.assign(`/signin?returnTo=${encodeURIComponent(window.location.pathname)}`);
          return false;
        }
        if (!res.ok) throw new Error(res.status === 503 ? "not_configured" : "token");
        const { token, url } = (await res.json()) as { token: string; url: string };

        const { Room, RoomEvent, DisconnectReason } = await import("livekit-client");
        room = new Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: { deviceId: settings.audioDeviceId, echoCancellation: true, noiseSuppression: true },
          videoCaptureDefaults: { deviceId: settings.videoDeviceId, resolution: { width: 1280, height: 720 } },
        });
        await room.connect(url, token);
        const connected = room;
        roomRef.current = connected;
        connected.once(RoomEvent.Disconnected, (reason) => {
          if (roomRef.current === connected) roomRef.current = null;
          const why: LeftReason =
            reason === DisconnectReason.CLIENT_INITIATED
              ? "self"
              : reason === DisconnectReason.DUPLICATE_IDENTITY
                ? "duplicate"
                : reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED
                  ? "ended"
                  : "lost";
          // Hanging up from the mini window elsewhere in the app needs no "you left" screen.
          const onPage = pathRef.current === meetHref(roomName);
          setEnded(why === "self" && !onPage ? null : { roomName, reason: why });
          setCall((c) => (c?.room === connected ? null : c));
          // Frees the on-device speech model (GPU memory) with the call.
          resetLocalStt();
        });
        setCall({ roomName, room: connected, videoRecording });

        // Publish after the call UI is up; failures surface as MediaDevicesError toasts in the call.
        const lp = connected.localParticipant;
        await Promise.allSettled([
          settings.audio ? lp.setMicrophoneEnabled(true) : Promise.resolve(),
          settings.video ? lp.setCameraEnabled(true) : Promise.resolve(),
        ]);
        return true;
      } catch (e) {
        // Only the token fetch or connect() can throw (publishing is allSettled).
        void room?.disconnect(true);
        setError({
          roomName,
          message: e instanceof Error && e.message === "not_configured" ? t("notConfigured") : t("connectFailed"),
        });
        return false;
      } finally {
        joiningRef.current = false;
        setJoiningRoom(null);
      }
    },
    [t],
  );

  // Moving on from the "you left" page forgets it; an end noticed elsewhere stays until dismissed.
  const prevPath = useRef(pathname);
  useEffect(() => {
    const prev = prevPath.current;
    prevPath.current = pathname;
    if (prev !== pathname) setEnded((e) => (e && prev === meetHref(e.roomName) ? null : e));
  }, [pathname]);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.disconnect(true).catch(() => {});
    if (roomRef.current === room) roomRef.current = null;
  }, []);
  const dismissEnded = useCallback(() => setEnded(null), []);

  const value = useMemo<MeetingContext>(
    () => ({ call, ended, joiningRoom, error, join, leave, dismissEnded, attachSlot }),
    [call, ended, joiningRoom, error, join, leave, dismissEnded, attachSlot],
  );

  const endedElsewhere = ended && pathname !== meetHref(ended.roomName);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div ref={parkRef} hidden />
      {call && host && (
        <InCall
          room={call.room}
          roomName={call.roomName}
          videoRecording={call.videoRecording}
          host={host}
          onPage={slotted}
        />
      )}
      {endedElsewhere && (
        <div
          role="status"
          className="pop fixed right-4 bottom-4 z-[90] flex max-w-[calc(100vw-2rem)] items-center gap-3 py-2.5 pr-2 pl-4 text-[13.5px]"
        >
          <PhoneOff size={15} aria-hidden className="shrink-0 text-ink-soft" />
          <span className="min-w-0 text-ink">
            {{ self: t("leftSelf"), duplicate: t("leftDuplicate"), ended: t("leftEnded"), lost: t("leftLost") }[ended.reason]}
          </span>
          <Link
            href={meetHref(ended.roomName)}
            onClick={dismissEnded}
            className="shrink-0 font-medium text-ink underline underline-offset-2"
          >
            {t("rejoin")}
          </Link>
          <button type="button" className="icon-btn shrink-0" onClick={dismissEnded} aria-label={t("closePanel")}>
            <X size={15} aria-hidden />
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
