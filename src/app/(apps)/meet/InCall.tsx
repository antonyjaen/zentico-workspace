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
  Check,
  CircleDot,
  Clapperboard,
  FileText,
  LayoutGrid,
  LayoutPanelLeft,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  Presentation,
  PhoneOff,
  Send,
  Settings2,
  Sparkles,
  Square,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "@/components/usePopover";
import { AddPeopleDialog } from "./AddPeopleDialog";
import { ClaudeConfirmations, ClaudeListeningBanner, ClaudePanel, useToolLabel } from "./ClaudePanel";
import { AudioView, Avatar, displayName, Tile, useRoomVersion, type TileSource } from "./media";
import { MiniCall } from "./MiniCall";
import { SELECT, useDevices } from "./PreJoin";
import { clock } from "./recording";
import { CHAT_MAX_LENGTH, CHAT_TOPIC, meetHref, type ChatMessage } from "./shared";
import { useClaudeCommands, type ClaudeNotice } from "./useClaudeCommands";
import { useClaudeVoice } from "./useClaudeVoice";
import { StageView } from "./StageView";
import { STAGE_VIEW_PREF, type StageView as StageViewMode } from "./stage-types";
import { useStage } from "./useStage";
import {
  recordingSupported,
  useRecording,
  type ActiveRecording,
  type RecordingMode,
  type RecordingNotice,
} from "./useRecording";

type TileInfo = { key: string; participant: Participant; source: TileSource; isLocal: boolean };
type Panel = "chat" | "people" | "settings" | "claude" | null;

function readStageView(): StageViewMode {
  try {
    const v = localStorage.getItem(STAGE_VIEW_PREF);
    return v === "side" || v === "hidden" ? v : "stage";
  } catch {
    return "stage";
  }
}

function writeStageView(v: StageViewMode) {
  try {
    localStorage.setItem(STAGE_VIEW_PREF, v);
  } catch {
    // blocked storage: the choice just isn't remembered
  }
}

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function mediaErrorKey(e: unknown): "permissionDenied" | "deviceMissing" | "deviceBusy" {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permissionDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "deviceMissing";
  return "deviceBusy";
}

export function InCall({
  room,
  roomName,
  videoRecording,
  host,
  onPage,
}: {
  room: Room;
  roomName: string;
  videoRecording: boolean;
  /** Node the full call view renders into (moved into the meeting page by MeetingProvider). */
  host: HTMLElement;
  /** The meeting page is showing the full view; otherwise a floating mini window is shown. */
  onPage: boolean;
}) {
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
  const [inviting, setInviting] = useState(false);
  const panelRef = useRef<Panel>(null);
  panelRef.current = panel;
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;

  const flash = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // Recording: consent notices for everyone, start/stop for the local user.
  const onRecordingNotice = useCallback(
    (n: RecordingNotice) =>
      flash(
        n.kind === "started"
          ? n.mine
            ? t("recStartedSelf")
            : t("recStartedBy", { name: n.name })
          : n.kind === "stopped"
            ? t("recStopped")
            : t(`rec_${n.kind}`),
      ),
    [flash, t],
  );
  const recording = useRecording(room, roomName, onRecordingNotice);
  const [canRecord, setCanRecord] = useState(false);
  useEffect(() => setCanRecord(recordingSupported()), []);
  // With video available, starting asks "Transcript only" vs "Video + transcript".
  const recMenu = usePopover<HTMLSpanElement>();
  const startRecording = (mode: RecordingMode) => {
    recMenu.setOpen(false);
    void recording.start(mode);
  };

  // Claude's short spoken replies, heard by everyone (each device can mute them).
  const locale = useLocale();
  const voice = useClaudeVoice(room, locale);
  const { announce: announceVoice, stopMine: stopMyVoice, sayLocal, hush } = voice;

  // "Claude commands": the local user's own push-to-talk / typed requests for their own Claude Code,
  // optionally with the meeting's audio as context.
  const onClaudeNotice = useCallback(
    (n: ClaudeNotice) => {
      if (n.kind === "done") {
        flash(t("claudeDone", { text: n.command.text.slice(0, 60) }));
        announceVoice(n.command);
      } else if (n.kind === "cancelled") {
        stopMyVoice();
        flash(t("claudeAction_cancelled"));
      } else if (n.kind === "failed") flash(t("claudeFailed", { text: n.command.text.slice(0, 60) }));
      else if (n.kind === "queued") flash(t("claudeQueued", { text: n.command.text.slice(0, 60) }));
      else if (n.kind === "noToken") flash(t("claudeNeedToken"));
      else if (n.kind === "notConfigured") flash(t("claudeNotConfigured"));
      else if (n.kind === "unsupported") flash(t("claudeUnsupported"));
      else if (n.kind === "tooShort") flash(t("claudeTalkTooShort"));
      else if (n.kind === "nothingHeard") flash(t("claudeHeardNothing"));
      else if (n.kind === "micFailed") flash(t("claudeMicFailed"));
      else if (n.kind === "listenStarted") flash(t("claudeListenStartedBy", { name: n.name }));
      else if (n.kind !== "error") flash(t(`claudeAction_${n.kind}`));
    },
    [flash, t, announceVoice, stopMyVoice],
  );
  const claude = useClaudeCommands(room, roomName, {
    panelOpen: onPage && panel === "claude",
    notify: onClaudeNotice,
    onTalk: hush,
    hotkey: onPage,
  });

  // The live stage: whiteboards and cards shared with everyone in the call (and their agents).
  const stage = useStage(room, roomName);
  const [stageView, setStageViewState] = useState<StageViewMode>("stage");
  /** The last visible layout, restored when the stage comes back. */
  const [stageShown, setStageShown] = useState<Exclude<StageViewMode, "hidden">>("stage");
  useEffect(() => {
    const v = readStageView();
    setStageViewState(v);
    if (v !== "hidden") setStageShown(v);
  }, []);
  const setStageView = useCallback((v: StageViewMode) => {
    setStageViewState(v);
    if (v !== "hidden") setStageShown(v);
    writeStageView(v);
  }, []);
  const wide = useMediaQuery("(min-width: 1024px)");
  const phone = useMediaQuery("(max-width: 767px)");
  const stageItems = stage.data.items.length;
  const stageFocus = stage.data.focus;
  /** Someone shares their screen (set while rendering the tiles below). */
  const sharing = useRef(false);
  /** The stage changed while hidden behind a screen share: the stage button shows a dot. */
  const [stageNews, setStageNews] = useState(false);
  // A stage that opens, or something brought to the front, is featured like a screen share, but
  // never over a real one (then only the stage button lights up).
  const stageSeen = useRef<{ items: number; focus: string | null } | null>(null);
  useEffect(() => {
    if (!stage.data.loaded) return;
    const prev = stageSeen.current;
    stageSeen.current = { items: stageItems, focus: stageFocus };
    if (!prev) return;
    if ((prev.items === 0 && stageItems > 0) || (stageFocus && stageFocus !== prev.focus)) {
      if (sharing.current) setStageNews(true);
      else setStageViewState((v) => (v === "hidden" ? stageShown : v));
    }
  }, [stage.data.loaded, stageItems, stageFocus, stageShown]);
  const stageOpen = stage.data.open && stageItems > 0;
  const stageVisible = stageOpen && stageView !== "hidden" && !stage.data.disabled;
  useEffect(() => {
    if (stageVisible) setStageNews(false);
  }, [stageVisible]);
  const stageMenu = usePopover<HTMLSpanElement>();
  const openStage = () => {
    stageMenu.setOpen(false);
    if (stageOpen) return setStageView(stageShown);
    void stage
      .send([{ op: "item.add", item: { kind: "board", title: t("stageKind_board") } }])
      .then(() => setStageView(stageShown))
      .catch(() => flash(t("stageFailed")));
  };

  // The proactive assistant is announced to everyone: a line in the chat and one spoken notice.
  const assistSince = stage.data.assist?.since ?? null;
  const assistInfo = useRef(stage.data.assist);
  assistInfo.current = stage.data.assist;
  const announcedAssist = useRef<number | null>(null);
  useEffect(() => {
    const a = assistInfo.current;
    if (!assistSince || !a || announcedAssist.current === assistSince) return;
    announcedAssist.current = assistSince;
    const text = t("stageAssistChat", { name: a.ownerName, assistant: a.agent });
    setMessages((m) => [...m.slice(-499), { id: `assist-${assistSince}`, from: "", name: t("stageSystem"), text, at: assistSince, mine: false }]);
    if (Date.now() - assistSince < 60_000) sayLocal(`assist-${assistSince}`, text, locale);
  }, [assistSince, sayLocal, t, locale]);

  // A write action waiting for the local user's OK is announced on their own device only.
  const toolLabel = useToolLabel();
  const confirmSeen = useRef<Set<string> | null>(null);
  const confirmations = claude.data?.confirmations;
  useEffect(() => {
    if (!confirmations) return;
    const first = confirmSeen.current == null;
    const seenIds = (confirmSeen.current ??= new Set());
    for (const c of confirmations) {
      if (seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      if (!first) sayLocal(`cf-${c.id}`, t("claudeConfirmSpoken", { action: toolLabel(c.tool) }), locale);
    }
  }, [confirmations, sayLocal, t, toolLabel, locale]);

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
        if (panelRef.current !== "chat" || !onPageRef.current) setUnread((n) => n + 1);
        // Minimised: the mini window shows the message as a toast.
        if (!onPageRef.current) flash(`${msg.name}: ${msg.text.slice(0, 80)}`);
      } catch {
        // ignore malformed payloads
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, flash]);

  // Coming back with the chat open marks what arrived meanwhile as read.
  useEffect(() => {
    if (onPage && panelRef.current === "chat") setUnread(0);
  }, [onPage]);

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
  const screenTile = screenKeys ? tiles[0] : null;
  sharing.current = !!screenKeys;
  for (const p of participants) {
    tiles.push({ key: `${p.identity}:camera`, participant: p, source: Track.Source.Camera, isLocal: p === lp });
  }

  // A new screen share jumps to speaker layout so the shared content is readable; a visible stage
  // makes room for it (side by side on wide screens, else hidden) without changing the saved choice.
  useEffect(() => {
    if (!screenKeys) return;
    setLayout("speaker");
    setStageViewState((v) => (v === "hidden" ? v : wide ? "side" : "hidden"));
    // Only when a share starts or changes, not when the window is resized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKeys]);
  const shareBesideStage = stageView === "side" && wide && !!screenTile;

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

  // Meet-style shortcuts: Ctrl/Cmd+D mic, Ctrl/Cmd+E camera — only on the meeting page, so other
  // apps keep their own keys.
  const toggles = useRef({ toggleMic, toggleCam });
  toggles.current = { toggleMic, toggleCam };
  useEffect(() => {
    if (!onPage) return;
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
  }, [onPage]);

  // Dialogs and menus of the full view don't stay open behind the mini window.
  const closeRecMenu = recMenu.setOpen;
  useEffect(() => {
    if (onPage) return;
    setInviting(false);
    closeRecMenu(false);
  }, [onPage, closeRecMenu]);

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

  const callView = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {reconnecting && (
        <div role="status" className="flex items-center justify-center gap-2 border-b border-line bg-sheet-muted px-4 py-2 text-[13px] text-ink-soft">
          <Loader2 size={14} aria-hidden className="animate-spin" />
          {t("reconnecting")}
        </div>
      )}
      {recording.active && (
        <RecordingBanner active={recording.active} busy={recording.busy} onStop={() => void recording.stop()} />
      )}
      <ClaudeListeningBanner claude={claude} />
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
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2 md:p-3">
          <ClaudeConfirmations claude={claude} voice={voice} showTalk={panel !== "claude"} />
          {stageVisible ? (
            <div className={`flex min-h-0 flex-1 gap-2 ${stageView === "side" && wide ? "flex-row" : "flex-col md:flex-row"}`}>
              <div className={`min-h-0 min-w-0 ${shareBesideStage ? "basis-1/2" : stageView === "side" && wide ? "basis-2/3" : "flex-1"}`}>
                <StageView
                  stage={stage}
                  me={lp.identity}
                  bridgeConnected={!!claude.data?.bridge.connected}
                  onStartListening={() => claude.setListen(true)}
                  flash={flash}
                  compact={phone}
                />
              </div>
              {shareBesideStage && screenTile ? (
                // A screen share next to the stage: large, with the other tiles in a strip below.
                <div className="flex min-h-0 min-w-0 basis-1/2 flex-col gap-2">
                  <div className="min-h-0 flex-1">
                    <Tile participant={screenTile.participant} source={screenTile.source} isLocal={screenTile.isLocal} />
                  </div>
                  <div className="flex h-24 shrink-0 gap-2 overflow-x-auto">
                    {tiles
                      .filter((x) => x.key !== screenTile.key)
                      .map((x) => (
                        <div key={x.key} className="aspect-video h-full shrink-0">
                          <Tile participant={x.participant} source={x.source} isLocal={x.isLocal} compact />
                        </div>
                      ))}
                  </div>
                </div>
              ) : (
                !phone && (
                  <div
                    className={
                      stageView === "side" && wide
                        ? "grid min-h-0 basis-1/3 auto-rows-fr gap-2 overflow-y-auto [grid-template-columns:repeat(var(--cols-side),minmax(0,1fr))]"
                        : "flex shrink-0 gap-2 overflow-x-auto md:w-52 md:flex-col md:overflow-x-hidden md:overflow-y-auto"
                    }
                    style={{ "--cols-side": n > 4 ? 2 : 1 } as React.CSSProperties}
                  >
                    {tiles.map((x) => (
                      <div key={x.key} className={stageView === "side" && wide ? "min-h-0" : "aspect-video w-40 shrink-0 md:w-full"}>
                        <Tile participant={x.participant} source={x.source} isLocal={x.isLocal} compact />
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          ) : effectiveLayout === "grid" ? (
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
                    : panel === "claude"
                      ? t("myClaude")
                      : t("settings")}
              </h2>
              <button type="button" className="icon-btn" onClick={() => setPanel(null)} aria-label={t("closePanel")}>
                <X size={16} aria-hidden />
              </button>
            </div>
            {panel === "chat" && <ChatPanel messages={messages} onSend={sendChat} />}
            {panel === "people" && <PeoplePanel participants={participants} local={lp} onAdd={() => setInviting(true)} />}
            {panel === "settings" && <SettingsPanel room={room} voice={voice} />}
            {panel === "claude" && <ClaudePanel claude={claude} voice={voice} onShareInCall={sendChat} flash={flash} />}
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
          {canRecord && (
            <span ref={recMenu.ref} className="relative flex">
              <button
                type="button"
                className={ctrl(!!recording.active?.mine)}
                onClick={() =>
                  recording.active?.mine
                    ? void recording.stop()
                    : videoRecording
                      ? recMenu.toggle()
                      : void recording.start("audio")
                }
                disabled={recording.busy || (!!recording.active && !recording.active.mine)}
                aria-pressed={!!recording.active?.mine}
                aria-haspopup={videoRecording && !recording.active ? "menu" : undefined}
                aria-expanded={videoRecording && !recording.active ? recMenu.open : undefined}
                aria-label={recording.active?.mine ? t("recStop") : t("recStart")}
                title={
                  recording.active && !recording.active.mine
                    ? t("recBy", { name: recording.active.byName })
                    : recording.active?.mine
                      ? t("recStop")
                      : t("recStart")
                }
              >
                {recording.active?.mine ? (
                  <Square size={15} aria-hidden className="text-danger" fill="currentColor" />
                ) : (
                  <CircleDot size={18} aria-hidden className={recording.active ? "text-danger" : ""} />
                )}
              </button>
              {recMenu.open && !recording.active && (
                <div role="menu" className="pop absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 p-1">
                  {(
                    [
                      ["audio", FileText, t("recModeTranscript"), t("recModeTranscriptHint")],
                      ["video", Clapperboard, t("recModeVideo"), t("recModeVideoHint")],
                    ] as const
                  ).map(([mode, Icon, label, hint]) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitem"
                      onClick={() => startRecording(mode)}
                      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-ink-soft hover:bg-hover hover:text-ink"
                    >
                      <Icon size={15} aria-hidden className="mt-0.5 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-[13.5px] text-ink">{label}</span>
                        <span className="block text-[12px] text-ink-mute">{hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {!stage.data.disabled && (
            <span ref={stageMenu.ref} className="relative flex">
              <button
                type="button"
                className={ctrl(stageVisible)}
                onClick={() => (stageOpen ? stageMenu.toggle() : openStage())}
                aria-haspopup={stageOpen ? "menu" : undefined}
                aria-expanded={stageOpen ? stageMenu.open : undefined}
                aria-label={stageOpen ? t("stageCount", { count: stageItems }) : t("stageOpen")}
                title={stageOpen ? t("stageCount", { count: stageItems }) : t("stageOpen")}
              >
                <span className="relative">
                  <Presentation size={18} aria-hidden />
                  {((stage.data.assist && !stage.data.assist.pausedBy) || (stageNews && !stageVisible)) && (
                    <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-sheet" style={{ background: "var(--color-app-meet)" }} />
                  )}
                </span>
              </button>
              {stageMenu.open && stageOpen && (
                <div role="menu" className="pop absolute bottom-full left-1/2 z-20 mb-2 w-52 -translate-x-1/2 p-1">
                  {(
                    [
                      ["stage", t("stageViewStage")],
                      ["side", t("stageViewSide")],
                      ["hidden", t("stageViewHidden")],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="menuitemradio"
                      aria-checked={stageView === v}
                      disabled={v === "side" && !wide}
                      onClick={() => {
                        stageMenu.setOpen(false);
                        setStageView(v);
                      }}
                      className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-40"
                    >
                      <Check size={14} aria-hidden className={stageView === v ? "" : "invisible"} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </span>
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
          <button type="button" className="icon-btn" onClick={() => setInviting(true)} aria-label={t("addPeople")} title={t("addPeople")}>
            <UserPlus size={18} aria-hidden />
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
            className={`icon-btn ${panel === "claude" ? "!bg-primary-soft !text-ink" : ""}`}
            onClick={() => togglePanel("claude")}
            aria-pressed={panel === "claude"}
            aria-label={claude.talking ? t("claudeRecording") : claude.capturing ? t("myClaudeListening") : t("myClaude")}
            title={`${claude.capturing ? t("myClaudeListening") : t("myClaude")} · ${t("claudeTalkKeyHint")}`}
          >
            <span className="relative">
              <Sparkles size={18} aria-hidden className={claude.talking ? "text-danger" : ""} />
              {(claude.talking || claude.capturing || !!claude.data?.confirmations.length) && (
                <span
                  className={`absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-sheet ${
                    claude.talking ? "animate-pulse bg-danger" : claude.data?.confirmations.length ? "animate-pulse bg-amber" : ""
                  }`}
                  style={claude.talking || claude.data?.confirmations.length ? undefined : { background: "var(--color-app-meet)" }}
                />
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

      {inviting && <AddPeopleDialog roomName={roomName} onClose={() => setInviting(false)} />}

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

  return (
    <>
      {/* Outside the movable view so remote audio never stops, wherever the user is in the app. */}
      {audioTracks.map((a) => (
        <AudioView key={a.key} track={a.track} />
      ))}
      {!onPage &&
        createPortal(
          <MiniCall
            room={room}
            roomName={roomName}
            speaker={speaker}
            count={participants.length}
            busy={busy}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
            recording={recording.active}
            claude={claude}
            reconnecting={reconnecting}
            toast={toast}
            stage={stageOpen ? { count: stageItems, assist: !!stage.data.assist && !stage.data.assist.pausedBy } : null}
            onOpenStage={() => setStageView(stageShown)}
          />,
          document.body,
        )}
      {createPortal(callView, host)}
    </>
  );
}

function RecordingBanner({ active, busy, onStop }: { active: ActiveRecording; busy: boolean; onStop: () => void }) {
  const t = useTranslations("meet");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-line bg-sheet-muted px-4 py-2 text-[13px] text-ink-soft"
    >
      <span className="flex items-center gap-2 font-medium text-ink">
        <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
        {t("recRecording")}
        <span className="font-mono text-[12px] text-ink-soft tabular-nums">{clock((now - active.since) / 1000)}</span>
      </span>
      <span>
        {active.video
          ? active.mine
            ? t("recNoticeSelfVideo")
            : t("recNoticeVideo", { name: active.byName })
          : active.mine
            ? t("recNoticeSelf")
            : t("recNotice", { name: active.byName })}
      </span>
      {active.mine && (
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          className="font-medium text-ink underline underline-offset-2 disabled:opacity-50"
        >
          {t("recStop")}
        </button>
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

function PeoplePanel({ participants, local, onAdd }: { participants: Participant[]; local: Participant; onAdd: () => void }) {
  const t = useTranslations("meet");
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-2">
      <li className="px-2 pt-1 pb-2">
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <UserPlus size={15} aria-hidden />
          {t("addPeople")}
        </button>
      </li>
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

function SettingsPanel({ room, voice }: { room: Room; voice: ReturnType<typeof useClaudeVoice> }) {
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
      {voice.supported && (
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-app-meet)]"
            checked={voice.muted}
            onChange={(e) => voice.setMuted(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium text-ink">{t("claudeVoiceMute")}</span>
            <span className="block text-[12.5px] leading-relaxed text-ink-mute">{t("claudeVoiceMuteHint")}</span>
          </span>
        </label>
      )}
    </div>
  );
}
