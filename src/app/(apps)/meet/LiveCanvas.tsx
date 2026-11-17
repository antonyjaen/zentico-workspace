"use client";

// A stage whiteboard shared live with everyone in the call (client only: loaded with next/dynamic,
// ssr: false, like the Docs whiteboard's Canvas). Local edits are diffed against the versions last
// synced and sent in batches every 150 ms; remote elements are merged with Excalidraw's own
// reconcileElements and applied without entering the local undo history.
import "@excalidraw/excalidraw/index.css";
import { CaptureUpdateAction, Excalidraw, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentCursor } from "./useStage";
import type { StageElement } from "./stage-types";

type SceneElements = Parameters<typeof reconcileElements>[0];
type RemoteElements = Parameters<typeof reconcileElements>[1];

const BATCH_MS = 150;

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
  /** id → version the server has (sent by us or received). */
  const synced = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, StageElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  const initialElements = useMemo(() => {
    const list = [...elements.values()].filter((e) => !e.isDeleted);
    for (const e of elements.values()) synced.current.set(e.id, e.version);
    return restoreElements(list as unknown as Parameters<typeof restoreElements>[0], null, { refreshDimensions: false, repairBindings: true });
    // Read once: later updates are merged in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flush = useCallback(() => {
    timer.current = null;
    if (!pending.current.size) return;
    const batch = [...pending.current.values()];
    pending.current.clear();
    sendRef.current(batch).catch(() => {
      // Refused or offline: forget what we thought was synced so the next change resends it.
      for (const e of batch) synced.current.delete(e.id);
    });
  }, []);

  useEffect(
    () => () => {
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
    const remote = [...elements.values()].filter((e) => (synced.current.get(e.id) ?? -1) < e.version);
    if (!remote.length) return;
    const restored = restoreElements(remote as unknown as Parameters<typeof restoreElements>[0], null, { refreshDimensions: false, repairBindings: true });
    const merged = reconcileElements(
      a.getSceneElementsIncludingDeleted() as SceneElements,
      restored as unknown as RemoteElements,
      a.getAppState(),
    );
    a.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    // Whatever version the merge settled on is in sync (index fixes don't need echoing back).
    const now = new Map(a.getSceneElementsIncludingDeleted().map((e) => [e.id, e.version]));
    for (const e of remote) synced.current.set(e.id, Math.max(e.version, now.get(e.id) ?? 0));
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
        for (const e of els) {
          if ((synced.current.get(e.id) ?? -1) >= e.version) continue;
          // An element never sent and already deleted (e.g. a cancelled shape) doesn't need to travel.
          if (e.isDeleted && !synced.current.has(e.id)) continue;
          if (e.type === "image") continue;
          synced.current.set(e.id, e.version);
          pending.current.set(e.id, e as unknown as StageElement);
        }
        if (pending.current.size && !timer.current) timer.current = setTimeout(flush, BATCH_MS);
      }}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, saveAsImage: true, clearCanvas: false },
        tools: { image: false },
      }}
    />
  );
}
