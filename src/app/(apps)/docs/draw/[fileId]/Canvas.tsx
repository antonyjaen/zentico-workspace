"use client";

// Excalidraw canvas (client only: loaded with next/dynamic, ssr: false). Everything that touches
// the library lives here so it never reaches the server bundle; the page talks to it through
// the controller handed to `onReady`.
import "@excalidraw/excalidraw/index.css";
import {
  Excalidraw,
  exportToBlob,
  exportToSvg,
  getSceneVersion,
  MainMenu,
  restore,
  restoreLibraryItems,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, LibraryItems } from "@excalidraw/excalidraw/types";
import { useCallback, useMemo, useRef } from "react";

export type CanvasController = {
  /** The scene as a .excalidraw JSON document. */
  serialize: () => string;
  /** Number of visible elements (export needs at least one). */
  count: () => number;
  exportPng: () => Promise<Blob>;
  exportSvg: () => Promise<Blob>;
};

const LIBRARY_KEY = "zw_excalidraw_library";

function loadLibrary(): LibraryItems {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    return raw ? restoreLibraryItems(JSON.parse(raw), "unpublished") : [];
  } catch {
    return [];
  }
}

export default function Canvas({
  scene,
  name,
  theme,
  langCode,
  readOnly,
  onReady,
  onChange,
}: {
  /** Parsed .excalidraw document, or null for a blank scene. */
  scene: Record<string, unknown> | null;
  name: string;
  theme: "light" | "dark";
  langCode: string;
  readOnly: boolean;
  onReady: (c: CanvasController) => void;
  /** Called only when the drawing itself changed (not on pan/zoom/selection). */
  onChange: () => void;
}) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const baseline = useRef<{ version: number; files: number } | null>(null);

  const initialData = useMemo<ExcalidrawInitialDataState>(() => {
    const data = scene
      ? restore(scene as Parameters<typeof restore>[0], null, null, { repairBindings: true })
      : { elements: [], appState: {}, files: {} };
    return {
      elements: data.elements,
      appState: { ...data.appState, collaborators: new Map() },
      files: data.files,
      libraryItems: loadLibrary(),
      scrollToContent: true,
    };
    // The initial scene is read once; later prop changes must not reset the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bindApi = useCallback(
    (a: ExcalidrawImperativeAPI) => {
      api.current = a;
      const visible = () => a.getSceneElements();
      const exportState = () => ({ ...a.getAppState(), exportBackground: true, exportWithDarkMode: false });
      onReady({
        serialize: () => serializeAsJSON(a.getSceneElements(),a.getAppState(), a.getFiles(), "local"),
        count: () => visible().length,
        exportPng: () =>
          exportToBlob({ elements: visible(), appState: exportState(), files: a.getFiles(), mimeType: "image/png", exportPadding: 16 }),
        exportSvg: async () => {
          const svg = await exportToSvg({ elements: visible(), appState: exportState(), files: a.getFiles(), exportPadding: 16 });
          return new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
        },
      });
    },
    [onReady],
  );

  return (
    <Excalidraw
      excalidrawAPI={bindApi}
      initialData={initialData}
      name={name}
      theme={theme}
      langCode={langCode}
      viewModeEnabled={readOnly}
      autoFocus
      onChange={(elements, _appState, files) => {
        const next = { version: getSceneVersion(elements), files: Object.keys(files).length };
        const prev = baseline.current;
        baseline.current = next;
        if (prev && (prev.version !== next.version || prev.files !== next.files)) onChange();
      }}
      onLibraryChange={(items) => {
        try {
          localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
        } catch {}
      }}
      UIOptions={{
        canvasActions: {
          // Files live in Drive: no open/save-to-disk/JSON export; the app owns the theme.
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          toggleTheme: false,
          saveAsImage: true,
          clearCanvas: !readOnly,
          changeViewBackgroundColor: !readOnly,
        },
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        {!readOnly && <MainMenu.DefaultItems.ClearCanvas />}
        {!readOnly && <MainMenu.Separator />}
        {!readOnly && <MainMenu.DefaultItems.ChangeCanvasBackground />}
      </MainMenu>
    </Excalidraw>
  );
}
