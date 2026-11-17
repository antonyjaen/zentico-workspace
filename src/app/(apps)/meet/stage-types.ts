// Client-safe types and limits of the live meeting stage: shared whiteboards and pinned cards in a
// call, edited by everyone in it and by their agents (meeting_* MCP tools). The server
// (src/lib/meetings/stage.ts) owns the state; changes reach every browser in the room over LiveKit
// data messages on STAGE_TOPIC, sent by the server, and late joiners load a snapshot.

/** Server → room data messages: StageMessage. Never sent by peers (they carry no participant). */
export const STAGE_TOPIC = "zw-stage";

export const STAGE_KINDS = ["board", "notes", "decisions", "actions", "agenda", "checklist", "table"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
export type CardKind = Exclude<StageKind, "board">;
export const LIST_KINDS = ["decisions", "actions", "agenda", "checklist"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const STAGE_LIMITS = {
  boards: 3,
  cards: 20,
  elementsPerBoard: 3000,
  /** Stored rows of a board, deleted ones included (old tombstones are pruned past this). */
  rowsPerBoard: 6000,
  /** Stored element JSON of a board, deleted ones included. */
  boardBytes: 8 * 1024 * 1024,
  /** Card data, JSON. */
  cardBytes: 64 * 1024,
  /** One Excalidraw element, JSON (free drawings carry their points). */
  elementBytes: 32 * 1024,
  tableRows: 50,
  tableCols: 10,
  listEntries: 200,
  title: 120,
  opsPerRequest: 100,
  elementsPerRequest: 500,
  /** A broadcast bigger than this becomes a "changed" ping and clients fetch the difference. */
  messageBytes: 12 * 1024,
} as const;

/** One line of a decisions / actions / agenda / checklist card. */
export type ListEntry = { id: string; text: string; done?: boolean; assignee?: string; due?: string };

export type CardData =
  | { kind: "notes"; markdown: string }
  | { kind: ListKind; entries: ListEntry[]; current?: string | null }
  | { kind: "table"; columns: string[]; rows: string[][] };

export type StageItem = {
  id: string;
  kind: StageKind;
  title: string;
  pos: number;
  /** Card content (empty object for boards). */
  data: Record<string, unknown>;
  createdBy: string;
  actorKind: "user" | "agent";
  updated: number;
  /** The stage revision of the item's last change (the `base` of an item.update). */
  rev: number;
};

/** An Excalidraw element as stored (only the fields the merge needs are typed). */
export type StageElement = Record<string, unknown> & { id: string; version: number; versionNonce: number; isDeleted?: boolean };

export type AssistMode = "whiteboard" | "notes" | "decisions" | "actions";
export const ASSIST_MODES: readonly AssistMode[] = ["whiteboard", "notes", "decisions", "actions"];

export type AssistState = {
  owner: string;
  ownerName: string;
  /** The owner's assistant name ("Codex"). */
  agent: string;
  modes: AssistMode[];
  since: number;
  pausedBy: string | null;
  pausedByName: string | null;
  pausedAt: number | null;
  runs: number;
  /** A run is going on right now. */
  running: boolean;
  lastRunAt: number | null;
};

/** Full state (`full: true`) or the changes after `from`. Deleted items / elements come as tombstones. */
export type StageState = {
  room: string;
  rev: number;
  from: number;
  full: boolean;
  open: boolean;
  focus: string | null;
  assist: AssistState | null;
  items: (StageItem | { id: string; deleted: true })[];
  /** boardId → elements (with isDeleted tombstones in deltas). */
  elements: Record<string, StageElement[]>;
  /** False while server → room messages fail: poll instead. */
  live: boolean;
  savedAt: number | null;
};

export type StageMessage =
  | { rev: number; from: number; delta: StageState; agent?: { board: string; x: number; y: number; name: string } }
  | { rev: number; changed: true };

export type StageOp =
  | { op: "item.add"; item: { id?: string; kind: StageKind; title?: string; data?: Record<string, unknown> } }
  /** Replaces the title / whole content. With `base` (the item's rev the editor started from) it is
   *  refused with "conflict" when someone changed the item since, instead of overwriting their change. */
  | { op: "item.update"; id: string; title?: string; data?: Record<string, unknown>; base?: number }
  | { op: "item.remove"; id: string }
  /** Brings back a removed item (with its drawing). */
  | { op: "item.restore"; id: string }
  /** List cards: changes single entries of the current content, so concurrent edits don't overwrite each other. */
  | { op: "entries"; id: string; add?: ListEntry[]; set?: { id: string; done?: boolean; text?: string }[]; remove?: string[]; current?: string | null }
  /** Table cards: single cells / header cells of the current content, a new row or column. */
  | { op: "table"; id: string; header?: { col: number; value: string }[]; cells?: { row: number; col: number; value: string }[]; addRow?: boolean; addColumn?: boolean }
  | { op: "item.move"; id: string; pos: number }
  | { op: "el.upsert"; board: string; elements: StageElement[] }
  | { op: "el.delete"; board: string; ids: string[] }
  | { op: "focus"; id: string | null }
  | { op: "undoAgent" };

export type StageView = "stage" | "side" | "hidden";
/** Per-user stage layout, remembered on the device. */
export const STAGE_VIEW_PREF = "zw.meet.stageView";

/** Excalidraw's merge rule: the higher version wins; on a tie, the lower versionNonce. */
export function elementWins(incoming: { version: number; versionNonce: number }, current: { version: number; versionNonce: number } | null | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}
