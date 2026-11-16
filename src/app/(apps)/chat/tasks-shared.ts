// Client-safe types and helpers for shared tasks (tasks that live in a chat conversation).
// No server imports here.

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";
export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done"];
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high"];

/**
 * When a task is due. `date` is the wall-clock day ("YYYY-MM-DD") and `time` ("HH:MM", null = any
 * time that day) in `timeZone`, the creator's zone; `at` is the matching instant (end of the day
 * for date-only tasks), used to sort and to tell overdue tasks.
 */
export type TaskDue = { date: string; time: string | null; timeZone: string; at: number };

export type TaskPerson = { id: number; name: string; email: string };

export type Task = {
  id: string;
  conversationId: string;
  /** Subtasks point at their task (one level only). */
  parentId: string | null;
  title: string;
  /** Markdown-lite (same as chat messages). */
  description: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  due: TaskDue | null;
  assignees: TaskPerson[];
  createdBy: TaskPerson;
  created: number;
  updated: number;
  completedAt: number | null;
  /** Position among its siblings (ascending). */
  order: number;
  /** Subtasks of a top-level task (always 0/0 for subtasks). */
  subtasks: { total: number; done: number };
};

/** A task in "My tasks" (across conversations), with where it lives. */
export type MyTask = Task & {
  conversation: { id: string; name: string; kind: "dm" | "group" | "channel" };
  /** Title of the parent task, for subtasks. */
  parentTitle: string | null;
};

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority | null;
  /** Wall-clock due date in the given zone; null = no due date. */
  due?: { date: string; time: string | null; timeZone: string } | null;
  assigneeIds?: number[];
};

export type TaskPatch = Partial<TaskInput> & { order?: number };

export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 8000;
export const TASK_ASSIGNEES_MAX = 50;
/** Subtasks per task and tasks per conversation. */
export const SUBTASKS_MAX = 100;
export const TASKS_PER_CONVERSATION_MAX = 2000;

export const TASK_ID = /^[a-z0-9]{16}$/;
export const isTaskId = (v: unknown): v is string => typeof v === "string" && TASK_ID.test(v);

/** Same-tab request (detail: { conversationId, taskId }) to open a task in the mounted Chat app. */
export const OPEN_TASK_EVENT = "zw-chat-open-task";
export type OpenTaskDetail = { conversationId: string; taskId: string | null };

export const taskHref = (conversationId: string, taskId: string) => `/chat?c=${conversationId}&task=${taskId}`;

export const isOverdue = (t: Pick<Task, "status" | "due">, now = Date.now()) => t.status !== "done" && !!t.due && t.due.at < now;

/** "Overdue" / "Today" / "Upcoming" / "No date" bucket of a task for the viewer (local day). */
export type DueBucket = "overdue" | "today" | "upcoming" | "none";
export function dueBucket(t: Pick<Task, "status" | "due">, now = Date.now()): DueBucket {
  if (!t.due) return "none";
  if (isOverdue(t, now)) return "overdue";
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  // Date-only tasks are due on their wall-clock day wherever the viewer is.
  if (!t.due.time) {
    const d = new Date(now);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return t.due.date <= today ? "today" : "upcoming";
  }
  return t.due.at <= end.getTime() ? "today" : "upcoming";
}
