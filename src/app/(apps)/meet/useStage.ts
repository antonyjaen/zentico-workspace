"use client";

// The call's live stage on the client: loads the snapshot, applies the server's zw-stage messages
// (data packets sent by the server, so they carry no participant), fetches the difference on a gap or
// a reconnect, and polls while the server can't reach the room. Changes go to /api/meet/stage/ops.
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  elementWins,
  STAGE_TOPIC,
  type AssistMode,
  type AssistState,
  type StageElement,
  type StageItem,
  type StageMessage,
  type StageOp,
  type StageState,
} from "./stage-types";

export type StageData = {
  loaded: boolean;
  /** The server has no stage support (Meet not configured) or refused access. */
  disabled: boolean;
  rev: number;
  open: boolean;
  focus: string | null;
  assist: AssistState | null;
  items: StageItem[];
  /** boardId → elementId → element (live and deleted, as last seen). */
  boards: Record<string, Map<string, StageElement>>;
  live: boolean;
  savedAt: number | null;
};

export type AgentCursor = { board: string; x: number; y: number; name: string; at: number };

const EMPTY: StageData = { loaded: false, disabled: false, rev: 0, open: false, focus: null, assist: null, items: [], boards: {}, live: true, savedAt: null };

const decoder = new TextDecoder();

/** Applies a snapshot (full) or a delta to the client state. Pure. */
export function applyState(prev: StageData, s: StageState): StageData {
  const items = new Map(s.full ? [] : prev.items.map((i) => [i.id, i]));
  for (const i of s.items) {
    if ("deleted" in i) items.delete(i.id);
    else items.set(i.id, i);
  }
  const boards: Record<string, Map<string, StageElement>> = s.full ? {} : { ...prev.boards };
  for (const [boardId, list] of Object.entries(s.elements)) {
    const cur = s.full ? new Map<string, StageElement>() : new Map(boards[boardId] ?? []);
    for (const e of list) if (elementWins(e, cur.get(e.id))) cur.set(e.id, e);
    boards[boardId] = cur;
  }
  for (const id of Object.keys(boards)) if (!items.has(id)) delete boards[id];
  return {
    loaded: true,
    disabled: false,
    rev: s.rev,
    open: s.open,
    focus: s.focus,
    assist: s.assist,
    items: [...items.values()].sort((a, b) => a.pos - b.pos),
    boards,
    live: s.live,
    savedAt: s.savedAt,
  };
}

export class StageRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new StageRequestError(json.error ?? "failed", json.message ?? json.error ?? `HTTP ${res.status}`);
  return json;
}

export function useStage(room: Room, roomName: string) {
  const [data, setData] = useState<StageData>(EMPTY);
  const [agentCursor, setAgentCursor] = useState<AgentCursor | null>(null);
  const ref = useRef(data);
  ref.current = data;
  const syncing = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const sync = useCallback(async (): Promise<void> => {
    if (syncing.current) {
      again.current = true;
      return syncing.current;
    }
    const run = (async () => {
      do {
        again.current = false;
        const since = ref.current.loaded ? ref.current.rev : 0;
        try {
          const res = await fetch(`/api/meet/stage?room=${encodeURIComponent(roomName)}&since=${since}`, { cache: "no-store" });
          if (res.status === 503) {
            setData((d) => ({ ...d, loaded: true, disabled: true }));
            return;
          }
          // Not seen in the room yet (just joined): try again shortly.
          if (res.status === 403) {
            setTimeout(() => void sync(), 3000);
            return;
          }
          if (!res.ok) return;
          const s = (await res.json()) as StageState;
          // A message applied meanwhile moved past this answer's base: ask again from there.
          if (!s.full && ref.current.rev !== s.from) {
            again.current = true;
            continue;
          }
          const next = applyState(ref.current, s);
          ref.current = next;
          setData(next);
        } catch {
          // offline: the next poll or message retries
        }
      } while (again.current);
    })();
    syncing.current = run;
    try {
      await run;
    } finally {
      syncing.current = null;
    }
  }, [roomName]);

  useEffect(() => {
    void sync();
  }, [sync]);

  // Server → room messages.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== STAGE_TOPIC || participant) return;
      let msg: StageMessage;
      try {
        msg = JSON.parse(decoder.decode(payload)) as StageMessage;
      } catch {
        return;
      }
      if ("changed" in msg || !ref.current.loaded || msg.from !== ref.current.rev) {
        void sync();
        return;
      }
      const next = applyState(ref.current, msg.delta);
      ref.current = next;
      setData(next);
      if (msg.agent) setAgentCursor({ ...msg.agent, at: Date.now() });
    };
    const onReconnected = () => void sync();
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [room, sync]);

  // Polling: every 2 s while the server can't reach the room, else a slow safety net.
  const live = data.live;
  const disabled = data.disabled;
  useEffect(() => {
    if (disabled) return;
    const id = setInterval(() => void sync(), live ? 30_000 : 2000);
    return () => clearInterval(id);
  }, [live, disabled, sync]);

  const send = useCallback(
    async (ops: StageOp[]) => {
      const out = await post<{ rev: number; ids: string[] }>("/api/meet/stage/ops", { room: roomName, ops });
      // The broadcast normally arrives first; if it doesn't, fetch the change.
      if (out.rev > ref.current.rev) setTimeout(() => out.rev > ref.current.rev && void sync(), 600);
      return out;
    },
    [roomName, sync],
  );

  const assist = useCallback(
    async (action: "start" | "pause" | "resume" | "stop", modes?: AssistMode[]) => {
      await post("/api/meet/stage/assist", { room: roomName, action, modes });
      void sync();
    },
    [roomName, sync],
  );

  const save = useCallback(() => post<{ folderId: string; boards: string[]; notes: string | null; sharedWith: number }>("/api/meet/stage/save", { room: roomName }), [roomName]);

  return { data, agentCursor, send, assist, save, sync };
}

export type Stage = ReturnType<typeof useStage>;
