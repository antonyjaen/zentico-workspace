"use server";

// Task server actions for Chat. Each resolves the signed-in user, checks argument shapes, and
// lets lib/chat/tasks validate values and authorize by conversation membership.
import { unstable_rethrow } from "next/navigation";
import { chatUser } from "@/lib/chat/session";
import { ChatError } from "@/lib/chat/store";
import * as tasks from "@/lib/chat/tasks";
import { isConversationId, type ActionResult, type ChatUser } from "./shared";
import { isTaskId, type MyTask, type Task, type TaskInput, type TaskPatch } from "./tasks-shared";

class InputError extends Error {}

async function act<T>(fn: (me: ChatUser) => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    const me = await chatUser();
    if (me.bot) throw new InputError("forbidden");
    return { ok: true, data: await fn(me) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ChatError || e instanceof InputError) return { ok: false, error: e.message };
    console.error("[chat] task action failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  }
}

function convId(v: unknown): string {
  if (!isConversationId(v)) throw new InputError("invalid");
  return v;
}
function taskId(v: unknown): string {
  if (!isTaskId(v)) throw new InputError("invalid");
  return v;
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError("invalid");
  return v as Record<string, unknown>;
}

/** Only the known fields, so nothing else reaches the store. */
function input(v: unknown): TaskInput {
  const o = obj(v);
  return {
    title: o.title as string,
    description: o.description as string | undefined,
    status: o.status as TaskInput["status"],
    priority: o.priority as TaskInput["priority"],
    due: o.due as TaskInput["due"],
    assigneeIds: o.assigneeIds as number[] | undefined,
  };
}
function patch(v: unknown): TaskPatch {
  const o = obj(v);
  const out: TaskPatch = {};
  for (const k of ["title", "description", "status", "priority", "due", "assigneeIds", "order"] as const) {
    if (k in o) (out as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

export async function listTasks(conversationId: string): Promise<ActionResult<Task[]>> {
  return act((me) => tasks.listTasks(convId(conversationId), me.id));
}

export async function listMyTasks(includeDone = false): Promise<ActionResult<MyTask[]>> {
  return act((me) => tasks.listMyTasks(me.id, { includeDone: includeDone === true }));
}

export async function createTask(conversationId: string, data: TaskInput, parentId: string | null = null): Promise<ActionResult<Task>> {
  return act((me) => tasks.createTask(convId(conversationId), me.id, { ...input(data), parentId: parentId == null ? null : taskId(parentId) }));
}

export async function updateTask(id: string, data: TaskPatch): Promise<ActionResult<Task>> {
  return act((me) => tasks.updateTask(taskId(id), me.id, patch(data)));
}

export async function deleteTask(id: string): Promise<ActionResult> {
  return act((me) => tasks.deleteTask(taskId(id), me.id));
}
