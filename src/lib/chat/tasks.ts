// Shared tasks: tasks that live in a chat conversation (Google Chat spaces style), assigned to
// any number of its members, with one level of subtasks. Only members of the conversation can
// read, create, edit or delete them; every function that takes a `userId` checks that, and
// validates its input (callers are server actions, MCP tools and dashboard queries).
// Changes go to the conversation's members as a { type: "tasks" } chat event; creating,
// assigning and completing also post a compact system line and notify the assignees.
// Server-only (imports the SQLite connection).
import type { Row } from "node:sqlite";
import { isDayKey, isTimeZone, zonedToUtc } from "@/app/(apps)/calendar/time";
import {
  SUBTASKS_MAX,
  TASK_ASSIGNEES_MAX,
  TASK_DESCRIPTION_MAX,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  TASKS_PER_CONVERSATION_MAX,
  taskHref,
  type MyTask,
  type Task,
  type TaskDue,
  type TaskInput,
  type TaskPatch,
  type TaskPerson,
  type TaskPriority,
  type TaskStatus,
} from "@/app/(apps)/chat/tasks-shared";
import type { ConversationKind } from "@/app/(apps)/chat/shared";
import { notify } from "../notifications/store";
import { all, get, run, tx } from "./db";
import { publish } from "./events";
import { ChatError, newId, postSystemMessage } from "./store";

const num = (v: unknown) => Number(v ?? 0);
const strv = (v: unknown) => (typeof v === "string" ? v : "");
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const DAY_MS = 86_400_000;
const SOON_MS = DAY_MS;

// ---------- Access ----------

type Conv = { id: string; kind: ConversationKind; name: string | null };

/** The conversation, if `userId` is a (human) member of it. Tasks are for members only. */
function memberConv(convId: string, userId: number): Conv {
  const r = get(
    `SELECT c.id, c.kind, c.name, u.bot_id FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
       JOIN users u ON u.id = cm.user_id
     WHERE c.id = ?`,
    userId,
    convId,
  );
  if (!r) throw new ChatError("notFound");
  if (r.bot_id != null) throw new ChatError("forbidden");
  return { id: strv(r.id), kind: strv(r.kind) as ConversationKind, name: typeof r.name === "string" && r.name ? r.name : null };
}

/** Human members of a conversation (who may be assigned and who gets live task events). */
function humanMembers(convId: string): Set<number> {
  return new Set(
    all(
      "SELECT u.id FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? AND u.bot_id IS NULL",
      convId,
    ).map((r) => num(r.id)),
  );
}

function taskRow(taskId: string): Row {
  const r = get("SELECT * FROM tasks WHERE id = ?", taskId);
  if (!r) throw new ChatError("notFound");
  return r;
}

/** A task the user may see/edit (member of its conversation). */
function accessibleTask(taskId: string, userId: number): { row: Row; conv: Conv } {
  const row = taskRow(taskId);
  const conv = memberConv(strv(row.conversation_id), userId);
  return { row, conv };
}

function changed(convId: string) {
  publish(humanMembers(convId), { type: "tasks", conversationId: convId });
}

// ---------- Validation (shared by actions, MCP tools and dashboard queries) ----------

function cleanTitle(v: unknown): string {
  if (typeof v !== "string") throw new ChatError("invalid");
  const s = v.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!s) throw new ChatError("titleRequired");
  if (s.length > TASK_TITLE_MAX) throw new ChatError("tooLong");
  return s;
}

function cleanDescription(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new ChatError("invalid");
  const s = v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  if (s.length > TASK_DESCRIPTION_MAX) throw new ChatError("tooLong");
  return s;
}

function cleanStatus(v: unknown): TaskStatus {
  if (typeof v !== "string" || !TASK_STATUSES.includes(v as TaskStatus)) throw new ChatError("invalid");
  return v as TaskStatus;
}

function cleanPriority(v: unknown): TaskPriority | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !TASK_PRIORITIES.includes(v as TaskPriority)) throw new ChatError("invalid");
  return v as TaskPriority;
}

/** Wall-clock due date → stored columns (null clears). */
function cleanDue(v: unknown): { at: number; date: string; time: string | null; tz: string } | null {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ChatError("invalidDate");
  const d = v as Record<string, unknown>;
  const time = d.time == null || d.time === "" ? null : d.time;
  if (!isDayKey(d.date) || (time !== null && (typeof time !== "string" || !TIME.test(time))) || !isTimeZone(d.timeZone)) {
    throw new ChatError("invalidDate");
  }
  const year = Number(d.date.slice(0, 4));
  if (year < 2000 || year > 2200) throw new ChatError("invalidDate");
  const at = time === null ? zonedToUtc(`${d.date}T23:59:59`, d.timeZone) : zonedToUtc(`${d.date}T${time}:00`, d.timeZone);
  return { at, date: d.date, time, tz: d.timeZone };
}

/** Assignees must be human members of the conversation. `keep` = already assigned (may have left). */
function cleanAssignees(v: unknown, convId: string, keep: Set<number> = new Set()): number[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > TASK_ASSIGNEES_MAX) throw new ChatError("invalid");
  const members = humanMembers(convId);
  const out = new Set<number>();
  for (const id of v) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new ChatError("invalid");
    if (!members.has(id) && !keep.has(id)) throw new ChatError("notAssignable");
    out.add(id);
  }
  return [...out];
}

// ---------- Reading ----------

function people(ids: number[]): Map<number, TaskPerson> {
  const out = new Map<number, TaskPerson>();
  if (!ids.length) return out;
  for (const r of all(`SELECT id, name, email FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)) {
    out.set(num(r.id), { id: num(r.id), name: strv(r.name) || strv(r.email), email: strv(r.email) });
  }
  return out;
}

const unknownPerson = (id: number): TaskPerson => ({ id, name: "", email: "" });

function toTasks(rows: Row[]): Task[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => strv(r.id));
  const marks = ids.map(() => "?").join(",");
  const assigned = new Map<string, number[]>();
  for (const r of all(`SELECT task_id, user_id FROM task_assignees WHERE task_id IN (${marks}) ORDER BY assigned`, ...ids)) {
    const list = assigned.get(strv(r.task_id)) ?? [];
    list.push(num(r.user_id));
    assigned.set(strv(r.task_id), list);
  }
  const subs = new Map<string, { total: number; done: number }>();
  for (const r of all(
    `SELECT parent_id, count(*) AS total, sum(status = 'done') AS done FROM tasks WHERE parent_id IN (${marks}) GROUP BY parent_id`,
    ...ids,
  )) {
    subs.set(strv(r.parent_id), { total: num(r.total), done: num(r.done) });
  }
  const who = people([...new Set([...[...assigned.values()].flat(), ...rows.map((r) => num(r.created_by))])]);
  return rows.map((r) => {
    const due: TaskDue | null =
      r.due_at == null ? null : { at: num(r.due_at), date: strv(r.due_date), time: typeof r.due_time === "string" ? r.due_time : null, timeZone: strv(r.due_tz) };
    return {
      id: strv(r.id),
      conversationId: strv(r.conversation_id),
      parentId: typeof r.parent_id === "string" ? r.parent_id : null,
      title: strv(r.title),
      description: strv(r.description),
      status: strv(r.status) as TaskStatus,
      priority: (typeof r.priority === "string" ? r.priority : null) as TaskPriority | null,
      due,
      assignees: (assigned.get(strv(r.id)) ?? []).map((id) => who.get(id) ?? unknownPerson(id)),
      createdBy: who.get(num(r.created_by)) ?? unknownPerson(num(r.created_by)),
      created: num(r.created),
      updated: num(r.updated),
      completedAt: r.completed_at == null ? null : num(r.completed_at),
      order: num(r.position),
      subtasks: subs.get(strv(r.id)) ?? { total: 0, done: 0 },
    };
  });
}

/** Every task of a conversation (top-level and subtasks), in order. */
export function listTasks(convId: string, userId: number): Task[] {
  memberConv(convId, userId);
  return toTasks(
    all(
      "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY parent_id IS NOT NULL, position, created LIMIT ?",
      convId,
      TASKS_PER_CONVERSATION_MAX + SUBTASKS_MAX,
    ),
  );
}

/** One task with its subtasks. */
export function getTask(taskId: string, userId: number): { task: Task; subtasks: Task[] } {
  const { row } = accessibleTask(taskId, userId);
  const [task] = toTasks([row]);
  const subtasks = toTasks(all("SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created", taskId));
  return { task, subtasks };
}

/** What to call a conversation for one person (DMs: the other person; unnamed groups: first names). */
function convName(conv: Conv, userId: number): string {
  if (conv.name) return conv.kind === "channel" ? `#${conv.name}` : conv.name;
  const others = all(
    `SELECT u.name, u.email FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? AND u.id != ? AND u.bot_id IS NULL ORDER BY cm.joined LIMIT 4`,
    conv.id,
    userId,
  ).map((r) => strv(r.name) || strv(r.email));
  if (conv.kind === "dm") return others[0] ?? "";
  return others.map((n) => n.split(" ")[0]).join(", ");
}

/**
 * Tasks assigned to me across the conversations I'm still in: open ones (and, with includeDone,
 * those completed in the last 7 days), soonest due first.
 */
export function listMyTasks(userId: number, { includeDone = false, limit = 200 }: { includeDone?: boolean; limit?: number } = {}): MyTask[] {
  const rows = all(
    `SELECT t.* FROM tasks t
       JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = ?
       JOIN conversation_members cm ON cm.conversation_id = t.conversation_id AND cm.user_id = ta.user_id
     WHERE t.status != 'done' OR (? AND t.completed_at > ?)
     ORDER BY t.status = 'done', t.due_at IS NULL, t.due_at, t.created
     LIMIT ?`,
    userId,
    includeDone ? 1 : 0,
    Date.now() - 7 * DAY_MS,
    Math.max(1, Math.min(500, limit)),
  );
  const tasks = toTasks(rows);
  const convs = new Map<string, Conv>();
  for (const r of all(
    `SELECT id, kind, name FROM conversations WHERE id IN (${[...new Set(tasks.map((t) => t.conversationId))].map(() => "?").join(",") || "NULL"})`,
    ...new Set(tasks.map((t) => t.conversationId)),
  )) {
    convs.set(strv(r.id), { id: strv(r.id), kind: strv(r.kind) as ConversationKind, name: typeof r.name === "string" && r.name ? r.name : null });
  }
  const parentIds = [...new Set(tasks.map((t) => t.parentId).filter((x): x is string => !!x))];
  const parents = new Map<string, string>();
  if (parentIds.length) {
    for (const r of all(`SELECT id, title FROM tasks WHERE id IN (${parentIds.map(() => "?").join(",")})`, ...parentIds)) {
      parents.set(strv(r.id), strv(r.title));
    }
  }
  const names = new Map<string, string>();
  return tasks.map((t) => {
    const conv = convs.get(t.conversationId)!;
    if (!names.has(conv.id)) names.set(conv.id, convName(conv, userId));
    return {
      ...t,
      conversation: { id: conv.id, kind: conv.kind, name: names.get(conv.id)! },
      parentTitle: t.parentId ? (parents.get(t.parentId) ?? null) : null,
    };
  });
}

// ---------- Writing ----------

function nameOf(userId: number): string {
  const r = get("SELECT name, email FROM users WHERE id = ?", userId);
  return strv(r?.name) || strv(r?.email);
}

/** "Ana assigned you 'X'" in the bell (+ toast) of each new assignee other than the actor. */
function notifyAssigned(conv: Conv, task: { id: string; title: string }, actorId: number, ids: number[]) {
  const actor = nameOf(actorId);
  for (const id of ids) {
    if (id === actorId) continue;
    const u = get("SELECT email, bot_id FROM users WHERE id = ?", id);
    if (!u || u.bot_id != null || !strv(u.email)) continue;
    const where = conv.kind === "dm" ? "" : convName(conv, id);
    notify(strv(u.email), {
      category: "chat",
      kind: "task",
      title: where ? `${actor} · ${where}` : actor,
      body: task.title,
      href: taskHref(conv.id, task.id),
      priority: "high",
      ref: conv.id,
      key: `task:${task.id}`,
      once: true,
    });
  }
}

/** Reminder bits a new due date starts with: no "due soon"/"overdue" for what the assignment already says. */
const soonBits = (dueAt: number | null) => (dueAt === null ? 0 : dueAt <= Date.now() ? 3 : dueAt - Date.now() <= SOON_MS ? 1 : 0);

export function createTask(convId: string, userId: number, input: TaskInput & { parentId?: string | null }): Task {
  const conv = memberConv(convId, userId);
  const title = cleanTitle(input.title);
  const description = cleanDescription(input.description);
  const status = input.status == null ? "todo" : cleanStatus(input.status);
  const priority = cleanPriority(input.priority);
  const due = cleanDue(input.due);
  const assignees = cleanAssignees(input.assigneeIds, convId);
  const parentId = input.parentId ?? null;

  const id = newId();
  const now = Date.now();
  tx(() => {
    if (parentId !== null) {
      const parent = get("SELECT conversation_id, parent_id FROM tasks WHERE id = ?", parentId);
      // One level of nesting, in the same conversation.
      if (!parent || strv(parent.conversation_id) !== convId || parent.parent_id != null) throw new ChatError("notFound");
      if (num(get("SELECT count(*) AS n FROM tasks WHERE parent_id = ?", parentId)?.n) >= SUBTASKS_MAX) throw new ChatError("tooMany");
    } else if (num(get("SELECT count(*) AS n FROM tasks WHERE conversation_id = ? AND parent_id IS NULL", convId)?.n) >= TASKS_PER_CONVERSATION_MAX) {
      throw new ChatError("tooMany");
    }
    const position =
      num(
        get(
          "SELECT max(position) AS p FROM tasks WHERE conversation_id = ? AND parent_id IS ?",
          convId,
          parentId,
        )?.p,
      ) + 1;
    run(
      `INSERT INTO tasks (id, conversation_id, parent_id, title, description, status, priority, due_at, due_date, due_time, due_tz,
         due_notified, position, created_by, created, updated, completed_at, completed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      convId,
      parentId,
      title,
      description,
      status,
      priority,
      due?.at ?? null,
      due?.date ?? null,
      due?.time ?? null,
      due?.tz ?? null,
      soonBits(due?.at ?? null),
      position,
      userId,
      now,
      now,
      status === "done" ? now : null,
      status === "done" ? userId : null,
    );
    for (const a of assignees) run("INSERT INTO task_assignees (task_id, user_id, assigned_by, assigned) VALUES (?, ?, ?, ?)", id, a, userId, now);
  });

  const others = assignees.filter((a) => a !== userId);
  const names = assignees.map(nameOf);
  // Top-level tasks: one line per creation (with whom it's for). Subtasks: only when assigned to others.
  if (parentId === null) postSystemMessage(convId, userId, { action: "task", names, task: { id, title, event: "created" } });
  else if (others.length) postSystemMessage(convId, userId, { action: "task", names: others.map(nameOf), task: { id, title, event: "assigned", subtask: true } });
  notifyAssigned(conv, { id, title }, userId, others);
  changed(convId);
  return toTasks([taskRow(id)])[0];
}

export function updateTask(taskId: string, userId: number, patch: TaskPatch): Task {
  const { row, conv } = accessibleTask(taskId, userId);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), params.push(v));
  const now = Date.now();
  const wasDone = strv(row.status) === "done";
  let completed = false;
  let title = strv(row.title);

  if (patch.title !== undefined) set("title", (title = cleanTitle(patch.title)));
  if (patch.description !== undefined) set("description", cleanDescription(patch.description));
  if (patch.priority !== undefined) set("priority", cleanPriority(patch.priority));
  if (patch.status !== undefined) {
    const status = cleanStatus(patch.status);
    set("status", status);
    if (status === "done" && !wasDone) {
      completed = true;
      set("completed_at", now);
      set("completed_by", userId);
    } else if (status !== "done" && wasDone) {
      set("completed_at", null);
      set("completed_by", null);
    }
  }
  if (patch.due !== undefined) {
    const due = cleanDue(patch.due);
    set("due_at", due?.at ?? null);
    set("due_date", due?.date ?? null);
    set("due_time", due?.time ?? null);
    set("due_tz", due?.tz ?? null);
    set("due_notified", soonBits(due?.at ?? null));
  }
  if (patch.order !== undefined) {
    if (typeof patch.order !== "number" || !Number.isFinite(patch.order) || Math.abs(patch.order) > 1e12) throw new ChatError("invalid");
    set("position", patch.order);
  }

  const current = new Set(all("SELECT user_id FROM task_assignees WHERE task_id = ?", taskId).map((r) => num(r.user_id)));
  const next = patch.assigneeIds === undefined ? null : cleanAssignees(patch.assigneeIds, conv.id, current);
  const added = next ? next.filter((id) => !current.has(id)) : [];

  if (!sets.length && !next) return toTasks([row])[0];
  tx(() => {
    set("updated", now);
    run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, taskId);
    if (next) {
      const keep = new Set(next);
      for (const id of current) if (!keep.has(id)) run("DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?", taskId, id);
      for (const id of added) run("INSERT INTO task_assignees (task_id, user_id, assigned_by, assigned) VALUES (?, ?, ?, ?)", taskId, id, userId, now);
    }
  });

  const subtask = row.parent_id != null;
  const others = added.filter((id) => id !== userId);
  if (others.length) {
    postSystemMessage(conv.id, userId, { action: "task", names: others.map(nameOf), task: { id: taskId, title, event: "assigned", ...(subtask ? { subtask } : {}) } });
    notifyAssigned(conv, { id: taskId, title }, userId, others);
  }
  // Only finishing a top-level task is worth a line in the conversation.
  if (completed && !subtask) postSystemMessage(conv.id, userId, { action: "task", task: { id: taskId, title, event: "completed" } });
  changed(conv.id);
  return toTasks([taskRow(taskId)])[0];
}

/** Deletes a task (and its subtasks): its creator may, or anyone once the creator has left. */
export function deleteTask(taskId: string, userId: number): void {
  const { row, conv } = accessibleTask(taskId, userId);
  const creator = num(row.created_by);
  if (creator !== userId && humanMembers(conv.id).has(creator)) throw new ChatError("forbidden");
  run("DELETE FROM tasks WHERE id = ?", taskId);
  changed(conv.id);
}

// ---------- Due soon / overdue reminders ----------

/**
 * Notifies assignees (still members) once when a task is due within a day and once when it
 * becomes overdue. Runs every few minutes from instrumentation.ts; cheap (indexed on status, due).
 */
export function sweepDueTasks(now = Date.now()): number {
  const rows = all(
    `SELECT id, conversation_id, title, due_at, due_notified FROM tasks
     WHERE status != 'done' AND due_at IS NOT NULL AND due_at <= ? AND due_at > ?
       AND ((due_notified & 1) = 0 OR (due_at <= ? AND (due_notified & 2) = 0))
     LIMIT 500`,
    now + SOON_MS,
    now - 7 * DAY_MS,
    now,
  );
  let sent = 0;
  for (const r of rows) {
    const taskId = strv(r.id);
    const overdue = num(r.due_at) <= now;
    run("UPDATE tasks SET due_notified = due_notified | ? WHERE id = ?", overdue ? 3 : 1, taskId);
    const c = get("SELECT id, kind, name FROM conversations WHERE id = ?", strv(r.conversation_id));
    if (!c) continue;
    const conv: Conv = { id: strv(c.id), kind: strv(c.kind) as ConversationKind, name: typeof c.name === "string" && c.name ? c.name : null };
    for (const a of all(
      `SELECT u.id, u.email FROM task_assignees ta JOIN users u ON u.id = ta.user_id
         JOIN conversation_members cm ON cm.conversation_id = ? AND cm.user_id = u.id
       WHERE ta.task_id = ? AND u.bot_id IS NULL`,
      conv.id,
      taskId,
    )) {
      const n = notify(strv(a.email), {
        category: "chat",
        kind: overdue ? "taskOverdue" : "taskDue",
        title: strv(r.title),
        body: conv.kind === "dm" ? "" : convName(conv, num(a.id)),
        href: taskHref(conv.id, taskId),
        ref: conv.id,
        key: `task-${overdue ? "overdue" : "due"}:${taskId}:${num(r.due_at)}`,
        once: true,
      });
      if (n) sent++;
    }
  }
  return sent;
}

const g = globalThis as typeof globalThis & { __zwTaskSweeper?: ReturnType<typeof setInterval> };

export function startTaskSweeper(): void {
  if (g.__zwTaskSweeper) return;
  const tick = () => {
    try {
      sweepDueTasks();
    } catch (e) {
      console.error("[tasks] due sweep failed:", e instanceof Error ? e.message : e);
    }
  };
  g.__zwTaskSweeper = setInterval(tick, 5 * 60_000);
  g.__zwTaskSweeper.unref?.();
  setTimeout(tick, 30_000).unref?.();
}
