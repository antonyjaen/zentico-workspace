// Tests for the live meeting stage (src/lib/meetings/stage.ts) with LiveKit replaced by in-memory
// fakes: the version/nonce merge, revisions and deltas, the 12 KB "changed" ping, limits, undoing
// agent changes, who may read and write, rate limits and the proactive assistant's scheduling.
// Run (uses a throwaway DATA_DIR; the alias maps the app's "@/" imports):
//   JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti scripts/meeting-stage.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "zw-stage-test-"));
process.env.DATA_DIR = dir;

const { setLiveKitFake } = await import("../src/lib/livekit-api");
const stage = await import("../src/lib/meetings/stage");
const agent = await import("../src/lib/mcp/agent");
const { run } = await import("../src/lib/meetings/db");
const { STAGE_LIMITS } = await import("../src/app/(apps)/meet/stage-types");
type StageMessage = import("../src/app/(apps)/meet/stage-types").StageMessage;

// --- fake LiveKit: who is in which room, and what the server sent to rooms
const people = new Map<string, string[]>();
const sent: { room: string; topic: string; data: StageMessage }[] = [];
let sendFails = false;
setLiveKitFake({
  listParticipants: async (room) => (people.get(room) ?? []).map((identity) => ({ identity, name: identity.split("@")[0] })),
  sendRoomData: async (room, topic, data) => {
    if (sendFails) throw new Error("LiveKit down");
    sent.push({ room, topic, data: data as StageMessage });
  },
});
const join_ = (room: string, ...emails: string[]) => {
  people.set(room, emails);
  setLiveKitFake({
    listParticipants: async (r) => (people.get(r) ?? []).map((identity) => ({ identity, name: identity.split("@")[0] })),
    sendRoomData: async (r, topic, data) => {
      if (sendFails) throw new Error("LiveKit down");
      sent.push({ room: r, topic, data: data as StageMessage });
    },
  });
};
const flush = () => new Promise((r) => setTimeout(r, 20));

const ana = { email: "ana@x.dev", name: "Ana", kind: "user" as const };
const bob = { email: "bob@x.dev", name: "Bob", kind: "user" as const };
const anaAgent = { email: "ana@x.dev", name: "Codex", kind: "agent" as const, tokenId: "tok1" };
const el = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version,
  versionNonce,
  ...extra,
});

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  }
}
const rejects = async (fn: () => unknown, code: string) => {
  try {
    await fn();
  } catch (e) {
    assert.equal((e as { code?: string }).code, code, (e as Error).message);
    return;
  }
  assert.fail(`expected a ${code} error`);
};

/* ------------------------------------------------------------------ access */

await test("only people in the call may write; readers also include the meeting's people", async () => {
  join_("room-a", "ana@x.dev", "BOB@x.dev");
  await stage.checkAccess("room-a", "ana@x.dev", "write");
  await stage.checkAccess("room-a", "bob@x.dev", "write"); // identity case doesn't matter
  await rejects(() => stage.checkAccess("room-a", "eve@x.dev", "write"), "forbidden");
  await rejects(() => stage.checkAccess("room-a", "eve@x.dev", "read"), "forbidden");
  // Eve was in the room's recorded meeting: she may read the stage after the call, not write.
  stage.applyOps("room-a", ana, [{ op: "item.add", item: { kind: "notes", title: "N" } }]);
  run(
    "INSERT INTO meetings (id, room, started_by, started_at, last_activity, status) VALUES ('m1', 'room-a', 'ana@x.dev', ?, ?, 'ready')",
    Date.now(),
    Date.now(),
  );
  run("INSERT INTO meeting_people (meeting_id, email) VALUES ('m1', 'eve@x.dev')");
  await stage.checkAccess("room-a", "eve@x.dev", "read");
  await rejects(() => stage.checkAccess("room-a", "eve@x.dev", "write"), "forbidden");
});

await test("rate limit: sliding window per key", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.ok(stage.takeRate("k", 5, 1000, t0 + i));
  assert.equal(stage.takeRate("k", 5, 1000, t0 + 10), false);
  assert.ok(stage.takeRate("k", 5, 1000, t0 + 1001), "window slides");
  assert.ok(stage.takeRate("other", 5, 1000, t0 + 10), "keys are separate");
});

/* -------------------------------------------------------- revisions, merge */

await test("revisions increase and since= returns only what changed (with tombstones)", async () => {
  join_("room-b", "ana@x.dev", "bob@x.dev");
  const r1 = stage.applyOps("room-b", ana, [{ op: "item.add", item: { id: "b1", kind: "board", title: "Arch" } }]);
  const r2 = stage.applyOps("room-b", bob, [{ op: "item.add", item: { id: "c1", kind: "checklist", title: "Todo", data: { entries: ["one", { text: "two", done: true }] } } }]);
  assert.equal(r2.rev, r1.rev + 1);
  const full = stage.stageState("room-b");
  assert.ok(full.full);
  assert.deepEqual(
    full.items.map((i) => i.id),
    ["b1", "c1"],
  );
  const d = stage.stageState("room-b", r1.rev);
  assert.equal(d.full, false);
  assert.deepEqual(
    d.items.map((i) => i.id),
    ["c1"],
  );
  stage.applyOps("room-b", bob, [{ op: "item.remove", id: "c1" }]);
  const d2 = stage.stageState("room-b", r2.rev);
  assert.deepEqual(d2.items, [{ id: "c1", deleted: true }]);
  assert.equal(stage.stageState("room-b").items.length, 1, "full state leaves deleted items out");
  // A since newer than the stage (it was closed and reopened) gets everything.
  assert.equal(stage.stageState("room-b", 9999).full, true);
});

await test("elements merge like Excalidraw: higher version wins, then lower nonce", () => {
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: [el("e1", 2, 50)] }]);
  stage.applyOps("room-b", bob, [{ op: "el.upsert", board: "b1", elements: [el("e1", 1, 1, { x: 99 })] }]); // older: ignored
  assert.equal(stage.boardElements("room-b", "b1")[0].x, 0);
  stage.applyOps("room-b", bob, [{ op: "el.upsert", board: "b1", elements: [el("e1", 2, 70, { x: 70 })] }]); // tie, higher nonce: ignored
  assert.equal(stage.boardElements("room-b", "b1")[0].x, 0);
  stage.applyOps("room-b", bob, [{ op: "el.upsert", board: "b1", elements: [el("e1", 2, 10, { x: 10 })] }]); // tie, lower nonce: wins
  assert.equal(stage.boardElements("room-b", "b1")[0].x, 10);
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: [el("e1", 3, 999, { x: 3 })] }]);
  assert.equal(stage.boardElements("room-b", "b1")[0].x, 3);
  // Deleting is a newer version with isDeleted.
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: [el("e1", 4, 1, { isDeleted: true })] }]);
  assert.equal(stage.boardElements("room-b", "b1").length, 0);
  // A batch with nothing new doesn't make a revision.
  const before = stage.stageState("room-b").rev;
  assert.equal(stage.applyOps("room-b", bob, [{ op: "el.upsert", board: "b1", elements: [el("e1", 1, 1)] }]).changed, false);
  assert.equal(stage.stageState("room-b").rev, before);
});

await test("each change is broadcast as a delta; a big one becomes a 'changed' ping", async () => {
  sent.length = 0;
  const from = stage.stageState("room-b").rev;
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: [el("small", 1, 1)] }]);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, "zw-stage");
  const m = sent[0].data;
  assert.ok("delta" in m && m.from === from && m.rev === from + 1);
  assert.equal(m.delta.elements.b1.length, 1);

  sent.length = 0;
  const big = Array.from({ length: 40 }, (_, i) => el(`big${i}`, 1, 1, { text: "x".repeat(400) }));
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: big }]);
  await flush();
  assert.equal(sent.length, 1);
  assert.ok("changed" in sent[0].data, "over 12 KB → ping");
  assert.ok(JSON.stringify(sent[0].data).length < STAGE_LIMITS.messageBytes);
});

await test("SendData failing flips live:false (clients poll) and back", async () => {
  sendFails = true;
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: [el("f1", 1, 1)] }]);
  await flush();
  assert.equal(stage.stageState("room-b").live, false);
  sendFails = false;
  stage.applyOps("room-b", ana, [{ op: "el.upsert", board: "b1", elements: [el("f2", 1, 1)] }]);
  await flush();
  assert.equal(stage.stageState("room-b").live, true);
});

/* ------------------------------------------------------------------ limits */

await test("limits: boards, cards, card size, elements per board, bad input", async () => {
  join_("room-c", "ana@x.dev");
  for (let i = 0; i < STAGE_LIMITS.boards; i++) stage.applyOps("room-c", ana, [{ op: "item.add", item: { kind: "board" } }]);
  await rejects(() => stage.applyOps("room-c", ana, [{ op: "item.add", item: { kind: "board" } }]), "limit");
  for (let i = 0; i < STAGE_LIMITS.cards; i++) stage.applyOps("room-c", ana, [{ op: "item.add", item: { kind: "notes" } }]);
  await rejects(() => stage.applyOps("room-c", ana, [{ op: "item.add", item: { kind: "notes" } }]), "limit");
  join_("room-d", "ana@x.dev");
  const bigList = { entries: Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(490)}`) };
  await rejects(() => stage.applyOps("room-d", ana, [{ op: "item.add", item: { kind: "checklist", data: bigList } }]), "limit");
  // A failed batch changes nothing (atomic).
  assert.equal(stage.stageState("room-d").items.length, 0);
  stage.applyOps("room-d", ana, [{ op: "item.add", item: { id: "bd", kind: "board" } }]);
  const many = Array.from({ length: 500 }, (_, i) => el(`m${i}`, 1, 1));
  for (let i = 0; i < 6; i++) stage.applyOps("room-d", ana, [{ op: "el.upsert", board: "bd", elements: many.map((e) => ({ ...e, id: `${e.id}-${i}` })) }]);
  await rejects(() => stage.applyOps("room-d", ana, [{ op: "el.upsert", board: "bd", elements: [el("one-more", 1, 1)] }]), "limit");
  await rejects(() => stage.applyOps("room-d", ana, [{ op: "el.upsert", board: "bd", elements: [el("huge", 1, 1, { points: Array(5000).fill([1, 2]) })] }]), "limit");
  await rejects(() => stage.applyOps("room-d", ana, [{ op: "item.add", item: { kind: "video" as never } }]), "invalid");
  await rejects(() => stage.applyOps("room-d", ana, [{ op: "item.update", id: "nope" }]), "not_found");
  // Images (need binary files) are dropped, not stored.
  stage.applyOps("room-d", ana, [{ op: "item.add", item: { id: "bd2", kind: "board" } }]);
  stage.applyOps("room-d", ana, [{ op: "el.upsert", board: "bd2", elements: [el("img", 1, 1, { type: "image" })] }]);
  assert.equal(stage.boardElements("room-d", "bd2").length, 0);
});

await test("card data is validated and cleaned per kind", () => {
  assert.deepEqual(stage.cleanCardData("table", { columns: ["a", "b"], rows: [["1", 2, "x"], "bad"] }), { columns: ["a", "b"], rows: [["1", "2"], []] });
  const list = stage.cleanCardData("actions", { entries: ["  ", "Ship it", { text: "Review", assignee: "Ana", due: "Fri", done: true }] }) as { entries: { text: string }[] };
  assert.deepEqual(
    list.entries.map((e) => e.text),
    ["Ship it", "Review"],
  );
  assert.equal((stage.cleanCardData("agenda", { entries: [{ id: "a1", text: "x" }], current: "zz" }) as { current: unknown }).current, null);
});

/* -------------------------------------------------------------------- undo */

await test("undo agent changes restores what the agent did, but not what people changed after", () => {
  join_("room-u", "ana@x.dev", "bob@x.dev");
  stage.applyOps("room-u", bob, [{ op: "item.add", item: { id: "wb", kind: "board" } }]);
  stage.applyOps("room-u", bob, [{ op: "el.upsert", board: "wb", elements: [el("mine", 1, 5, { x: 1 })] }]);
  stage.applyOps("room-u", bob, [{ op: "item.add", item: { id: "notes", kind: "notes", data: { markdown: "bob's" } } }]);
  // The agent: draws two elements, moves Bob's, edits the notes, pins a card.
  stage.applyOps("room-u", anaAgent, [{ op: "el.upsert", board: "wb", elements: [el("a1", 1, 1), el("a2", 1, 1)] }]);
  stage.applyOps("room-u", anaAgent, [{ op: "el.upsert", board: "wb", elements: [el("mine", 2, 5, { x: 500 })] }]);
  stage.applyOps("room-u", anaAgent, [{ op: "el.upsert", board: "wb", elements: [el("mine", 3, 5, { x: 600 })] }]);
  stage.applyOps("room-u", anaAgent, [{ op: "item.update", id: "notes", data: { markdown: "agent's" } }]);
  stage.applyOps("room-u", anaAgent, [{ op: "item.add", item: { id: "dec", kind: "decisions", data: { entries: ["x"] } } }]);
  // Bob changes a2 after the agent: it stays.
  stage.applyOps("room-u", bob, [{ op: "el.upsert", board: "wb", elements: [el("a2", 2, 1, { x: 42 })] }]);

  stage.applyOps("room-u", bob, [{ op: "undoAgent" }]);
  const els = new Map(stage.boardElements("room-u", "wb").map((e) => [e.id, e]));
  assert.equal(els.has("a1"), false, "agent's new element removed");
  assert.equal(els.get("a2")?.x, 42, "element Bob changed afterwards kept");
  assert.equal(els.get("mine")?.x, 1, "Bob's element back where it was (through two agent moves)");
  assert.ok((els.get("mine")?.version ?? 0) > 3, "restores are newer versions so clients take them");
  assert.equal(stage.getItem("room-u", "notes")?.data.markdown, "bob's");
  assert.equal(stage.getItem("room-u", "dec"), null, "agent's card removed");
  // A second undo has nothing left to do.
  assert.equal(stage.applyOps("room-u", bob, [{ op: "undoAgent" }]).changed, false);
});

/* ------------------------------------------------------------------ assist */

await test("assist: needs a connected bridge, anyone pauses, only the owner resumes", async () => {
  join_("room-p", "ana@x.dev", "bob@x.dev");
  await rejects(() => stage.startAssist("room-p", ana, ["notes"]), "no_bridge");
  const done = agent.bridgeConnected("ana@x.dev", "tok1", "zentico-bridge/1.4.0 codex (host)");
  const a = await stage.startAssist("room-p", ana, ["notes", "actions"]);
  assert.equal(a.owner, "ana@x.dev");
  assert.equal(a.agent, "Codex");
  assert.ok(stage.getItem("room-p", stage.stageItems("room-p")[0].id), "starting opens the stage");
  await rejects(() => stage.startAssist("room-p", bob, ["notes"]), "forbidden");
  const paused = await stage.controlAssist("room-p", bob, "pause");
  assert.equal(paused?.pausedBy, "bob@x.dev");
  await rejects(() => stage.controlAssist("room-p", bob, "resume"), "forbidden");
  const resumed = await stage.controlAssist("room-p", ana, "resume");
  assert.equal(resumed?.pausedBy, null);
  await rejects(() => stage.controlAssist("room-p", { ...ana, email: "eve@x.dev" }, "pause"), "forbidden");
  done();
});

await test("assist scheduling: char / time thresholds, one run at a time, 45 s gap, pause cancels", async () => {
  const room = "room-p";
  const t0 = Date.now();
  // Not enough speech yet.
  agent.addUtterance("bob@x.dev", room, "short bit", "meeting");
  await flush();
  assert.equal(stage.onMeetingSpeech(room, t0), null);
  assert.equal(stage.assistOf(room)?.inFlight, null);
  // Enough characters → a quiet 'assist' command for the owner.
  // Storing meeting speech schedules by itself (addUtterance → onMeetingSpeech); either way one run.
  agent.addUtterance("bob@x.dev", room, "y".repeat(600), "meeting");
  await flush();
  const id = stage.assistOf(room)?.inFlight ?? stage.onMeetingSpeech(room, t0 + 1000);
  assert.ok(id);
  const c = agent.getCommand(id!, "ana@x.dev");
  assert.equal(c?.kind, "assist");
  assert.equal(agent.listCommands("ana@x.dev", room).length, 0, "kept out of the command history");
  // The prompt carries the new speech and moves the cursor past it.
  const prompt = stage.assistPrompt(room, "Weekly");
  assert.match(prompt, /y{100}/);
  assert.match(prompt, /meeting_update_card/);
  // While it runs nothing else is queued, even with lots of new speech.
  agent.addUtterance("bob@x.dev", room, "z".repeat(800), "meeting");
  assert.equal(stage.onMeetingSpeech(room, t0 + 60_000), null);
  // It finishes: the next run waits for the 45 s gap, then merges what came in meanwhile.
  agent.applyBridgeEvent(id!, "ana@x.dev", { type: "done", result: "Added 2 notes" });
  await flush();
  assert.equal(stage.assistOf(room)?.inFlight, null);
  assert.equal(stage.onMeetingSpeech(room, t0 + 30_000), null, "45 s gap");
  const id2 = stage.onMeetingSpeech(room, t0 + 50_000);
  assert.ok(id2);
  assert.match(stage.assistPrompt(room, "Weekly"), /z{100}/);
  assert.doesNotMatch(stage.assistPrompt(room, "Weekly"), /y{100}/, "old speech not repeated");
  // Pausing cancels the run in flight.
  await stage.controlAssist(room, bob, "pause");
  assert.equal(agent.getCommand(id2!, "ana@x.dev")?.status, "cancelled");
  agent.addUtterance("bob@x.dev", room, "w".repeat(900), "meeting");
  assert.equal(stage.onMeetingSpeech(room, t0 + 200_000), null, "paused: no runs");
});

await test("assist: a little speech still runs after 120 s; owner leaving stops it in the sweep", async () => {
  const room = "room-q";
  join_(room, "ana@x.dev", "bob@x.dev");
  const done = agent.bridgeConnected("ana@x.dev", "tok1", "zentico-bridge/1.4.0 codex (host)");
  await stage.startAssist(room, ana, ["notes"]);
  await flush();
  agent.addUtterance("ana@x.dev", room, "a few words", "meeting");
  const now = Date.now();
  assert.equal(stage.onMeetingSpeech(room, now), null);
  assert.ok(stage.onMeetingSpeech(room, now + 121_000));
  join_(room, "bob@x.dev");
  const out = await stage.sweepStages(async () => undefined);
  assert.ok(out.some((o) => o.room === room && o.action === "assist_stopped"));
  assert.equal(stage.assistOf(room), null);
  done();
});

/* --------------------------------------------------------------- MCP tools */

await test("agent tools: room from the call the owner is in, progressive drawing, cards, only in the call", async () => {
  const { MEETING_STAGE_TOOLS } = await import("../src/lib/mcp/meeting-tools");
  const tool = (name: string) => MEETING_STAGE_TOOLS.find((t) => t.name === name)!;
  const ctx = { session: { email: "ana@x.dev", name: "Ana" } as never, scope: "write" as const, tokenName: "t", tokenExpires: null, tokenId: "tok1", commandId: null };
  const room = "room-t";
  join_(room, "ana@x.dev", "bob@x.dev");
  // Ana is in exactly one call with a command history there: found without a room argument.
  agent.addUtterance("ana@x.dev", room, "hello", "command");
  for (const r of ["room-b", "room-u", "room-p", "room-d", "room-a", "room-c"]) join_(r, "bob@x.dev");
  join_(room, "ana@x.dev", "bob@x.dev");
  const opened = (await tool("meeting_stage_open").run({}, ctx)) as { room: string; boardId: string };
  assert.equal(opened.room, room);
  sent.length = 0;
  const added = (await tool("meeting_whiteboard_add").run(
    {
      elements: [
        { type: "rectangle", ref: "api", label: "API" },
        { type: "rectangle", ref: "db", label: "DB" },
        { type: "ellipse", ref: "user", label: "User" },
        { type: "arrow", from: "user", to: "api" },
        { type: "arrow", from: "api", to: "db", label: "SQL" },
      ],
    },
    ctx,
  )) as { ids: Record<string, string>; added: number };
  await flush();
  assert.equal(added.added, 5);
  assert.ok(sent.filter((m) => m.room === room).length >= 3, "drawn in several steps");
  assert.ok(sent.some((m) => "agent" in m.data && m.data.agent?.name), "agent cursor travels with the steps");
  const read = (await tool("meeting_whiteboard_read").run({}, ctx)) as { elements: { id: string; text?: string; from?: string; to?: string }[] };
  assert.deepEqual(read.elements.filter((e) => e.text).map((e) => e.text).sort(), ["API", "DB", "SQL", "User"]);
  assert.ok(read.elements.some((e) => e.from === added.ids.api && e.to === added.ids.db), "arrow bound");
  await tool("meeting_whiteboard_update").run({ changes: [{ id: added.ids.db, text: "Postgres" }] }, ctx);
  const read2 = (await tool("meeting_whiteboard_read").run({}, ctx)) as { elements: { text?: string }[] };
  assert.ok(read2.elements.some((e) => e.text === "Postgres"));

  const card = (await tool("meeting_pin_card").run({ kind: "actions", title: "Action items", content: ["- Write the spec", { text: "Review", assignee: "Bob" }] }, ctx)) as { cardId: string };
  await tool("meeting_update_card").run({ cardId: card.cardId, append: "Ship it", check: { entry: 1, done: true } }, ctx);
  const c = stage.getItem(room, card.cardId)!;
  const entries = c.data.entries as { text: string; done?: boolean; assignee?: string }[];
  assert.deepEqual(entries.map((e) => e.text), ["Write the spec", "Review", "Ship it"]);
  assert.equal(entries[0].done, true);
  assert.equal(entries[1].assignee, "Bob");
  assert.equal(c.actorKind, "agent");
  // Stage tools never wait for Approve; saving to Drive does (normal write).
  assert.ok(MEETING_STAGE_TOOLS.filter((t) => t.name !== "meeting_stage_save" && t.write).every((t) => t.selfService));
  assert.equal(tool("meeting_stage_save").selfService, undefined);
  // Out of the call: the agent can't touch the stage.
  join_(room, "bob@x.dev");
  await assert.rejects(() => tool("meeting_pin_card").run({ room, kind: "notes", title: "x" }, ctx), /in the call|not in/);
});

/* ------------------------------------------------------- close and export */

await test("an empty room is saved and closed after the wait; a failed save is retried", async () => {
  const room = "room-z";
  join_(room, "ana@x.dev");
  stage.applyOps(room, ana, [{ op: "item.add", item: { id: "n", kind: "notes", data: { markdown: "hello" } } }]);
  stage.applyOps(room, ana, [{ op: "item.add", item: { id: "w", kind: "board" } }]);
  stage.applyOps(room, ana, [{ op: "el.upsert", board: "w", elements: [el("t", 1, 1, { type: "text", text: "Box" })] }]);
  const files = stage.exportStage(room, "Weekly: sync", new Date("2026-11-17T10:00:00Z"));
  assert.equal(files.boards.length, 1);
  assert.equal(files.boards[0].name, "Whiteboard – Weekly sync – 2026-11-17.excalidraw");
  assert.equal(JSON.parse(files.boards[0].json).elements.length, 1);
  assert.match(files.notes!.markdown, /## Notes[\s\S]*hello/);

  join_(room);
  const t = Date.now();
  assert.deepEqual(
    (await stage.sweepStages(async () => undefined, t)).filter((o) => o.room === room).map((o) => o.action),
    ["empty"],
  );
  const later = t + 31 * 60_000;
  const failing = await stage.sweepStages(async () => {
    throw new Error("no credentials");
  }, later);
  assert.ok(failing.some((o) => o.room === room && o.action === "save_failed"));
  assert.ok(stage.stageExists(room), "kept for a retry");
  let saved = 0;
  const ok = await stage.sweepStages(async () => {
    saved++;
  }, later + 60_000);
  assert.equal(saved, 1);
  assert.ok(ok.some((o) => o.room === room && o.action === "closed"));
  assert.equal(stage.stageExists(room), false, "the next meeting starts clean");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`✗ ${f}`);
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows keeps the SQLite files locked until the process exits
}
process.exit(failures.length ? 1 : 0);
