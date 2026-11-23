"use client";

// Voice channels: the "Voice connected" controls (chat sidebar footer and the floating bar
// outside Chat) and the roster of who is connected under each voice channel row.
import type { Room } from "livekit-client";
import { Headphones, HeadphoneOff, Loader2, Mic, MicOff, PhoneOff, Volume2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useReducer, useState } from "react";
import { useMeeting } from "../meet/MeetingProvider";
import { OPEN_CONVERSATION_EVENT, voiceChannelOf, type VoiceParticipant } from "./shared";
import { Avatar } from "./ui";

/** What the live room says about the voice channel I'm in (only people connected see this). */
export type VoiceLive = {
  conversationId: string;
  /** Lowercased emails (LiveKit identities) of who is speaking now. */
  speaking: Set<string>;
  /** Lowercased email → mic off. */
  muted: Map<string, boolean>;
  self: { email: string; name: string; deafened: boolean };
};

/** Re-renders on the room changes the voice UI shows (speakers, mutes, joins). */
function useVoiceRoomVersion(room: Room | null) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!room) return;
    let off = () => {};
    let disposed = false;
    // livekit-client stays out of the Chat bundle: the room exists only once a call loaded it.
    void import("livekit-client").then(({ RoomEvent }) => {
      if (disposed) return;
      const events = [
        RoomEvent.ActiveSpeakersChanged,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.AudioPlaybackStatusChanged,
        RoomEvent.ConnectionStateChanged,
      ] as const;
      for (const ev of events) room.on(ev, bump);
      off = () => {
        for (const ev of events) room.off(ev, bump);
      };
    });
    return () => {
      disposed = true;
      off();
    };
  }, [room]);
}

/** The voice channel I'm connected to, live; null when I'm not in one. */
export function useVoiceRoom(): VoiceLive | null {
  const { call, voice } = useMeeting();
  const room = call?.kind === "voice" ? call.room : null;
  useVoiceRoomVersion(room);
  const id = call && room ? voiceChannelOf(call.roomName) : null;
  if (!room || !id) return null;
  const lp = room.localParticipant;
  const speaking = new Set(room.activeSpeakers.map((p) => p.identity.toLowerCase()));
  const muted = new Map<string, boolean>();
  for (const p of [lp, ...room.remoteParticipants.values()]) muted.set(p.identity.toLowerCase(), !p.isMicrophoneEnabled);
  return { conversationId: id, speaking, muted, self: { email: lp.identity, name: lp.name || lp.identity, deafened: voice.deafened } };
}

const BTN = "icon-btn h-8 w-8 max-sm:h-10 max-sm:w-10 aria-pressed:text-danger";

/** "Voice connected · <channel>" with mic, deafen and disconnect. Renders nothing when not in voice. */
export function VoiceControls() {
  const t = useTranslations("chat");
  const router = useRouter();
  const pathname = usePathname();
  const { call, joiningRoom, error, voice, leave } = useMeeting();
  const live = useVoiceRoom();
  const [hiddenError, setHiddenError] = useState<object | null>(null);
  const [busy, setBusy] = useState(false);

  const joiningId = joiningRoom ? voiceChannelOf(joiningRoom) : null;
  if (!live || call?.kind !== "voice") {
    if (joiningId)
      return (
        <p role="status" className="flex h-8 items-center gap-2 px-1 text-[12.5px] text-ink-mute">
          <Loader2 size={14} aria-hidden className="animate-spin" />
          {t("connectingVoice")}
        </p>
      );
    if (error && voiceChannelOf(error.roomName) && hiddenError !== error)
      return (
        <p role="alert" className="flex items-start gap-2 px-1 text-[12.5px] leading-snug text-danger">
          <span className="min-w-0 flex-1">{error.message}</span>
          <button type="button" className="icon-btn h-6 w-6 shrink-0" onClick={() => setHiddenError(error)} aria-label={t("close")}>
            <X size={13} aria-hidden />
          </button>
        </p>
      );
    return null;
  }

  const room = call.room;
  const lp = room.localParticipant;
  const micOn = lp.isMicrophoneEnabled;
  const openText = () => {
    if (pathname.startsWith("/chat")) window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: live.conversationId }));
    else router.push(`/chat?c=${live.conversationId}`);
  };
  const setMic = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (on && voice.deafened) voice.setDeafened(false);
      await lp.setMicrophoneEnabled(on);
      voice.setMicBlocked(false);
    } catch {
      if (on) voice.setMicBlocked(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={openText}
          title={t("openTextChat")}
          className="flex min-w-0 flex-1 flex-col items-start rounded-md px-1 py-0.5 text-left hover:bg-hover"
        >
          <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-signal">
            <Volume2 size={13} aria-hidden />
            {t("voiceConnected")}
          </span>
          <span className="w-full truncate text-[12px] text-ink-mute">{call.label}</span>
        </button>
        {!room.canPlaybackAudio && (
          <button type="button" className={BTN} onClick={() => void room.startAudio()} aria-label={t("enableAudio")} title={t("enableAudio")}>
            <Volume2 size={16} aria-hidden className="text-amber" />
          </button>
        )}
        <button
          type="button"
          className={BTN}
          disabled={busy}
          onClick={() => void setMic(!micOn)}
          aria-pressed={!micOn}
          aria-label={micOn ? t("mute") : t("unmute")}
          title={micOn ? t("mute") : t("unmute")}
        >
          {micOn ? <Mic size={16} aria-hidden /> : <MicOff size={16} aria-hidden />}
        </button>
        <button
          type="button"
          className={BTN}
          onClick={() => voice.setDeafened(!voice.deafened)}
          aria-pressed={voice.deafened}
          aria-label={voice.deafened ? t("undeafen") : t("deafen")}
          title={voice.deafened ? t("undeafen") : t("deafen")}
        >
          {voice.deafened ? <HeadphoneOff size={16} aria-hidden /> : <Headphones size={16} aria-hidden />}
        </button>
        <button
          type="button"
          className="icon-btn h-8 w-8 hover:text-danger max-sm:h-10 max-sm:w-10"
          onClick={() => void leave()}
          aria-label={t("disconnect")}
          title={t("disconnect")}
        >
          <PhoneOff size={16} aria-hidden />
        </button>
      </div>
      {voice.micBlocked && (
        <p role="status" className="mt-1 flex flex-wrap items-center gap-x-2 px-1 text-[11.5px] leading-snug text-amber">
          {t("micBlocked")}
          <button type="button" onClick={() => void setMic(true)} className="font-medium text-ink underline underline-offset-2">
            {t("retryMic")}
          </button>
        </p>
      )}
    </div>
  );
}

/** Who is connected to a voice channel, under its row. `live` (my own channel) adds speaking rings. */
export function VoiceRoster({ participants, live }: { participants: VoiceParticipant[]; live: VoiceLive | null }) {
  const t = useTranslations("chat");
  let list = participants;
  // I'm connected but the server's update hasn't arrived yet: show me right away.
  if (live && !list.some((p) => p.email.toLowerCase() === live.self.email.toLowerCase()))
    list = [...list, { userId: 0, name: live.self.name, email: live.self.email, muted: false, deafened: false, since: Date.now() }];
  if (!list.length) return null;
  return (
    <ul className="space-y-px pb-1">
      {list.map((p) => {
        const email = p.email.toLowerCase();
        const muted = live?.muted.get(email) ?? p.muted;
        const deafened = live && email === live.self.email.toLowerCase() ? live.self.deafened : p.deafened;
        const speaking = !!live?.speaking.has(email) && !muted;
        return (
          <li key={email} className="flex h-7 items-center gap-2 pr-2 pl-12">
            <span
              className={`rounded-full ring-offset-1 ring-offset-sheet transition-shadow duration-150 ${speaking ? "ring-2 ring-signal" : "ring-0"}`}
            >
              <Avatar name={p.name} email={p.email} size={20} />
            </span>
            <span className={`min-w-0 flex-1 truncate text-[12.5px] ${speaking ? "text-ink" : "text-ink-soft"}`}>{p.name}</span>
            {/* Deafened implies muted: show only the stronger state, as Discord does. */}
            {deafened ? (
              <HeadphoneOff size={13} role="img" className="shrink-0 text-ink-mute" aria-label={t("deafenedLabel")} />
            ) : (
              muted && <MicOff size={13} role="img" className="shrink-0 text-ink-mute" aria-label={t("mutedLabel")} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
