"use client";

// A connected chat voice channel (MeetingProvider renders this instead of InCall): plays the
// room's audio (muted while deafened), reports presence to /api/chat/voice and, outside Chat,
// shows a small floating "Voice connected" bar. No recording, Claude, stage or video here.
import { DisconnectReason, RoomEvent, type AudioTrack, type Room } from "livekit-client";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { VoiceControls } from "../chat/VoicePanel";
import { VOICE_HEARTBEAT_MS, voiceChannelOf } from "../chat/shared";
import { useMeeting } from "./MeetingProvider";
import { AudioView, useRoomVersion } from "./media";

type Report = "join" | "state" | "beat" | "sync" | "leave";

// Reports go out in order (a quick leave + join must not arrive swapped).
let queue: Promise<unknown> = Promise.resolve();
function report(conversationId: string, action: Report, flags: { muted: boolean; deafened: boolean }) {
  queue = queue
    .then(() =>
      fetch("/api/chat/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, action, ...flags }),
        keepalive: action === "leave",
      }),
    )
    .catch(() => {});
}

export function VoiceSession({ room, roomName, label }: { room: Room; roomName: string; label: string }) {
  const pathname = usePathname();
  const { voice, leave } = useMeeting();
  useRoomVersion(room);
  const id = voiceChannelOf(roomName);

  const muted = !room.localParticipant.isMicrophoneEnabled;
  const flags = useRef({ muted, deafened: voice.deafened });
  flags.current = { muted, deafened: voice.deafened };

  // join / heartbeat / sync on room changes / leave (also when the tab closes).
  useEffect(() => {
    if (!id) return;
    // Kicked because this identity connected again elsewhere: that connection already reported
    // its join, so a "leave" from here would drop it from the roster.
    let replaced = false;
    const onDisconnected = (reason?: DisconnectReason) => {
      replaced = reason === DisconnectReason.DUPLICATE_IDENTITY;
    };
    room.once(RoomEvent.Disconnected, onDisconnected);
    report(id, "join", flags.current);
    const beat = setInterval(() => report(id, "beat", flags.current), VOICE_HEARTBEAT_MS);
    const sync = () => report(id, "sync", flags.current);
    const onHide = () => navigator.sendBeacon("/api/chat/voice", JSON.stringify({ conversationId: id, action: "leave" }));
    room.on(RoomEvent.ParticipantConnected, sync).on(RoomEvent.ParticipantDisconnected, sync);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(beat);
      room.off(RoomEvent.ParticipantConnected, sync).off(RoomEvent.ParticipantDisconnected, sync);
      window.removeEventListener("pagehide", onHide);
      room.off(RoomEvent.Disconnected, onDisconnected);
      if (!replaced) report(id, "leave", flags.current);
    };
  }, [id, room]);

  // One voice channel per person: joining one in another tab disconnects this tab.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("zw-voice");
    bc.onmessage = (e: MessageEvent<{ room?: string }>) => {
      if (e.data?.room && e.data.room !== roomName) void leave();
    };
    bc.postMessage({ room: roomName });
    return () => bc.close();
  }, [roomName, leave]);

  // Deafened means no mic, even if the initial mic publish lands after deafening.
  useEffect(() => {
    if (voice.deafened && room.localParticipant.isMicrophoneEnabled) void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
  }, [voice.deafened, muted, room]);

  // Mute / deafen changes.
  const sentFlags = useRef<string | null>(null);
  useEffect(() => {
    const key = `${muted}:${voice.deafened}`;
    if (sentFlags.current === null) sentFlags.current = key;
    else if (sentFlags.current !== key && id) {
      sentFlags.current = key;
      report(id, "state", { muted, deafened: voice.deafened });
    }
  }, [id, muted, voice.deafened]);

  // Mic denied / missing: stay connected, listen-only.
  const { setMicBlocked } = voice;
  useEffect(() => {
    const onError = () => setMicBlocked(true);
    room.on(RoomEvent.MediaDevicesError, onError);
    return () => {
      room.off(RoomEvent.MediaDevicesError, onError);
    };
  }, [room, setMicBlocked]);

  const audioTracks = [...room.remoteParticipants.values()].flatMap((p) =>
    [...p.audioTrackPublications.values()]
      .filter((pub) => pub.track)
      .map((pub) => ({ key: `${p.identity}:${pub.trackSid}`, track: pub.track as AudioTrack })),
  );

  return (
    <>
      {audioTracks.map((a) => (
        <AudioView key={a.key} track={a.track} muted={voice.deafened} />
      ))}
      {/* In Chat the sidebar (or, on phones, the conversation's header strip) shows the same controls. */}
      {!pathname.startsWith("/chat") &&
        createPortal(
          <div
            role="region"
            aria-label={label}
            className="pop fixed right-2 bottom-[calc(1rem+env(safe-area-inset-bottom))] left-2 z-[85] flex min-h-12 items-center px-2 py-1.5 md:right-auto md:left-[80px] md:w-[320px]"
          >
            <VoiceControls />
          </div>,
          document.body,
        )}
    </>
  );
}
