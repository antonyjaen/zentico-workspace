// Live meeting stage tools: the user's agent draws on a whiteboard and pins cards (notes, decisions,
// action items, agenda, checklist, table) that everyone in the call sees as it happens. They act on
// the call the token's owner is in, and only while they are in it (lib/meetings/stage.ts).
// Stage edits are self-service (no Approve card): they stay inside the call, everyone sees them, each
// is logged as the agent's and anyone can undo them. Saving to Drive is a normal confirmed write.
import { ROOM_PATTERN } from "@/app/(apps)/meet/shared";
import { STAGE_LIMITS, type ListEntry, type StageItem, type StageOp } from "@/app/(apps)/meet/stage-types";
import { listParticipants } from "../livekit-api";
import {
  AGENT_RATE,
  applyOps,
  boardElements,
  checkAccess,
  getItem,
  liveContext,
  openStageRooms,
  participantsOf,
  StageError,
  stageItems,
  stageSummary,
  takeRate,
  type Actor,
} from "../meetings/stage";
import { saveStageNow } from "../meetings/stage-save";
import { buildElements, patchElement, SKELETON_SCHEMA, summarizeElements, type WbElement } from "../whiteboard/elements";
import { agentNameFor, getCommand, recentRoomsOf } from "./agent";
import { bool, int, oneOf, str, ToolError, type Args } from "./args";
import { B, I, S, type Tool, type ToolContext } from "./kit";

const CARD_KINDS_FOR_TOOLS = ["notes", "decisions", "actions", "agenda", "checklist", "table"] as const;

const ROOM_PROP = S('Meeting room code, e.g. "abc-defg-hij". Omit to use the call you are in.');

/* ------------------------------------------------------------------ helpers */

/** The room a call acts on: the argument, the meeting command's room, else the one call the user is in. */
async function resolveRoom(args: Args, ctx: ToolContext): Promise<string> {
  const given = str(args, "room", { max: 64 });
  if (given) {
    if (!ROOM_PATTERN.test(given)) throw new ToolError('"room" is not a meeting code');
    return given;
  }
  const email = ctx.session.email;
  const fromCommand = ctx.commandId ? getCommand(ctx.commandId, email)?.room : null;
  if (fromCommand && ROOM_PATTERN.test(fromCommand)) return fromCommand;
  const candidates = [...new Set([...recentRoomsOf(email), ...openStageRooms()])].filter((r) => ROOM_PATTERN.test(r)).slice(0, 15);
  const inCall: string[] = [];
  for (const r of candidates) if ((await participantsOf(r)).has(email.toLowerCase())) inCall.push(r);
  if (inCall.length === 1) return inCall[0];
  if (!inCall.length) throw new ToolError("You are not in a Zentico video call right now (or pass room).");
  throw new ToolError(`You are in several calls (${inCall.join(", ")}); pass room.`);
}

const actorOf = (ctx: ToolContext): Actor => ({
  email: ctx.session.email,
  name: agentNameFor(ctx.session.email, "en"),
  kind: "agent",
  tokenId: ctx.tokenId ?? null,
});

/** Room + write access check + rate limit, for tools that change the stage. */
async function writable(args: Args, ctx: ToolContext): Promise<{ room: string; actor: Actor }> {
  const room = await resolveRoom(args, ctx);
  await guard(() => checkAccess(room, ctx.session.email, "write"));
  if (!takeRate(`agent:${ctx.session.email}:${room}`, AGENT_RATE.max, AGENT_RATE.windowMs)) throw new ToolError("Too many stage changes; wait a moment.");
  return { room, actor: actorOf(ctx) };
}

/** Room + read access: the stage's content (also for people of the recorded meeting, after the call). */
async function readable(args: Args, ctx: ToolContext): Promise<string> {
  const room = await resolveRoom(args, ctx);
  await guard(() => checkAccess(room, ctx.session.email, "read"));
  return room;
}

/** Room + in the call now: who is in it and what is being said are only for the people in it. */
async function inTheCall(args: Args, ctx: ToolContext): Promise<string> {
  const room = await resolveRoom(args, ctx);
  await guard(() => checkAccess(room, ctx.session.email, "write"));
  return room;
}

/** Stage errors become tool errors (their messages are meant for the user / agent). */
async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StageError) throw new ToolError(e.message);
    throw e;
  }
}

function boardArg(room: string, args: Args, key = "boardId"): StageItem {
  const id = str(args, key, { max: 64 });
  const items = stageItems(room);
  const board = id ? items.find((i) => i.id === id) : items.find((i) => i.kind === "board");
  if (!board) throw new ToolError(id ? `No whiteboard "${id}" on the stage` : "No whiteboard yet: call meeting_stage_open first");
  if (board.kind !== "board") throw new ToolError(`"${board.title || board.id}" is a ${board.kind} card, not a whiteboard`);
  return board;
}

function cardArg(room: string, args: Args, key = "cardId"): StageItem {
  const id = str(args, key, { required: true, max: 64 });
  const item = getItem(room, id);
  if (!item) throw new ToolError(`No stage item "${id}"`);
  return item;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Card content from a tool argument, in the shape cleanCardData() expects. */
function contentFor(kind: string, content: unknown): Record<string, unknown> {
  if (kind === "notes") return { markdown: typeof content === "string" ? content : Array.isArray(content) ? content.join("\n") : "" };
  if (kind === "table") {
    const o = (content && typeof content === "object" ? content : {}) as Args;
    return { columns: o.columns, rows: o.rows };
  }
  const list = Array.isArray(content) ? content : typeof content === "string" ? content.split("\n").filter((l) => l.trim()) : [];
  return { entries: list.map((x) => (typeof x === "string" ? { text: x.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "") } : x)) };
}

const entriesOf = (item: StageItem): ListEntry[] => (Array.isArray(item.data.entries) ? (item.data.entries as ListEntry[]) : []);

/** Finds a list entry by id, 1-based position or exact / partial text. */
function findEntry(entries: ListEntry[], ref: unknown): ListEntry {
  if (typeof ref === "number" && Number.isInteger(ref) && entries[ref - 1]) return entries[ref - 1];
  if (typeof ref === "string") {
    const hit = entries.find((e) => e.id === ref) ?? entries.find((e) => e.text.toLowerCase() === ref.toLowerCase()) ?? entries.find((e) => e.text.toLowerCase().includes(ref.toLowerCase()));
    if (hit) return hit;
  }
  throw new ToolError(`No entry ${JSON.stringify(ref)} on that card`);
}

const ENTRY_SCHEMA = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      properties: { text: { type: "string" }, done: { type: "boolean" }, assignee: { type: "string" }, due: { type: "string", description: "e.g. 2026-11-20 or Friday" } },
      required: ["text"],
    },
  ],
};

/* -------------------------------------------------------------------- tools */

export const MEETING_STAGE_TOOLS: Tool[] = [
  {
    name: "meeting_current",
    description:
      "The video call you are in right now: room, participants, the live stage (whiteboards with their text, pinned cards with their content) and whether a proactive assistant is keeping it.",
    inputSchema: { type: "object", properties: { room: ROOM_PROP } },
    async run(args, ctx) {
      const room = await inTheCall(args, ctx);
      const people = await listParticipants(room);
      return { room, participants: people.map((p) => ({ name: p.name, email: p.identity })), stage: stageSummary(room) };
    },
  },
  {
    name: "meeting_list_participants",
    description: "Who is in the video call right now (name and email).",
    inputSchema: { type: "object", properties: { room: ROOM_PROP } },
    async run(args, ctx) {
      const room = await inTheCall(args, ctx);
      return { room, participants: (await listParticipants(room)).map((p) => ({ name: p.name, email: p.identity })) };
    },
  },
  {
    name: "meeting_get_live_context",
    description:
      'What was said in the call recently (speech recognition of the mixed audio, speakers not identified; only while someone has "listen to the meeting" on). Returns {chunks, cursor}; pass cursor back to get only newer speech.',
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_PROP,
        sinceSec: I("How far back, in seconds (ignored with cursor).", 10, 3600, 300),
        cursor: { type: "number", description: "The cursor from a previous call." },
      },
    },
    async run(args, ctx) {
      const room = await inTheCall(args, ctx);
      const cursor = typeof args.cursor === "number" && Number.isFinite(args.cursor) ? args.cursor : Date.now() - int(args, "sinceSec", { min: 10, max: 3600, def: 300 }) * 1000;
      const out = liveContext(room, ctx.session.email, cursor);
      return { room, chunks: out.chunks.map((c) => ({ at: new Date(c.at).toISOString(), text: c.text })), cursor: out.cursor };
    },
  },
  {
    name: "meeting_stage_open",
    description:
      "Opens the call's shared stage with a whiteboard (if it has none yet) and shows it to everyone in the call. Returns the stage with item ids.",
    inputSchema: { type: "object", properties: { room: ROOM_PROP, title: S("Whiteboard title.", { maxLength: 120 }), focus: B("Bring it to the front for everyone.", true) } },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      let board = stageItems(room).find((i) => i.kind === "board");
      const ops: StageOp[] = [];
      if (!board) {
        const out = await guard(() => applyOps(room, actor, [{ op: "item.add", item: { kind: "board", title: str(args, "title", { max: 120 }) ?? "Whiteboard" } }]));
        board = getItem(room, out.ids[0])!;
      }
      if (bool(args, "focus", true)) ops.push({ op: "focus", id: board.id });
      if (ops.length) await guard(() => applyOps(room, actor, ops));
      return { room, boardId: board.id, stage: stageSummary(room) };
    },
  },
  {
    name: "meeting_whiteboard_create",
    description: `Adds another whiteboard to the stage (max ${STAGE_LIMITS.boards}).`,
    inputSchema: { type: "object", properties: { room: ROOM_PROP, title: S("Title.", { maxLength: 120 }) }, required: ["title"] },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const out = await guard(() => applyOps(room, actor, [{ op: "item.add", item: { kind: "board", title: str(args, "title", { required: true, max: 120 }) } }]));
      await guard(() => applyOps(room, actor, [{ op: "focus", id: out.ids[0] }]));
      return { room, boardId: out.ids[0] };
    },
  },
  {
    name: "meeting_whiteboard_read",
    description: "Lists a stage whiteboard's elements: id, type, box, text or label, arrow endpoints.",
    inputSchema: { type: "object", properties: { room: ROOM_PROP, boardId: S("Whiteboard id (default: the first one).") } },
    async run(args, ctx) {
      const room = await readable(args, ctx);
      const board = boardArg(room, args);
      return { room, boardId: board.id, title: board.title, elements: summarizeElements(boardElements(room, board.id) as unknown as WbElement[]) };
    },
  },
  {
    name: "meeting_whiteboard_add",
    description:
      "Draws on a stage whiteboard; everyone in the call sees it appear step by step. Rectangles/ellipses/diamonds (with `label`), text, and arrows/lines connecting elements with from/to (an existing id, or the `ref` of an element in this call). Elements without x/y are laid out in a row below the drawing. Returns ids by ref.",
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_PROP,
        boardId: S("Whiteboard id (default: the first one; opens the stage if needed)."),
        elements: { type: "array", description: "Elements to add (max 50).", items: SKELETON_SCHEMA },
        reveal: B("Draw progressively (a few elements at a time) so people can follow.", true),
      },
      required: ["elements"],
    },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      if (!Array.isArray(args.elements) || !args.elements.length || args.elements.length > 50) throw new ToolError('"elements" must be a list of 1–50 elements');
      if (!stageItems(room).some((i) => i.kind === "board") && !str(args, "boardId")) {
        await guard(() => applyOps(room, actor, [{ op: "item.add", item: { kind: "board", title: "Whiteboard" } }]));
      }
      const board = boardArg(room, args);
      const existing = boardElements(room, board.id) as unknown as WbElement[];
      const { added, touched, refs } = buildElements(args.elements as unknown[], existing);
      const asStage = (list: WbElement[]) => list as unknown as Extract<StageOp, { op: "el.upsert" }>["elements"];
      const first: StageOp[] = [];
      const summary = stageSummary(room);
      if (summary.open && summary.focus !== board.id) first.push({ op: "focus", id: board.id });
      const reveal = bool(args, "reveal", true);
      const step = reveal ? 4 : added.length;
      for (let i = 0; i < added.length; i += step) {
        const chunk = added.slice(i, i + step);
        // Shapes an arrow binds to change too; they go with the first chunk.
        const ops: StageOp[] = [...(i === 0 ? first : []), { op: "el.upsert", board: board.id, elements: asStage(i === 0 ? [...touched, ...chunk] : chunk) }];
        const last = chunk[chunk.length - 1];
        await guard(() => applyOps(room, actor, ops, { agentCursor: { board: board.id, x: last.x + (last.width || 0), y: last.y + (last.height || 0) } }));
        if (reveal && i + step < added.length) await sleep(120);
      }
      return {
        room,
        boardId: board.id,
        added: added.filter((e) => !(e.type === "text" && e.containerId)).length,
        ids: Object.fromEntries([...refs].map(([ref, e]) => [ref, e.id])),
      };
    },
  },
  {
    name: "meeting_whiteboard_update",
    description: "Changes elements on a stage whiteboard: text (or a shape's label), position, size, colors.",
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_PROP,
        boardId: S("Whiteboard id (default: the first one)."),
        changes: {
          type: "array",
          description: "Max 50.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
              stroke: { type: "string" },
              fill: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
      required: ["changes"],
    },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const board = boardArg(room, args);
      if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 50) throw new ToolError('"changes" must be a list of 1–50 changes');
      const els = boardElements(room, board.id) as unknown as WbElement[];
      const byId = new Map(els.map((e) => [e.id, e]));
      const changed = new Map<string, WbElement>();
      for (const raw of args.changes as Args[]) {
        const el = byId.get(String(raw?.id ?? ""));
        if (!el) throw new ToolError(`No element "${String(raw?.id ?? "")}" on that whiteboard`);
        for (const c of patchElement(el, raw as Parameters<typeof patchElement>[1], byId)) changed.set(c.id, c);
      }
      await guard(() => applyOps(room, actor, [{ op: "el.upsert", board: board.id, elements: [...changed.values()] as unknown as Extract<StageOp, { op: "el.upsert" }>["elements"] }]));
      return { room, boardId: board.id, changed: changed.size };
    },
  },
  {
    name: "meeting_whiteboard_remove",
    description: "Removes elements from a stage whiteboard (with their labels and arrows), or everything with all=true.",
    inputSchema: {
      type: "object",
      properties: { room: ROOM_PROP, boardId: S("Whiteboard id (default: the first one)."), ids: { type: "array", items: { type: "string" } }, all: B("Clear the whole whiteboard.") },
    },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const board = boardArg(room, args);
      const els = boardElements(room, board.id) as unknown as WbElement[];
      let ids: Set<string>;
      if (bool(args, "all")) ids = new Set(els.map((e) => e.id));
      else {
        const asked = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
        if (!asked.length) throw new ToolError('Pass "ids" or all=true');
        ids = new Set(asked);
        // Labels inside removed shapes and arrows bound to them go too.
        for (const e of els) {
          const sb = (e.startBinding as { elementId?: string } | null)?.elementId;
          const eb = (e.endBinding as { elementId?: string } | null)?.elementId;
          if ((e.containerId && ids.has(String(e.containerId))) || (sb && ids.has(sb)) || (eb && ids.has(eb))) ids.add(e.id);
        }
      }
      if (ids.size) await guard(() => applyOps(room, actor, [{ op: "el.delete", board: board.id, ids: [...ids] }]));
      return { room, boardId: board.id, removed: ids.size };
    },
  },
  {
    name: "meeting_pin_card",
    description: `Pins a card on the call's stage for everyone (max ${STAGE_LIMITS.cards}). content: notes = Markdown text; decisions / actions / agenda / checklist = a list of entries (strings, or {text, assignee, due, done}); table = {columns: [...], rows: [[...]]} (max ${STAGE_LIMITS.tableCols}×${STAGE_LIMITS.tableRows}). Check meeting_current first and update an existing card instead of pinning a duplicate.`,
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_PROP,
        kind: { type: "string", enum: [...CARD_KINDS_FOR_TOOLS] },
        title: S("Card title.", { maxLength: 120 }),
        content: { description: "See the tool description." },
        focus: B("Bring it to the front for everyone."),
      },
      required: ["kind", "title"],
    },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const kind = oneOf(args, "kind", CARD_KINDS_FOR_TOOLS, "notes");
      const out = await guard(() =>
        applyOps(room, actor, [{ op: "item.add", item: { kind, title: str(args, "title", { required: true, max: 120 }), data: contentFor(kind, args.content) } }]),
      );
      if (bool(args, "focus")) await guard(() => applyOps(room, actor, [{ op: "focus", id: out.ids[0] }]));
      return { room, cardId: out.ids[0], card: getItem(room, out.ids[0]) };
    },
  },
  {
    name: "meeting_update_card",
    description:
      "Changes a pinned card with small edits: append (notes: Markdown text; lists: entries; table: rows), check {entry, done} (entry = id, 1-based position or text), setCell {row, col, value} (0-based), setCurrent (agenda entry), title, or replace (the whole content, as in meeting_pin_card).",
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_PROP,
        cardId: S("Card id."),
        title: S("New title.", { maxLength: 120 }),
        append: { description: "Notes: Markdown text. Lists: an entry or a list of entries. Table: a row or a list of rows." },
        check: { type: "object", properties: { entry: { oneOf: [{ type: "string" }, { type: "integer" }] }, done: { type: "boolean" } }, required: ["entry"] },
        setCell: { type: "object", properties: { row: { type: "integer" }, col: { type: "integer" }, value: { type: "string" } }, required: ["row", "col", "value"] },
        setCurrent: { oneOf: [{ type: "string" }, { type: "integer" }], description: "Agenda: the entry being discussed now." },
        replace: { description: "The whole new content." },
        remove: { oneOf: [{ type: "string" }, { type: "integer" }], description: "Lists: an entry to delete." },
      },
      required: ["cardId"],
    },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const card = cardArg(room, args);
      if (card.kind === "board") throw new ToolError("That is a whiteboard; use meeting_whiteboard_update");
      let data: Record<string, unknown> = structuredClone(card.data);
      if (args.replace !== undefined) data = contentFor(card.kind, args.replace);
      if (args.append !== undefined) {
        if (card.kind === "notes") {
          const add = typeof args.append === "string" ? args.append : "";
          data.markdown = `${String(data.markdown ?? "").replace(/\s+$/, "")}${data.markdown ? "\n" : ""}${add}`;
        } else if (card.kind === "table") {
          const rows = Array.isArray(args.append) && Array.isArray(args.append[0]) ? (args.append as unknown[][]) : [args.append as unknown[]];
          data.rows = [...((data.rows as unknown[]) ?? []), ...rows.filter(Array.isArray)];
        } else {
          const add = Array.isArray(args.append) ? args.append : [args.append];
          data.entries = [...entriesOf(card), ...(contentFor(card.kind, add).entries as unknown[])];
        }
      }
      if (args.check && typeof args.check === "object") {
        const c = args.check as Args;
        const entries = (data.entries as ListEntry[] | undefined) ?? [];
        findEntry(entries, c.entry).done = c.done !== false;
      }
      if (args.remove !== undefined) {
        const entries = (data.entries as ListEntry[] | undefined) ?? [];
        const hit = findEntry(entries, args.remove);
        data.entries = entries.filter((e) => e !== hit);
      }
      if (args.setCell && typeof args.setCell === "object") {
        if (card.kind !== "table") throw new ToolError("setCell is for table cards");
        const c = args.setCell as Args;
        const rows = (data.rows as string[][] | undefined) ?? [];
        const r = Number(c.row);
        const col = Number(c.col);
        if (!Number.isInteger(r) || !Number.isInteger(col) || r < 0 || col < 0 || r > STAGE_LIMITS.tableRows || col >= STAGE_LIMITS.tableCols) throw new ToolError("setCell is out of range");
        while (rows.length <= r) rows.push([]);
        rows[r][col] = String(c.value ?? "");
        for (let i = 0; i < rows[r].length; i++) rows[r][i] ??= "";
        data.rows = rows;
      }
      if (args.setCurrent !== undefined) {
        if (card.kind !== "agenda") throw new ToolError("setCurrent is for agenda cards");
        data.current = findEntry((data.entries as ListEntry[] | undefined) ?? [], args.setCurrent).id;
      }
      const title = str(args, "title", { max: 120 });
      // Read and write happen in the same tick (no await in between), so `base` always matches here;
      // it only guards against that changing.
      await guard(() => applyOps(room, actor, [{ op: "item.update", id: card.id, data, base: card.rev, ...(title !== undefined ? { title } : {}) }]));
      return { room, card: getItem(room, card.id) };
    },
  },
  {
    name: "meeting_unpin",
    description: "Removes a card or whiteboard from the call's stage.",
    inputSchema: { type: "object", properties: { room: ROOM_PROP, cardId: S("Card or whiteboard id.") }, required: ["cardId"] },
    write: true,
    selfService: true,
    destructive: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const card = cardArg(room, args);
      await guard(() => applyOps(room, actor, [{ op: "item.remove", id: card.id }]));
      return { room, removed: card.id };
    },
  },
  {
    name: "meeting_stage_focus",
    description: "Brings a card or whiteboard to the front of the stage for everyone (itemId null = none).",
    inputSchema: { type: "object", properties: { room: ROOM_PROP, itemId: S("Card or whiteboard id.") } },
    write: true,
    selfService: true,
    async run(args, ctx) {
      const { room, actor } = await writable(args, ctx);
      const id = str(args, "itemId", { max: 64 }) ?? null;
      await guard(() => applyOps(room, actor, [{ op: "focus", id }]));
      return { room, focus: id };
    },
  },
  {
    name: "meeting_stage_save",
    description:
      "Saves the call's stage to your Drive (each whiteboard as .excalidraw, the cards as one Markdown document) and gives everyone in the meeting read access. Saving again updates the same files.",
    inputSchema: { type: "object", properties: { room: ROOM_PROP } },
    write: true,
    openWorld: true,
    async run(args, ctx) {
      const room = await resolveRoom(args, ctx);
      await guard(() => checkAccess(room, ctx.session.email, "write"));
      if (!stageItems(room).length) throw new ToolError("The stage is empty");
      return { room, ...(await saveStageNow(room, ctx.session.email)) };
    },
  },
];
