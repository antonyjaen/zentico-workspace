"use client";

import { Track, type Participant, type Room } from "livekit-client";
import { Ear, Loader2, Maximize2, Mic, MicOff, MonitorUp, PhoneOff, Users, Video, VideoOff, Volume2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar, displayName, VideoView, videoTrackOf } from "./media";
import { meetHref } from "./shared";
import type { useClaudeCommands } from "./useClaudeCommands";
import type { ActiveRecording } from "./useRecording";

type Corner = "tl" | "tr" | "bl" | "br";
const CORNER_KEY = "zw.meet.miniCorner";
const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];
const CORNER_CLASS: Record<Corner, string> = {
  tl: "top-4 left-4",
  tr: "top-4 right-4",
  bl: "bottom-4 left-4",
  br: "bottom-4 right-4",
};

function readCorner(): Corner {
  try {
    const v = localStorage.getItem(CORNER_KEY);
    return CORNERS.includes(v as Corner) ? (v as Corner) : "br";
  } catch {
    return "br";
  }
}

function writeCorner(c: Corner) {
  try {
    localStorage.setItem(CORNER_KEY, c);
  } catch {
    // private mode / blocked storage: the corner just isn't remembered
  }
}

/** The call while the user is elsewhere in the app: draggable, snaps to the nearest corner. */
export function MiniCall({
  room,
  roomName,
  speaker,
  count,
  busy,
  onToggleMic,
  onToggleCam,
  recording,
  claude,
  reconnecting,
  toast,
}: {
  room: Room;
  roomName: string;
  speaker: Participant;
  count: number;
  busy: { mic?: boolean; cam?: boolean };
  onToggleMic: () => void;
  onToggleCam: () => void;
  recording: ActiveRecording | null;
  claude: ReturnType<typeof useClaudeCommands>;
  reconnecting: boolean;
  toast: string | null;
}) {
  const t = useTranslations("meet");
  const router = useRouter();
  const lp = room.localParticipant;
  const [corner, setCorner] = useState<Corner>("br");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number; id: number } | null>(null);

  useEffect(() => setCorner(readCorner()), []);

  // A remote screen share is what people want to keep an eye on; otherwise the active speaker.
  const sharer = [...room.remoteParticipants.values()].find((p) => videoTrackOf(p, Track.Source.ScreenShare));
  const shown = sharer ?? speaker;
  const source = sharer ? Track.Source.ScreenShare : Track.Source.Camera;
  const track = videoTrackOf(shown, source);
  const isLocal = shown === lp;
  const name = displayName(shown);
  const listening = claude.capturing || claude.others.length > 0;
  const pendingConfirm = !!claude.data?.confirmations.length;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, a")) return;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, id: e.pointerId };
    setDrag({ x: box.left, y: box.top });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    const box = boxRef.current;
    if (!g || g.id !== e.pointerId || !box) return;
    const maxX = window.innerWidth - box.offsetWidth;
    const maxY = window.innerHeight - box.offsetHeight;
    setDrag({
      x: Math.max(0, Math.min(maxX, e.clientX - g.dx)),
      y: Math.max(0, Math.min(maxY, e.clientY - g.dy)),
    });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    const box = boxRef.current;
    if (!g || g.id !== e.pointerId) return;
    grab.current = null;
    if (box) {
      const r = box.getBoundingClientRect();
      const left = r.left + r.width / 2 < window.innerWidth / 2;
      const top = r.top + r.height / 2 < window.innerHeight / 2;
      const next: Corner = `${top ? "t" : "b"}${left ? "l" : "r"}` as Corner;
      setCorner(next);
      writeCorner(next);
    }
    setDrag(null);
  };

  const btn = (on: boolean) =>
    `grid h-9 w-9 place-items-center rounded-full border transition-colors duration-150 disabled:opacity-50 ${
      on ? "border-transparent bg-primary-soft text-ink" : "border-transparent bg-danger text-white hover:opacity-90"
    }`;

  return (
    <div
      ref={boxRef}
      role="region"
      aria-label={t("miniTitle", { room: roomName })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`pop fixed z-[80] w-72 max-w-[calc(100vw-2rem)] touch-none overflow-hidden p-0 select-none ${
        drag ? "cursor-grabbing" : `cursor-grab ${CORNER_CLASS[corner]}`
      }`}
      style={drag ? { left: drag.x, top: drag.y } : undefined}
    >
      <div className="relative aspect-video bg-sheet-muted">
        {track ? (
          <VideoView track={track} mirror={isLocal && source === Track.Source.Camera} fit={sharer ? "contain" : "cover"} />
        ) : (
          <div className="grid h-full w-full place-items-center">
            <Avatar name={name} seed={shown.identity} size={56} />
          </div>
        )}

        {/* Consent indicators stay visible while minimised. */}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          {recording && (
            <span
              className="flex items-center gap-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11.5px] font-medium text-white"
              title={recording.mine ? t("recNoticeSelf") : t("recNotice", { name: recording.byName })}
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
              {t("recRecording")}
            </span>
          )}
          {listening && (
            <span
              className="flex items-center gap-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11.5px] font-medium text-white"
              title={
                claude.capturing
                  ? t("claudeListeningSelf")
                  : claude.others.map((o) => t("claudeListeningBy", { name: o.name })).join(" · ")
              }
            >
              <Ear size={12} aria-hidden style={{ color: "var(--color-app-meet)" }} />
              {t("miniClaudeListening")}
            </span>
          )}
          {pendingConfirm && (
            <span className="flex items-center gap-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11.5px] font-medium text-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber" aria-hidden />
              {t("miniClaudeConfirm")}
            </span>
          )}
        </div>
        {reconnecting && (
          <span className="absolute top-2 right-2 grid h-6 w-6 place-items-center rounded-md bg-black/65 text-white" title={t("reconnecting")}>
            <Loader2 size={13} aria-label={t("reconnecting")} className="animate-spin" />
          </span>
        )}

        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2.5 pt-5 pb-1.5 text-white">
          {sharer && <MonitorUp size={12} aria-hidden className="shrink-0" />}
          {!sharer && !shown.isMicrophoneEnabled && <MicOff size={12} aria-label={t("micOffFor", { name })} className="shrink-0" />}
          <span className="min-w-0 truncate text-[12px] font-medium">
            {sharer ? t("screenOf", { name }) : isLocal ? t("youLabel", { name }) : name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11.5px] text-white/85" title={t("peopleCount", { count })}>
            <Users size={12} aria-hidden />
            {count}
          </span>
        </div>
      </div>

      {toast && !confirmLeave && (
        <p role="status" className="border-t border-line px-3 py-1.5 text-[12px] leading-snug text-ink-soft">
          {toast}
        </p>
      )}

      {confirmLeave ? (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <span className="min-w-0 flex-1 text-[13px] text-ink">{t("miniLeaveConfirm")}</span>
          <button
            type="button"
            onClick={() => setConfirmLeave(false)}
            className="h-8 rounded-md px-2.5 text-[13px] font-medium text-ink-soft hover:bg-hover hover:text-ink"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => void room.disconnect(true)}
            className="h-8 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white hover:opacity-90"
          >
            {t("leaveShort")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-2">
          <button
            type="button"
            className={btn(lp.isMicrophoneEnabled)}
            onClick={onToggleMic}
            disabled={busy.mic}
            aria-pressed={lp.isMicrophoneEnabled}
            aria-label={lp.isMicrophoneEnabled ? t("turnOffMic") : t("turnOnMic")}
            title={lp.isMicrophoneEnabled ? t("turnOffMic") : t("turnOnMic")}
          >
            {lp.isMicrophoneEnabled ? <Mic size={16} aria-hidden /> : <MicOff size={16} aria-hidden />}
          </button>
          <button
            type="button"
            className={btn(lp.isCameraEnabled)}
            onClick={onToggleCam}
            disabled={busy.cam}
            aria-pressed={lp.isCameraEnabled}
            aria-label={lp.isCameraEnabled ? t("turnOffCamera") : t("turnOnCamera")}
            title={lp.isCameraEnabled ? t("turnOffCamera") : t("turnOnCamera")}
          >
            {lp.isCameraEnabled ? <Video size={16} aria-hidden /> : <VideoOff size={16} aria-hidden />}
          </button>
          {!room.canPlaybackAudio && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => void room.startAudio()}
              aria-label={t("enableAudio")}
              title={t("audioBlocked")}
            >
              <Volume2 size={16} aria-hidden />
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            className="icon-btn"
            onClick={() => router.push(meetHref(roomName))}
            aria-label={t("returnToCall")}
            title={t("returnToCall")}
          >
            <Maximize2 size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            className="grid h-9 w-11 place-items-center rounded-full bg-danger text-white transition-opacity hover:opacity-90"
            aria-label={t("leave")}
            title={t("leave")}
          >
            <PhoneOff size={16} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
