"use client";

import { RoomEvent, Track, type AudioTrack, type Room } from "livekit-client";
import { Loader2, Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useReducer, useRef, useState } from "react";
import { AudioView, Tile } from "@/app/(apps)/meet/media";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from "../../_ui/Shell";

const EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ConnectionQualityChanged,
];

/** A minimal call view for external guests: tiles, mic/camera toggles and leave. */
export function GuestCall({ token, defaultName, ownerName, when }: { token: string; defaultName: string; ownerName: string; when: string }) {
  const t = useTranslations("booking.join");
  const [name, setName] = useState(defaultName);
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<"idle" | "joining" | "left" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    if (!room) return;
    for (const e of EVENTS) room.on(e, rerender);
    const onLeft = () => {
      setRoom(null);
      setState("left");
    };
    room.once(RoomEvent.Disconnected, onLeft);
    return () => {
      for (const e of EVENTS) room.off(e, rerender);
      room.off(RoomEvent.Disconnected, onLeft);
    };
  }, [room]);
  useEffect(() => () => void roomRef.current?.disconnect(true), []);

  async function join() {
    setState("joining");
    setError(null);
    try {
      const res = await fetch("/api/book/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name }),
      });
      if (!res.ok) {
        const out = (await res.json().catch(() => ({}))) as { error?: string };
        setError(out.error === "too_early" ? t("early") : out.error === "too_late" ? t("over") : t("failed"));
        setState("error");
        return;
      }
      const { token: lk, url } = (await res.json()) as { token: string; url: string };
      const { Room } = await import("livekit-client");
      const r = new Room({ adaptiveStream: true, dynacast: true });
      await r.connect(url, lk);
      roomRef.current = r;
      setRoom(r);
      setState("idle");
      await Promise.allSettled([r.localParticipant.setMicrophoneEnabled(true), r.localParticipant.setCameraEnabled(true)]);
      rerender();
    } catch {
      setError(t("failed"));
      setState("error");
    }
  }

  if (!room) {
    return (
      <section className="sheet rise mx-auto max-w-md p-6">
        <h1 className="text-[20px] font-semibold">{t("title")}</h1>
        <p className="mt-1 text-[13.5px] text-ink-soft">{when}</p>
        <p className="mt-1 text-[13.5px] text-ink-soft">{t("with", { owner: ownerName })}</p>
        {state === "left" && <p className="mt-4 text-[14px] text-ink-soft">{t("left")}</p>}
        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft">
            {t("yourName")}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className={INPUT} />
          </label>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
          <button type="submit" disabled={state === "joining"} className={BTN_PRIMARY}>
            {state === "joining" && <Loader2 size={15} className="animate-spin" aria-hidden />}
            {state === "left" ? t("rejoin") : t("join")}
          </button>
        </form>
      </section>
    );
  }

  const local = room.localParticipant;
  const people = [local, ...room.remoteParticipants.values()];
  const audio = [...room.remoteParticipants.values()].flatMap((p) =>
    [...p.trackPublications.values()]
      .filter((pub) => pub.kind === Track.Kind.Audio && pub.track)
      .map((pub) => ({ key: `${p.identity}:${pub.trackSid}`, track: pub.track as AudioTrack })),
  );
  const cols = people.length <= 1 ? "grid-cols-1" : people.length <= 4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 lg:grid-cols-3";

  return (
    <section className="flex flex-col gap-3">
      {room.remoteParticipants.size === 0 && <p className="text-center text-[13.5px] text-ink-soft">{t("waiting", { owner: ownerName })}</p>}
      <div className={`grid gap-2 ${cols}`}>
        {people.map((p) => (
          <div key={p.identity} className="aspect-video">
            <Tile participant={p} source={Track.Source.Camera} isLocal={p === local} />
          </div>
        ))}
      </div>
      {audio.map((a) => (
        <AudioView key={a.key} track={a.track} />
      ))}
      <div className="flex justify-center gap-2">
        <button
          type="button"
          className={BTN_SECONDARY}
          aria-pressed={local.isMicrophoneEnabled}
          onClick={() => void local.setMicrophoneEnabled(!local.isMicrophoneEnabled).then(rerender)}
        >
          {local.isMicrophoneEnabled ? <Mic size={16} aria-hidden /> : <MicOff size={16} aria-hidden />}
          {local.isMicrophoneEnabled ? t("micOff") : t("micOn")}
        </button>
        <button
          type="button"
          className={BTN_SECONDARY}
          aria-pressed={local.isCameraEnabled}
          onClick={() => void local.setCameraEnabled(!local.isCameraEnabled).then(rerender)}
        >
          {local.isCameraEnabled ? <Video size={16} aria-hidden /> : <VideoOff size={16} aria-hidden />}
          {local.isCameraEnabled ? t("camOff") : t("camOn")}
        </button>
        <button type="button" className={`${BTN_PRIMARY} !bg-danger !text-white`} onClick={() => void room.disconnect(true)}>
          <PhoneOff size={16} aria-hidden /> {t("leave")}
        </button>
      </div>
    </section>
  );
}
