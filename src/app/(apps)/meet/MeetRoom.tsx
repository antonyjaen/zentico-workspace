"use client";

import { DisconnectReason, Room, RoomEvent } from "livekit-client";
import { PhoneOff } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { InCall } from "./InCall";
import { PreJoin, type JoinSettings } from "./PreJoin";

type LeftReason = "self" | "duplicate" | "ended" | "lost";
type Phase = { kind: "prejoin" } | { kind: "call"; room: Room } | { kind: "left"; reason: LeftReason };

function leftReason(reason?: DisconnectReason): LeftReason {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return "self";
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "duplicate";
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.ROOM_DELETED:
      return "ended";
    default:
      return "lost";
  }
}

export function MeetRoom({
  room: roomName,
  name,
  email,
  videoRecording,
}: {
  room: string;
  name: string;
  email: string;
  /** Whether "Video + transcript" recording (LiveKit egress) is available. */
  videoRecording: boolean;
}) {
  const t = useTranslations("meet");
  const [phase, setPhase] = useState<Phase>({ kind: "prejoin" });
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);

  // Leaving the page (navigation, tab close via unmount) always disconnects and stops local tracks.
  useEffect(
    () => () => {
      void roomRef.current?.disconnect(true);
      roomRef.current = null;
    },
    [],
  );

  const join = async (settings: JoinSettings) => {
    setJoining(true);
    setError(null);
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
        return;
      }
      if (!res.ok) throw new Error(res.status === 503 ? "not_configured" : "token");
      const { token, url } = (await res.json()) as { token: string; url: string };

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
        setPhase({ kind: "left", reason: leftReason(reason) });
      });
      setPhase({ kind: "call", room: connected });

      // Publish after the call UI is up; failures surface as MediaDevicesError toasts in the call.
      const lp = connected.localParticipant;
      await Promise.allSettled([
        settings.audio ? lp.setMicrophoneEnabled(true) : Promise.resolve(),
        settings.video ? lp.setCameraEnabled(true) : Promise.resolve(),
      ]);
    } catch (e) {
      void room?.disconnect(true);
      setError(e instanceof Error && e.message === "not_configured" ? t("notConfigured") : t("connectFailed"));
      setPhase({ kind: "prejoin" });
    } finally {
      setJoining(false);
    }
  };

  if (phase.kind === "call") return <InCall room={phase.room} roomName={roomName} videoRecording={videoRecording} />;

  if (phase.kind === "left") {
    const message = {
      self: t("leftSelf"),
      duplicate: t("leftDuplicate"),
      ended: t("leftEnded"),
      lost: t("leftLost"),
    }[phase.reason];
    return (
      <div className="grid flex-1 place-items-center p-10 text-center">
        <div className="rise max-w-sm">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted text-ink-soft">
            <PhoneOff size={24} aria-hidden />
          </span>
          <p className="mt-6 text-[17px] font-medium text-ink">{message}</p>
          <div className="mt-6 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => setPhase({ kind: "prejoin" })}
              className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover"
            >
              {t("rejoin")}
            </button>
            <Link
              href="/meet"
              className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-[14px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink"
            >
              {t("backToMeet")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <PreJoin room={roomName} name={name} email={email} joining={joining} error={error} onJoin={join} />;
}
