"use client";

// A stage whiteboard shared live with everyone in the call (client only: loaded with next/dynamic,
// ssr: false, like the Docs whiteboard's Canvas). Local edits are diffed against the versions last
// synced and sent in batches every 250 ms (a refused batch is retried with backoff); remote elements are merged with Excalidraw's own
// reconcileElements and applied without entering the local undo history.
import "@excalidraw/excalidraw/index.css";
import { CaptureUpdateAction, Excalidraw, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentCursor } from "./useStage";
import { elementWins, type StageElement } from "./stage-types";

type SceneElements = Parameters<typeof reconcileElements>[0];
type RemoteElements = Parameters<typeof reconcileElements>[1];

const BATCH_MS = 250;
/** Retries of a refused / failed batch: 1 s, 2 s, 4 s … (then the next local change sends it again). */
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

type Synced = { version: number; versionNonce: number };
/** The local element is newer than (or a different copy of) what the server has. */
const ahead = (e: Synced, s: Synced | undefined) => !s || e.version > s.version || (e.version === s.version && e.versionNonce !== s.versionNonce);

export default function LiveCanvas({
  elements,
  theme,
  langCode,
  viewMode,
  agentCursor,
  onSend,
}: {
  /** The board's elements as last seen from the server (live and deleted). */
  elements: Map<string, StageElement>;
  theme: "light" | "dark";
  langCode: string;
  viewMode: boolean;
  agentCursor: AgentCursor | null;
  /** Sends changed elements; rejects when the server refused them. */
  onSend: (changed: StageElement[]) => Promise<unknown>;
}) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  /** id → version and nonce the server has (sent by us or received). */
  const synced = useRef(new Map<string, Synced>());
  const pending = useRef(new Map<string, StageElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  const initialElements = useMemo(() => {
    const list = [...elements.values()].filter((e) => !e.isDeleted);
    for (const e of elements.values())
      synced.current.set(e.id, {
        version: e.version,
        versionNonce: e.versionNonce,
      });
    return restoreElements(list as unknown as Parameters<typeof restoreElements>[0], null, { refreshDimensions: false, repairBindings: true });
    // Read once: later updates are merged in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Queues every local element the server doesn't have yet. */
  const collect = useCallback(
    (
      els: readonly {
        id: string;
        version: number;
        versionNonce: number;
        isDeleted?: boolean;
        type?: string;
      }[],
    ) => {
      for (const e of els) {
        const s = synced.current.get(e.id);
        if (!ahead(e, s)) continue;
        // An element never sent and already deleted (e.g. a cancelled shape) doesn't need to travel.
        if (e.isDeleted && !s) continue;
        if (e.type === "image") continue;
        synced.current.set(e.id, {
          version: e.version,
          versionNonce: e.versionNonce,
        });
        pending.current.set(e.id, e as unknown as StageElement);
      }
    },
    [],
  );

  const flush = useCallback(() => {
    timer.current = null;
    if (!pending.current.size) return;
    const batch = [...pending.current.values()];
    pending.current.clear();
    sendRef
      .current(batch)
      .then(() => {
        attempts.current = 0;
      })
      .catch(() => {
        // Refused (rate limit) or offline: forget what we thought was synced, unless a newer local
        // copy went out meanwhile, and send what's still missing again after a backoff.
        for (const e of batch) {
          const s = synced.current.get(e.id);
          if (s && s.version === e.version && s.versionNonce === e.versionNonce) synced.current.delete(e.id);
        }
        const wait = RETRY_MS[attempts.current];
        if (wait == null || retryTimer.current) return;
        attempts.current++;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          const a = api.current;
          if (!a) return;
          collect(a.getSceneElementsIncludingDeleted());
          if (pending.current.size && !timer.current) flush();
        }, wait);
      });
  }, [collect]);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    },
    [flush],
  );

  // Remote changes → merge into the scene (not into the local undo history).
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    // Excalidraw's rule (higher version, then lower nonce), so a tie lost on the server is taken too.
    const remote = [...elements.values()].filter((e) => elementWins(e, synced.current.get(e.id)));
    if (!remote.length) return;
    const restored = restoreElements(remote as unknown as Parameters<typeof restoreElements>[0], null, { refreshDimensions: false, repairBindings: true });
    const merged = reconcileElements(
      a.getSceneElementsIncludingDeleted() as SceneElements,
      restored as unknown as RemoteElements,
      a.getAppState(),
    );
    a.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    // Whatever the merge settled on is in sync (index fixes don't need echoing back).
    const now = new Map(a.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
    for (const e of remote) {
      const local = now.get(e.id);
      synced.current.set(
        e.id,
        local && local.version > e.version
          ? { version: local.version, versionNonce: local.versionNonce }
          : { version: e.version, versionNonce: e.versionNonce },
      );
    }
  }, [elements]);

  // The agent's "cursor" follows what it just drew, for a few seconds.
  useEffect(() => {
    const a = api.current;
    if (!a || !agentCursor) return;
    const collaborators = new Map([
      [
        "zw-agent",
        { username: agentCursor.name, pointer: { x: agentCursor.x, y: agentCursor.y, tool: "pointer" }, color: { background: "#e8590c", stroke: "#e8590c" } },
      ],
    ]);
    a.updateScene({ collaborators: collaborators as never, captureUpdate: CaptureUpdateAction.NEVER });
    const id = setTimeout(() => a.updateScene({ collaborators: new Map() as never, captureUpdate: CaptureUpdateAction.NEVER }), 3000);
    return () => clearTimeout(id);
  }, [agentCursor]);

  return (
    <Excalidraw
      excalidrawAPI={(a) => {
        api.current = a;
      }}
      initialData={{ elements: initialElements, appState: { collaborators: new Map() }, scrollToContent: true }}
      theme={theme}
      langCode={langCode}
      viewModeEnabled={viewMode}
      isCollaborating
      onChange={(els) => {
        collect(els);
        if (pending.current.size && !timer.current) timer.current = setTimeout(flush, BATCH_MS);
      }}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, saveAsImage: true, clearCanvas: false },
        tools: { image: false },
      }}
    />
  );
}
