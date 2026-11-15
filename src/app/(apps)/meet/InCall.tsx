"use client";

import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type AudioTrack,
  type Participant,
  type RemoteParticipant,
} from "livekit-client";
import {
  LayoutGrid,
  LayoutPanelLeft,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Send,
  Settings2,
  Square,
  Users,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AudioView, Avatar, displayName, Tile, type TileSource } from "./media";
import { SELECT, useDevices } from "./PreJoin";
import { CHAT_MAX_LENGTH, CHAT_TOPIC, meetHref, type ChatMessage } from "./shared";

const ROOM_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ConnectionQualityChanged,
  RoomEvent.ConnectionStateChanged,
  RoomEvent.AudioPlaybackStatusChanged,
  RoomEvent.ActiveDeviceChanged,
] as const;

/** Re-renders whenever anything visible about the room changes. */
function useRoomVersion(room: Room) {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    for (const ev of ROOM_EVENTS) room.on(ev, bump);
    return () => {
      for (const ev of ROOM_EVENTS) room.off(ev, bump);
    };
  }, [room]);
  return version;
}

type TileInfo = { key: string; participant: Participant; source: TileSource; isLocal: boolean };
type Panel = "chat" | "people" | "settings" | null;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function mediaErrorKey(e: unknown): "permissionDenied" | "deviceMissing" | "deviceBusy" {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permissionDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "deviceMissing";
  return "deviceBusy";
}

export function InCall({ room, roomName }: { room: Room; roomName: string }) {
  const t = useTranslations("meet");
  useRoomVersion(room);
  const lp = room.localParticipant;
  const remotes = [...room.remoteParticipants.values()];
  const participants: Participant[] = [lp, ...remotes];

  const [layout, setLayout] = useState<"grid" | "speaker">("grid");
  const [panel, setPanel] = useState<Panel>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ mic?: boolean; cam?: boolean; screen?: boolean }>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef<Panel>(null);
  panelRef.current = panel;

  const flash = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // Device failures raised by LiveKit while (re)publishing.
  useEffect(() => {
    const onError = (e: Error) => flash(t(mediaErrorKey(e)));
    room.on(RoomEvent.MediaDevicesError, onError);
    return () => {
      room.off(RoomEvent.MediaDevicesError, onError);
    };
  }, [room, flash, t]);

  // Chat over the reliable data channel. Sender identity comes from LiveKit, never the payload.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== CHAT_TOPIC || !participant) return;
      try {
        const data = JSON.parse(decoder.decode(payload)) as { id?: unknown; text?: unknown };
        if (typeof data.text !== "string" || !data.text.trim()) return;
        const msg: ChatMessage = {
          id: typeof data.id === "string" ? data.id.slice(0, 64) : crypto.randomUUID(),
          from: participant.identity,
          name: displayName(participant),
          text: data.text.slice(0, CHAT_MAX_LENGTH),
          at: Date.now(),
          mine: false,
        };
        setMessages((m) => [...m.slice(-499), msg]);
        if (panelRef.current !== "chat") setUnread((n) => n + 1);
      } catch {
        // ignore malformed payloads
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  const sendChat = async (text: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: lp.identity,
      name: displayName(lp),
      text,
      at: Date.now(),
      mine: true,
    };
    await lp.publishData(encoder.encode(JSON.stringify({ id: msg.id, text })), { reliable: true, topic: CHAT_TOPIC });
    setMessages((m) => [...m.slice(-499), msg]);
  };

  const togglePanel = (p: Exclude<Panel, null>) => {
    setPanel((cur) => (cur === p ? null : p));
    if (p === "chat") setUnread(0);
  };

  // --- tiles & layout -----------------------------------------------------------------------
  const tiles: TileInfo[] = [];
  for (const p of participants) {
    const isLocal = p === lp;
    const screen = p.getTrackPublication(Track.Source.ScreenShare);
    if (screen && (isLocal || screen.track)) {
      tiles.push({ key: `${p.identity}:screen`, participant: p, source: Track.Source.ScreenShare, isLocal });
    }
  }
  const screenKeys = tiles.map((x) => x.key).join(",");
  for (const p of participants) {
    tiles.push({ key: `${p.identity}:camera`, participant: p, source: Track.Source.Camera, isLocal: p === lp });
  }

  // A new screen share jumps to speaker layout so the shared content is readable.
  useEffect(() => {
    if (screenKeys) setLayout("speaker");
  }, [screenKeys]);

  const speaker = room.activeSpeakers.find((p) => p !== lp) ?? remotes[0] ?? lp;
  const featured =
    tiles.find((x) => x.key === pinned) ??
    tiles.find((x) => x.source === Track.Source.ScreenShare) ??
    tiles.find((x) => x.participant === speaker && x.source === Track.Source.Camera) ??
    tiles[0];
  const effectiveLayout = tiles.length > 1 ? layout : "grid";

  const n = tiles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const colsSm = n <= 1 ? 1 : 2;

  // --- controls -----------------------------------------------------------------------------
  const run = async (key: "mic" | "cam" | "screen", fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
    } catch (e) {
      // The user dismissing the screen picker is not an error worth surfacing.
      if (!(key === "screen" && e instanceof Error && e.name === "NotAllowedError")) flash(t(mediaErrorKey(e)));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };
  const toggleMic = () => run("mic", () => lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled));
  const toggleCam = () => run("cam", () => lp.setCameraEnabled(!lp.isCameraEnabled));
  const toggleScreen = () =>
    run("screen", () => lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true, selfBrowserSurface: "exclude" }));
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(!!navigator.mediaDevices?.getDisplayMedia), []);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${meetHref(roomName)}`);
      flash(t("linkCopied"));
    } catch {
      flash(t("copyFailed"));
    }
  };

  // Meet-style shortcuts: Ctrl/Cmd+D mic, Ctrl/Cmd+E camera.
  const toggles = useRef({ toggleMic, toggleCam });
  toggles.current = { toggleMic, toggleCam };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "d") {
        e.preventDefault();
        void toggles.current.toggleMic();
      } else if (k === "e") {
        e.preventDefault();
        void toggles.current.toggleCam();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reconnecting =
    room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting;

  // Remote audio (mic + shared tab audio) is played through hidden elements.
  const audioTracks = remotes.flatMap((p) =>
    [...p.audioTrackPublications.values()]
      .filter((pub) => pub.track)
      .map((pub) => ({ key: `${p.identity}:${pub.trackSid}`, track: pub.track as AudioTrack })),
  );

  const ctrl = (on: boolean, danger = false) =>
    `grid h-11 w-11 place-items-center rounded-full border transition-colors duration-150 disabled:opacity-50 ${
      danger && !on
        ? "border-transparent bg-danger text-white hover:opacity-90"
        : on
          ? "border-transparent bg-primary-soft text-ink"
          : "border-line bg-sheet text-ink-soft hover:bg-hover hover:text-ink"
    }`;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {audioTracks.map((a) => (
        <AudioView key={a.key} track={a.track} />
      ))}

      {reconnecting && (
        <div role="status" className="flex items-center justify-center gap-2 border-b border-line bg-sheet-muted px-4 py-2 text-[13px] text-ink-soft">
          <Loader2 size={14} aria-hidden className="animate-spin" />
          {t("reconnecting")}
        </div>
      )}
      {!room.canPlaybackAudio && (
        <div className="flex items-center justify-center gap-3 border-b border-line bg-sheet-muted px-4 py-2 text-[13px] text-ink-soft">
          <Volume2 size={14} aria-hidden />
          {t("audioBlocked")}
          <button type="button" onClick={() => void room.startAudio()} className="font-medium text-ink underline underline-offset-2">
            {t("enableAudio")}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Stage */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2 md:p-3">
          {effectiveLayout === "grid" ? (
            <div
              className="grid min-h-0 flex-1 auto-rows-fr gap-2 [grid-template-columns:repeat(var(--cols-sm),minmax(0,1fr))] md:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
              style={{ "--cols": cols, "--cols-sm": colsSm } as React.CSSProperties}
            >
              {tiles.map((x) => (
                <div
                  key={x.key}
                  className="min-h-0"
                  onDoubleClick={() => {
                    setPinned(x.key);
                    setLayout("speaker");
                  }}
                >
                  <Tile participant={x.participant} source={x.source} isLocal={x.isLocal} compact={n > 6} />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 md:flex-row">
              <div className="min-h-0 min-w-0 flex-1">
                <Tile participant={featured.participant} source={featured.source} isLocal={featured.isLocal} />
              </div>
              <div className="flex shrink-0 gap-2 overflow-x-auto md:w-52 md:flex-col md:overflow-x-hidden md:overflow-y-auto">
                {tiles
                  .filter((x) => x.key !== featured.key)
                  .map((x) => (
                    <button
                      key={x.key}
                      type="button"
                      onClick={() => setPinned(pinned === x.key ? null : x.key)}
                      aria-pressed={pinned === x.key}
                      aria-label={t("pinTile", { name: displayName(x.participant) })}
                      className="aspect-video w-40 shrink-0 text-left md:w-full"
                    >
                      <Tile participant={x.participant} source={x.source} isLocal={x.isLocal} compact />
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Side panel */}
        {panel && (
          <aside className="absolute inset-0 z-10 flex flex-col bg-sheet md:static md:w-80 md:shrink-0 md:border-l md:border-line">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-line pr-2 pl-4">
              <h2 className="text-[14px] font-medium text-ink">
                {panel === "chat"
                  ? t("chat")
                  : panel === "people"
                    ? t("peopleCount", { count: participants.length })
                    : t("settings")}
              </h2>
              <button type="button" className="icon-btn" onClick={() => setPanel(null)} aria-label={t("closePanel")}>
                <X size={16} aria-hidden />
              </button>
            </div>
            {panel === "chat" && <ChatPanel messages={messages} onSend={sendChat} />}
            {panel === "people" && <PeoplePanel participants={participants} local={lp} />}
            {panel === "settings" && <SettingsPanel room={room} />}
          </aside>
        )}
      </div>

      {/* Controls */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2.5">
        <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
          <span className="truncate font-mono text-[13px] text-ink-soft">{roomName}</span>
          <button type="button" className="icon-btn" onClick={copyInvite} aria-label={t("copyInvite")} title={t("copyInvite")}>
            <Link2 size={16} aria-hidden />
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center gap-2 md:flex-none">
          <button
            type="button"
            className={ctrl(lp.isMicrophoneEnabled, true)}
            onClick={toggleMic}
            disabled={busy.mic}
            aria-pressed={lp.isMicrophoneEnabled}
            aria-label={lp.isMicrophoneEnabled ? t("turnOffMic") : t("turnOnMic")}
            title={`${lp.isMicrophoneEnabled ? t("turnOffMic") : t("turnOnMic")} (Ctrl+D)`}
          >
            {lp.isMicrophoneEnabled ? <Mic size={18} aria-hidden /> : <MicOff size={18} aria-hidden />}
          </button>
          <button
            type="button"
            className={ctrl(lp.isCameraEnabled, true)}
            onClick={toggleCam}
            disabled={busy.cam}
            aria-pressed={lp.isCameraEnabled}
            aria-label={lp.isCameraEnabled ? t("turnOffCamera") : t("turnOnCamera")}
            title={`${lp.isCameraEnabled ? t("turnOffCamera") : t("turnOnCamera")} (Ctrl+E)`}
          >
            {lp.isCameraEnabled ? <Video size={18} aria-hidden /> : <VideoOff size={18} aria-hidden />}
          </button>
          {canShare && (
            <button
              type="button"
              className={ctrl(lp.isScreenShareEnabled)}
              onClick={toggleScreen}
              disabled={busy.screen}
              aria-pressed={lp.isScreenShareEnabled}
              aria-label={lp.isScreenShareEnabled ? t("stopSharing") : t("shareScreen")}
              title={lp.isScreenShareEnabled ? t("stopSharing") : t("shareScreen")}
            >
              {lp.isScreenShareEnabled ? <Square size={16} aria-hidden /> : <MonitorUp size={18} aria-hidden />}
            </button>
          )}
          <button
            type="button"
            className={ctrl(effectiveLayout === "speaker")}
            onClick={() => {
              setPinned(null);
              setLayout(layout === "grid" ? "speaker" : "grid");
            }}
            disabled={tiles.length < 2}
            aria-label={layout === "grid" ? t("speakerLayout") : t("gridLayout")}
            title={layout === "grid" ? t("speakerLayout") : t("gridLayout")}
          >
            {layout === "grid" ? <LayoutPanelLeft size={17} aria-hidden /> : <LayoutGrid size={17} aria-hidden />}
          </button>
          <button
            type="button"
            onClick={() => void room.disconnect(true)}
            className="grid h-11 w-14 place-items-center rounded-full bg-danger text-white transition-opacity hover:opacity-90"
            aria-label={t("leave")}
            title={t("leave")}
          >
            <PhoneOff size={18} aria-hidden />
          </button>
        </div>

        <div className="flex items-center justify-end gap-1 md:flex-1">
          <button type="button" className="icon-btn md:hidden" onClick={copyInvite} aria-label={t("copyInvite")}>
            <Link2 size={17} aria-hidden />
          </button>
          <button
            type="button"
            className={`icon-btn ${panel === "people" ? "!bg-primary-soft !text-ink" : ""}`}
            onClick={() => togglePanel("people")}
            aria-pressed={panel === "people"}
            aria-label={t("people")}
            title={t("people")}
          >
            <span className="relative">
              <Users size={18} aria-hidden />
              <span className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-sheet-muted px-1 text-center text-[10px] leading-4 font-medium text-ink-soft">
                {participants.length}
              </span>
            </span>
          </button>
          <button
            type="button"
            className={`icon-btn ${panel === "chat" ? "!bg-primary-soft !text-ink" : ""}`}
            onClick={() => togglePanel("chat")}
            aria-pressed={panel === "chat"}
            aria-label={unread ? t("chatUnread", { count: unread }) : t("chat")}
            title={t("chat")}
          >
            <span className="relative">
              <MessageSquare size={18} aria-hidden />
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-sheet" style={{ background: "var(--color-app-meet)" }} />
              )}
            </span>
          </button>
          <button
            type="button"
            className={`icon-btn ${panel === "settings" ? "!bg-primary-soft !text-ink" : ""}`}
            onClick={() => togglePanel("settings")}
            aria-pressed={panel === "settings"}
            aria-label={t("settings")}
            title={t("settings")}
          >
            <Settings2 size={18} aria-hidden />
          </button>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          className="pop pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2 px-4 py-2 text-[13px] text-ink"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function ChatPanel({ messages, onSend }: { messages: ChatMessage[]; onSend: (text: string) => Promise<void> }) {
  const t = useTranslations("meet");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await onSend(text);
      setDraft("");
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const time = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }), []);

  return (
    <>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? (
          <p className="m-auto max-w-[220px] text-center text-[13px] leading-relaxed text-ink-mute">{t("chatEmpty")}</p>
        ) : (
          messages.map((m, i) => {
            const grouped = i > 0 && messages[i - 1].from === m.from && m.at - messages[i - 1].at < 60_000;
            return (
              <div key={m.id + i} className={grouped ? "-mt-2" : ""}>
                {!grouped && (
                  <p className="mb-0.5 flex items-baseline gap-2 text-[12px]">
                    <span className="font-medium text-ink">{m.mine ? t("you") : m.name}</span>
                    <span className="text-ink-mute">{time.format(m.at)}</span>
                  </p>
                )}
                <p className="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink-soft">{m.text}</p>
              </div>
            );
          })
        )}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-1.5 focus-within:border-ink-mute">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            maxLength={CHAT_MAX_LENGTH}
            placeholder={t("chatPlaceholder")}
            aria-label={t("chatPlaceholder")}
            className="max-h-32 min-h-7 flex-1 resize-none bg-transparent py-1 text-[14px] text-ink outline-none placeholder:text-ink-mute"
          />
          <button type="submit" className="icon-btn !h-7 !w-7" disabled={!draft.trim() || sending} aria-label={t("send")}>
            <Send size={15} aria-hidden />
          </button>
        </div>
        {failed && <p className="mt-1.5 text-[12px] text-danger">{t("sendFailed")}</p>}
      </form>
    </>
  );
}

function PeoplePanel({ participants, local }: { participants: Participant[]; local: Participant }) {
  const t = useTranslations("meet");
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-2">
      {participants.map((p) => {
        const name = displayName(p);
        return (
          <li key={p.identity} className="flex items-center gap-3 rounded-md px-2 py-2">
            <span className={`rounded-full ${p.isSpeaking ? "shadow-[0_0_0_2px_var(--color-app-meet)]" : ""}`}>
              <Avatar name={name} seed={p.identity} size={32} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{p === local ? t("youLabel", { name }) : name}</span>
              {p.identity !== name && <span className="block truncate text-[12px] text-ink-mute">{p.identity}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-ink-mute">
              {p.isScreenShareEnabled && <MonitorUp size={14} aria-label={t("sharingScreen")} />}
              {p.isCameraEnabled ? <Video size={14} aria-label={t("cameraOn")} /> : <VideoOff size={14} aria-label={t("cameraOff")} />}
              {p.isMicrophoneEnabled ? <Mic size={14} aria-label={t("micOn")} /> : <MicOff size={14} aria-label={t("micOff")} />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SettingsPanel({ room }: { room: Room }) {
  const t = useTranslations("meet");
  const { mics, cams } = useDevices(true);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setOutputs(list.filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default")))
      .catch(() => setOutputs([]));
  }, []);
  const active = (kind: MediaDeviceKind) => room.getActiveDevice(kind) ?? "";
  const change = (kind: MediaDeviceKind, id: string) => void room.switchActiveDevice(kind, id).catch(() => undefined);

  const picker = (kind: MediaDeviceKind, label: string, list: MediaDeviceInfo[], fallback: (n: number) => string) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-mute">{label}</span>
      <select value={active(kind)} onChange={(e) => change(kind, e.target.value)} disabled={!list.length} className={SELECT}>
        {!list.some((d) => d.deviceId === active(kind)) && <option value={active(kind)}>{t("defaultDevice")}</option>}
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || fallback(i + 1)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      {picker("audioinput", t("microphone"), mics, (n) => t("micN", { n }))}
      {picker("videoinput", t("camera"), cams, (n) => t("cameraN", { n }))}
      {outputs.length > 0 && picker("audiooutput", t("speakers"), outputs, (n) => t("speakerN", { n }))}
    </div>
  );
}
