"use client";

import {
  ConnectionQuality,
  Track,
  type AudioTrack,
  type Participant,
  type VideoTrack,
} from "livekit-client";
import { MicOff, MonitorUp, SignalLow } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { avatarGradient, initials } from "../contacts/hrefs";

export const displayName = (p: Participant) => p.name || p.identity;

/** Attaches a LiveKit video track to a <video> element for as long as it is rendered. */
export function VideoView({ track, mirror, fit = "cover" }: { track: VideoTrack; mirror?: boolean; fit?: "cover" | "contain" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"} ${mirror ? "-scale-x-100" : ""}`}
    />
  );
}

/** Plays a remote audio track through a hidden <audio> element. */
export function AudioView({ track }: { track: AudioTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

export function Avatar({ name, seed, size }: { name: string; seed: string; size: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-medium text-white select-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: avatarGradient(seed) }}
    >
      {initials(name)}
    </span>
  );
}

export type TileSource = Track.Source.Camera | Track.Source.ScreenShare;

/** The live video track for a participant's camera or screen, or null when off/muted/unsubscribed. */
export function videoTrackOf(p: Participant, source: TileSource): VideoTrack | null {
  const pub = p.getTrackPublication(source);
  if (!pub || pub.isMuted || !pub.track) return null;
  return pub.track as VideoTrack;
}

export function Tile({
  participant,
  source,
  isLocal,
  compact,
}: {
  participant: Participant;
  source: TileSource;
  isLocal: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("meet");
  const name = displayName(participant);
  const track = videoTrackOf(participant, source);
  const isScreen = source === Track.Source.ScreenShare;
  const speaking = !isScreen && participant.isSpeaking;
  const quality = participant.connectionQuality;
  const weak = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
  const label = isScreen
    ? t("screenOf", { name: isLocal ? t("you") : name })
    : isLocal
      ? t("youLabel", { name })
      : name;

  return (
    <div
      className={`relative isolate h-full min-h-0 w-full overflow-hidden rounded-lg border bg-sheet-muted transition-[border-color,box-shadow] duration-150 ${
        speaking ? "border-transparent shadow-[0_0_0_2px_var(--color-app-meet)]" : "border-line"
      }`}
    >
      {track ? (
        <VideoView track={track} mirror={isLocal && !isScreen} fit={isScreen ? "contain" : "cover"} />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <Avatar name={name} seed={participant.identity} size={compact ? 40 : 72} />
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2.5 pt-6 pb-2 text-white">
        {isScreen && <MonitorUp size={13} aria-hidden className="shrink-0" />}
        {!isScreen && !participant.isMicrophoneEnabled && (
          <MicOff size={13} aria-label={t("micOffFor", { name })} className="shrink-0 text-white/90" />
        )}
        <span className="min-w-0 truncate text-[12px] font-medium">{label}</span>
      </div>

      {weak && !isScreen && (
        <span
          title={quality === ConnectionQuality.Lost ? t("connectionLost") : t("connectionPoor")}
          className={`absolute top-2 right-2 grid h-6 w-6 place-items-center rounded-md bg-black/60 ${
            quality === ConnectionQuality.Lost ? "text-danger" : "text-amber"
          }`}
        >
          <SignalLow size={14} aria-label={quality === ConnectionQuality.Lost ? t("connectionLost") : t("connectionPoor")} />
        </span>
      )}
    </div>
  );
}
