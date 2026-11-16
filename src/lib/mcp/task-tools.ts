// Shared tasks tools: tasks that live in chat conversations, assigned to members, with subtasks
// (lib/chat/tasks.ts). Due dates are wall-clock dates/times in the user's time zone (or the
// `timeZone` argument) and come back as local times with their UTC offset.
import type { MyTask, Task, TaskPriority, TaskStatus } from "@/app/(apps)/chat/tasks-shared";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/app/(apps)/chat/tasks-shared";
import { isTimeZone } from "@/app/(apps)/calendar/time";
import { bool, int, oneOf, str, strList, ToolError, truncate, type Args } from "./args";
import { localIso, userTimeZone } from "./calendar-tools";
import { A, appUrl, B, fold, I, S, type JsonSchema, type Tool } from "./kit";
import { chatError } from "./optional";

const CONV_ID = /^[a-z0-9]{16}$/;
const TASK_ID = /^[a-z0-9]{16}$/;
const DUE = /^(\d{4}-\d{2}-\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d))?$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Chat's server modules, loaded on demand (they open the Chat database). */
async function modules() {
  try {
    const [tasks, store, session] = await Promise.all([import("@/lib/chat/tasks"), import("@/lib/chat/store"), import("@/lib/chat/session")]);
    return { tasks, store, me: await session.chatUser() };
  } catch (e) {
    if (e instanceof ToolError) throw e;
    console.error("[mcp] tasks modules:", e instanceof Error ? e.message : e);
    throw new ToolError("Chat tasks are not available on this server.");
  }
}

const taskUrl = (t: Pick<Task, "conversationId" | "id">) => `${appUrl()}/chat?c=${t.conversationId}&task=${t.id}`;

function compact(t: Task | MyTask, tz: string, full = false) {
  const due = t.due ? (t.due.time ? localIso(t.due.at, tz) : t.due.date) : undefined;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority ?? undefined,
    due,
    overdue: t.status !== "done" && t.due && t.due.at < Date.now() ? true : undefined,
    assignees: t.assignees.map((a) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email)),
    parentTaskId: t.parentId ?? undefined,
    subtasks: t.subtasks.total ? `${t.subtasks.done}/${t.subtasks.total} done` : undefined,
    description: t.description ? (full ? t.description : truncate(t.description, 300)) : undefined,
    createdBy: t.createdBy.name || t.createdBy.email,
    conversation: "conversation" in t ? { id: t.conversation.id, name: t.conversation.name } : undefined,
    parentTitle: "parentTitle" in t ? (t.parentTitle ?? undefined) : undefined,
    url: taskUrl(t),
  };
}

function convIdArg(a: Args, key = "conversationId"): string {
  const v = str(a, key, { required: true, max: 64 });
  if (!CONV_ID.test(v)) throw new ToolError(`"${key}" is not a valid conversation id (use chat_list_conversations)`);
  return v;
}

function taskIdArg(a: Args, key: string, required: boolean): string | undefined {
  const v = required ? str(a, key, { required: true, max: 64 }) : str(a, key, { max: 64 });
  if (v !== undefined && !TASK_ID.test(v)) throw new ToolError(`"${key}" is not a valid task id (use tasks_list)`);
  return v;
}

const clean = (v: string) => v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" in tz; "" / "none" clears (null). */
function dueArg(v: unknown, tz: string, key: string): { date: string; time: string | null; timeZone: string } | null {
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  const s = v.trim();
  if (!s || s.toLowerCase() === "none") return null;
  const m = DUE.exec(s);
  if (!m) throw new ToolError(`"${key}" must be "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local time), or "none"`);
  return { date: m[1], time: m[2] ? `${m[2]}:${m[3]}` : null, timeZone: tz };
}

async function zoneArg(a: Args): Promise<string> {
  const tz = str(a, "timeZone", { max: 64 });
  if (tz !== undefined) {
    if (!isTimeZone(tz)) throw new ToolError('"timeZone" is not a valid IANA time zone');
    return tz;
  }
  try {
    return await userTimeZone();
  } catch {
    return "UTC";
  }
}

type Member = { id: number; name: string; email: string };

/** Emails, "Name <email>", names, handles or "me" → people of the conversation. */
function resolveMembers(wanted: string[], members: Member[], meId: number, key: string): number[] {
  const out = new Set<number>();
  for (const w of wanted) {
    const raw = w.trim();
    const email = (/<([^<>]+)>\s*$/.exec(raw)?.[1] ?? raw).toLowerCase();
    const f = fold(raw);
    let hits: Member[];
    if (["me", "myself", "yo"].includes(f)) hits = members.filter((m) => m.id === meId);
    else if (email.includes("@")) hits = members.filter((m) => m.email.toLowerCase() === email);
    else {
      hits = members.filter((m) => fold(m.name) === f || m.email.toLowerCase().split("@")[0] === f);
      if (!hits.length) hits = members.filter((m) => fold(m.name).split(/\s+/)[0] === f);
    }
    if (!hits.length) throw new ToolError(`"${w}" in "${key}" is not a member of this conversation. Members: ${members.map((m) => `${m.name} <${m.email}>`).join(", ")}`);
    if (hits.length > 1) throw new ToolError(`"${w}" matches several members: ${hits.map((m) => m.email).join(", ")}`);
    out.add(hits[0].id);
  }
  return [...out];
}

function membersOf(store: typeof import("@/lib/chat/store"), convId: string, meId: number): Member[] {
  return store
    .detail(convId, meId)
    .members.filter((m) => !m.bot)
    .map((m) => ({ id: m.id, name: m.name, email: m.email }));
}

const PRIORITY_ARG = S('Priority: "low", "medium", "high" (or "none" to clear).', { enum: [...TASK_PRIORITIES, "none"] });
const priorityArg = (a: Args): TaskPriority | null | undefined => {
  const v = oneOf(a, "priority", [...TASK_PRIORITIES, "none", ""] as const, "");
  return v === "" ? undefined : v === "none" ? null : v;
};

const SUBTASK_ITEM: JsonSchema = {
  type: "object",
  properties: {
    title: S("Subtask title."),
    assignees: A("Members to assign (emails or names)."),
    due: S('Due date "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local time).'),
  },
  required: ["title"],
};

const NOTIFY_NOTE =
  "Assigning notifies those people (bell + toast) and posts a short line in the conversation, so confirm with the user before creating or assigning tasks for others unless they asked you to directly.";

export const TASK_TOOLS: Tool[] = [
  {
    name: "tasks_list",
    description:
      "Lists shared tasks. Without conversationId: tasks assigned to you across all your chats (soonest due first, with where each lives). With conversationId: every task of that conversation, each with its subtasks.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: S("Conversation id (from chat_list_conversations). Omit for your own tasks."),
        includeDone: B("Also include completed tasks (yours: completed in the last 7 days)."),
        assignedToMe: B("With conversationId: only tasks assigned to you (or with a subtask assigned to you)."),
        timeZone: S("IANA time zone for due times (default: yours)."),
        limit: I("Max tasks.", 1, 200, 50),
      },
    },
    async run(args) {
      const includeDone = bool(args, "includeDone");
      const limit = int(args, "limit", { min: 1, max: 200, def: 50 });
      const conv = args.conversationId == null || args.conversationId === "" ? null : convIdArg(args);
      const tz = await zoneArg(args);
      const { tasks, me } = await modules();
      try {
        if (!conv) {
          const list = tasks.listMyTasks(me.id, { includeDone, limit });
          return { timeZone: tz, total: list.length, tasks: list.map((t) => compact(t, tz)) };
        }
        const mineOnly = bool(args, "assignedToMe");
        const all = tasks.listTasks(conv, me.id);
        const subs = new Map<string, Task[]>();
        for (const t of all) if (t.parentId) subs.set(t.parentId, [...(subs.get(t.parentId) ?? []), t]);
        const top = all
          .filter((t) => !t.parentId && (includeDone || t.status !== "done"))
          .filter((t) => !mineOnly || [t, ...(subs.get(t.id) ?? [])].some((x) => x.assignees.some((a) => a.id === me.id)));
        return {
          conversationId: conv,
          timeZone: tz,
          total: top.length,
          tasks: top.slice(0, limit).map((t) => ({ ...compact(t, tz), subtaskList: (subs.get(t.id) ?? []).map((s) => compact(s, tz)) })),
        };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "tasks_create",
    description: `Creates a shared task in a chat conversation (any member can see and edit it), optionally assigned to members, with a due date and subtasks; or a subtask of an existing task (parentTaskId). ${NOTIFY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        conversationId: S("Conversation id (from chat_list_conversations)."),
        title: S("Task title (max 200 characters)."),
        description: S("Details (Markdown, max 8000 characters)."),
        assignees: A('Members of the conversation to assign: emails, names or "me".'),
        due: S('Due date "YYYY-MM-DD" or date and time "YYYY-MM-DDTHH:MM" (local time in timeZone).'),
        timeZone: S("IANA time zone of `due` (default: yours)."),
        priority: PRIORITY_ARG,
        status: S("Initial status (default todo).", { enum: [...TASK_STATUSES] }),
        parentTaskId: S("Create it as a subtask of this task (one level of nesting)."),
        subtasks: { type: "array", items: SUBTASK_ITEM, description: "Subtasks to create with it (max 50)." },
      },
      required: ["conversationId", "title"],
    },
    write: true,
    async run(args) {
      const conv = convIdArg(args);
      const title = clean(str(args, "title", { required: true, max: 200 }));
      const description = clean(str(args, "description", { max: 8000 }) ?? "");
      const status = oneOf(args, "status", TASK_STATUSES, "todo") as TaskStatus;
      const priority = priorityArg(args) ?? null;
      const parentId = taskIdArg(args, "parentTaskId", false) ?? null;
      const tz = await zoneArg(args);
      const due = args.due == null ? null : dueArg(args.due, tz, "due");
      const wanted = strList(args, "assignees", { max: 50 });
      const rawSubs = args.subtasks == null ? [] : args.subtasks;
      if (!Array.isArray(rawSubs) || rawSubs.length > 50) throw new ToolError('"subtasks" must be an array (max 50)');
      if (parentId && rawSubs.length) throw new ToolError("Subtasks can't have subtasks of their own");
      const { tasks, store, me } = await modules();
      try {
        const members = membersOf(store, conv, me.id);
        const subtasks = rawSubs.map((s, i) => {
          if (!s || typeof s !== "object" || Array.isArray(s)) throw new ToolError(`"subtasks[${i}]" must be an object with a title`);
          const o = s as Args;
          return {
            title: clean(str(o, "title", { required: true, max: 200 })),
            assigneeIds: resolveMembers(strList(o, "assignees", { max: 50 }), members, me.id, `subtasks[${i}].assignees`),
            due: o.due == null ? null : dueArg(o.due, tz, `subtasks[${i}].due`),
          };
        });
        const task = tasks.createTask(conv, me.id, {
          title,
          description,
          status,
          priority,
          due,
          assigneeIds: resolveMembers(wanted, members, me.id, "assignees"),
          parentId,
        });
        const created = subtasks.map((s) => tasks.createTask(conv, me.id, { ...s, parentId: task.id }));
        const { task: fresh } = tasks.getTask(task.id, me.id);
        return { created: true, task: compact(fresh, tz, true), subtasks: created.map((s) => compact(s, tz)) };
      } catch (e) {
        chatError(e);
      }
    },
  },
  {
    name: "tasks_update",
    description: `Updates a shared task or subtask: title, description, status (todo / in_progress / done), priority, due date, assignees (replace the list, or add/remove people). ${NOTIFY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: S("Task id (from tasks_list)."),
        title: S("New title."),
        description: S("New description (Markdown; empty string clears it)."),
        status: S("New status.", { enum: [...TASK_STATUSES] }),
        priority: PRIORITY_ARG,
        due: S('New due date "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local time), or "none" to clear.'),
        timeZone: S("IANA time zone of `due` (default: yours)."),
        assignees: A("Replace the assignees with these members (emails, names or \"me\"; empty list unassigns everyone)."),
        addAssignees: A("Members to add."),
        removeAssignees: A("Members to remove."),
      },
      required: ["taskId"],
    },
    write: true,
    async run(args) {
      const id = taskIdArg(args, "taskId", true)!;
      const tz = await zoneArg(args);
      const patch: Parameters<typeof import("@/lib/chat/tasks").updateTask>[2] = {};
      const title = str(args, "title", { max: 200 });
      if (title !== undefined) patch.title = clean(title);
      if (typeof args.description === "string") patch.description = clean(str(args, "description", { max: 8000 }) ?? "");
      if (args.status != null && args.status !== "") patch.status = oneOf(args, "status", TASK_STATUSES, "todo") as TaskStatus;
      const priority = priorityArg(args);
      if (priority !== undefined) patch.priority = priority;
      if (args.due != null) patch.due = dueArg(args.due, tz, "due");
      const { tasks, store, me } = await modules();
      try {
        const { task } = tasks.getTask(id, me.id);
        if (args.assignees != null || args.addAssignees != null || args.removeAssignees != null) {
          const members = membersOf(store, task.conversationId, me.id);
          // People already assigned may have left the conversation: still resolvable for removal.
          const known = [...members, ...task.assignees.filter((a) => !members.some((m) => m.id === a.id))];
          let ids = args.assignees != null ? resolveMembers(strList(args, "assignees", { max: 50 }), members, me.id, "assignees") : task.assignees.map((a) => a.id);
          const add = resolveMembers(strList(args, "addAssignees", { max: 50 }), members, me.id, "addAssignees");
          const remove = new Set(resolveMembers(strList(args, "removeAssignees", { max: 50 }), known, me.id, "removeAssignees"));
          ids = [...new Set([...ids, ...add])].filter((x) => !remove.has(x));
          patch.assigneeIds = ids;
        }
        if (!Object.keys(patch).length) throw new ToolError("Nothing to update");
        const updated = tasks.updateTask(id, me.id, patch);
        return { updated: true, task: compact(updated, tz, true) };
      } catch (e) {
        chatError(e);
      }
    },
  },
];
