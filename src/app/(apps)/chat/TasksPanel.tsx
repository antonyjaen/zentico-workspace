"use client";

// Shared tasks in Chat: the conversation's Tasks side panel (list grouped by status, filters,
// create, task detail with subtasks) and "My tasks" across conversations (sidebar tab).
// Data comes from task-actions; live updates arrive as { type: "tasks" } chat events.
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Flag,
  ListChecks,
  Loader2,
  Plus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePopover } from "@/components/usePopover";
import type { Subscribe } from "./ChatApp";
import { Markdown } from "./Markdown";
import { PanelHeader } from "./Panels";
import type { ChatUser, ConversationDetail } from "./shared";
import { createTask, deleteTask, listMyTasks, listTasks, updateTask } from "./task-actions";
import {
  dueBucket,
  isOverdue,
  TASK_DESCRIPTION_MAX,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  type DueBucket,
  type MyTask,
  type Task,
  type TaskDue,
  type TaskInput,
  type TaskPerson,
  type TaskPriority,
  type TaskStatus,
} from "./tasks-shared";
import { Avatar, BTN, BTN_PRIMARY, fold, useErrorText } from "./ui";

type Filter = "all" | "mine" | "done";
type DueValue = { date: string; time: string | null; timeZone: string } | null;

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDaysKey = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return keyOf(d);
};

/** Refetches on { type: "tasks" } events (optionally for one conversation), coalescing bursts. */
function useTaskEvents(subscribe: Subscribe, conversationId: string | null, reload: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = subscribe((e) => {
      if (e.type !== "tasks" || (conversationId && e.conversationId !== conversationId)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 150);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [subscribe, conversationId, reload]);
}

// ---------- Small pieces ----------

/** Due date as the viewer reads it: "Today 15:00", "Tomorrow", "Mon 3 Mar"… */
function useDueText() {
  const t = useTranslations("tasks");
  const locale = useLocale();
  return useCallback(
    (due: TaskDue) => {
      const timed = !!due.time;
      const key = timed ? keyOf(new Date(due.at)) : due.date;
      const rel =
        key === addDaysKey(0)
          ? t("today")
          : key === addDaysKey(1)
            ? t("tomorrow")
            : key === addDaysKey(-1)
              ? t("yesterday")
              : new Date(`${key}T12:00:00Z`).toLocaleDateString(locale, {
                  timeZone: "UTC",
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  ...(key.slice(0, 4) !== String(new Date().getFullYear()) ? { year: "numeric" } : {}),
                });
      return timed ? `${rel} ${new Date(due.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` : rel;
    },
    [locale, t],
  );
}

function DueChip({ task }: { task: Pick<Task, "due" | "status"> }) {
  const dueText = useDueText();
  const t = useTranslations("tasks");
  if (!task.due) return null;
  const late = isOverdue(task);
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11.5px] tabular-nums ${late ? "font-medium text-danger" : task.status === "done" ? "text-ink-mute" : "text-ink-soft"}`}
      title={late ? t("overdue") : t("due")}
    >
      <CalendarDays size={12} aria-hidden />
      {dueText(task.due)}
    </span>
  );
}

function PriorityFlag({ priority }: { priority: TaskPriority | null }) {
  const t = useTranslations("tasks");
  if (!priority || priority === "low") return null;
  return (
    <span className={priority === "high" ? "text-danger" : "text-amber"} title={t(`priority.${priority}`)}>
      <Flag size={12} aria-label={t(`priority.${priority}`)} />
    </span>
  );
}

function Assignees({ people, size = 20, max = 3 }: { people: TaskPerson[]; size?: number; max?: number }) {
  if (!people.length) return null;
  return (
    <span className="flex shrink-0 -space-x-1.5" title={people.map((p) => p.name).join(", ")}>
      {people.slice(0, max).map((p) => (
        <Avatar key={p.id} name={p.name} email={p.email} size={size} className="ring-2 ring-sheet" />
      ))}
      {people.length > max && (
        <span
          className="grid shrink-0 place-items-center rounded-full bg-hover text-[10px] font-medium text-ink-soft ring-2 ring-sheet"
          style={{ width: size, height: size }}
        >
          +{people.length - max}
        </span>
      )}
    </span>
  );
}

/** Round "done" toggle. */
function CheckButton({ done, onToggle, label, disabled }: { done: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50 ${
        done ? "border-signal bg-signal text-white" : "border-line-strong text-transparent hover:border-signal hover:text-signal"
      }`}
    >
      <Check size={11} strokeWidth={3} aria-hidden />
    </button>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const t = useTranslations("tasks");
  if (!total) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-mute tabular-nums" title={t("subtasksProgress", { done, total })}>
      <ListChecks size={12} aria-hidden />
      {done}/{total}
    </span>
  );
}

/** Pick assignees among the conversation's people. */
function AssigneePicker({
  members,
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  members: TaskPerson[];
  value: TaskPerson[];
  onChange: (ids: number[]) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("tasks");
  const pop = usePopover();
  const [query, setQuery] = useState("");
  const listId = useId();
  const picked = new Set(value.map((p) => p.id));
  const q = fold(query.trim());
  // Former members stay listed while assigned (so they can be removed).
  const options = [...members, ...value.filter((p) => !members.some((m) => m.id === p.id))].filter(
    (m) => !q || fold(m.name).includes(q) || fold(m.email).includes(q),
  );
  const toggle = (id: number) => onChange(picked.has(id) ? [...picked].filter((x) => x !== id) : [...picked, id]);
  // The panel scrolls (overflow) and sits beside the chat, so an absolute menu got clipped. Pin it to
  // the viewport next to the button instead, flipping up when there's no room below.
  const button = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  const MENU_W = 256;
  const MENU_H = 340;
  const measure = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    const below = window.innerHeight - r.bottom;
    setPlace(
      below >= MENU_H || below >= r.top
        ? { left, top: r.bottom + 4, maxHeight: Math.max(160, below - 12) }
        : { left, bottom: window.innerHeight - r.top + 4, maxHeight: Math.max(160, r.top - 12) },
    );
  }, []);
  useEffect(() => {
    if (!pop.open) return;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [pop.open, measure]);
  return (
    <div ref={pop.ref} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => (pop.toggle(), setQuery(""))}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-label={value.length ? t("assignedTo", { names: value.map((p) => p.name).join(", ") }) : t("assign")}
        title={value.length ? value.map((p) => p.name).join(", ") : t("assign")}
        className={
          compact
            ? "flex h-7 items-center gap-1 rounded-md px-1 text-ink-mute hover:bg-hover hover:text-ink disabled:opacity-50"
            : `${BTN} max-w-full`
        }
      >
        {value.length ? <Assignees people={value} size={compact ? 18 : 20} /> : <UserPlus size={compact ? 14 : 15} aria-hidden />}
        {!compact && <span className="truncate">{value.length ? t("assigneeCount", { count: value.length }) : t("assign")}</span>}
      </button>
      {pop.open && place && (
        <div className="pop fixed z-[70] flex w-64 flex-col p-1.5" style={place}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && options[0]) {
                e.preventDefault();
                toggle(options[0].id);
                setQuery("");
              }
            }}
            placeholder={t("searchMembers")}
            aria-label={t("searchMembers")}
            aria-controls={listId}
            maxLength={100}
            className="mb-1 h-8 w-full rounded-md border border-line bg-sheet px-2 text-[13px] text-ink outline-none placeholder:text-ink-mute focus:border-ink-mute"
          />
          <ul id={listId} role="listbox" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {options.length === 0 && <li className="px-2 py-2 text-[12.5px] text-ink-mute">{t("noMembers")}</li>}
            {options.map((m) => (
              <li key={m.id} role="option" aria-selected={picked.has(m.id)}>
                <button
                  type="button"
                  onClick={() => toggle(m.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                >
                  <Avatar name={m.name} email={m.email} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{m.name || m.email}</span>
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${picked.has(m.id) ? "border-primary bg-primary text-primary-ink" : "border-line-strong text-transparent"}`}
                    aria-hidden
                  >
                    <Check size={11} strokeWidth={3} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Date (+ optional time) in the viewer's zone; saved with that zone. */
function DueEditor({ value, onChange, disabled = false }: { value: TaskDue | null; onChange: (v: DueValue) => void; disabled?: boolean }) {
  const t = useTranslations("tasks");
  // Show timed dues in my zone (edits are then saved in my zone too); date-only dues are wall-clock days.
  const date = value ? (value.time ? keyOf(new Date(value.at)) : value.date) : "";
  const time = value?.time ? `${pad(new Date(value.at).getHours())}:${pad(new Date(value.at).getMinutes())}` : "";
  const emit = (d: string, tm: string) => onChange(d ? { date: d, time: tm || null, timeZone: localTz() } : null);
  const field =
    "h-8 rounded-md border border-line bg-sheet px-2 text-[13px] text-ink outline-none transition-colors hover:border-line-strong focus:border-ink-mute disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="date"
        value={date}
        disabled={disabled}
        onChange={(e) => emit(e.target.value, time)}
        aria-label={t("dueDate")}
        className={field}
      />
      {date && (
        <input
          type="time"
          value={time}
          disabled={disabled}
          onChange={(e) => emit(date, e.target.value)}
          aria-label={t("dueTime")}
          className={`${field} w-[7.5rem]`}
        />
      )}
      {date && (
        <button type="button" onClick={() => onChange(null)} disabled={disabled} className="icon-btn h-7 w-7" aria-label={t("clearDue")} title={t("clearDue")}>
          <X size={14} aria-hidden />
        </button>
      )}
      {!date && (
        <span className="flex gap-1">
          <button type="button" onClick={() => emit(addDaysKey(0), "")} disabled={disabled} className="rounded-md px-1.5 py-1 text-[12px] text-ink-mute hover:bg-hover hover:text-ink">
            {t("today")}
          </button>
          <button type="button" onClick={() => emit(addDaysKey(1), "")} disabled={disabled} className="rounded-md px-1.5 py-1 text-[12px] text-ink-mute hover:bg-hover hover:text-ink">
            {t("tomorrow")}
          </button>
        </span>
      )}
    </div>
  );
}

function PrioritySelect({ value, onChange, disabled = false }: { value: TaskPriority | null; onChange: (p: TaskPriority | null) => void; disabled?: boolean }) {
  const t = useTranslations("tasks");
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange((e.target.value || null) as TaskPriority | null)}
      aria-label={t("priorityLabel")}
      className="h-8 rounded-md border border-line bg-sheet px-2 text-[13px] text-ink outline-none hover:border-line-strong focus:border-ink-mute disabled:opacity-50"
    >
      <option value="">{t("priority.none")}</option>
      {TASK_PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {t(`priority.${p}`)}
        </option>
      ))}
    </select>
  );
}

// ---------- Conversation panel ----------

export function TasksPanel({
  conversation,
  me,
  subscribe,
  focus,
  onClose,
}: {
  conversation: ConversationDetail;
  me: ChatUser;
  subscribe: Subscribe;
  /** Task to open (from a system line, notification or My tasks); `n` re-triggers the same task. */
  focus: { taskId: string | null; n: number } | null;
  onClose: () => void;
}) {
  const t = useTranslations("tasks");
  const errorText = useErrorText();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(focus?.taskId ?? null);
  const [creating, setCreating] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = useMemo<TaskPerson[]>(
    () => conversation.members.filter((m) => !m.bot).map((m) => ({ id: m.id, name: m.name, email: m.email })),
    [conversation.members],
  );

  const reload = useCallback(async () => {
    const r = await listTasks(conversation.id);
    if (r.ok) {
      setTasks(r.data);
      setFailed(null);
    } else setFailed(r.error);
  }, [conversation.id]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useTaskEvents(subscribe, conversation.id, reload);

  useEffect(() => {
    if (focus) setOpenId(focus.taskId);
  }, [focus]);

  // Apply a saved task right away (the live event refreshes everything else).
  const put = useCallback((task: Task) => setTasks((list) => (list ? (list.some((x) => x.id === task.id) ? list.map((x) => (x.id === task.id ? task : x)) : [...list, task]) : list)), []);

  const save = useCallback(
    async (id: string, patch: Parameters<typeof updateTask>[1]) => {
      setError(null);
      const r = await updateTask(id, patch);
      if (!r.ok) {
        setError(errorText(r.error));
        return false;
      }
      put(r.data);
      return true;
    },
    [errorText, put],
  );

  const top = useMemo(() => (tasks ?? []).filter((x) => !x.parentId), [tasks]);
  const subsOf = useCallback((id: string) => (tasks ?? []).filter((x) => x.parentId === id), [tasks]);
  const mineIds = useMemo(() => {
    const out = new Set<string>();
    for (const x of tasks ?? []) if (x.assignees.some((a) => a.id === me.id)) out.add(x.parentId ?? x.id);
    return out;
  }, [tasks, me.id]);

  const visible = top.filter((x) => (filter === "mine" ? mineIds.has(x.id) : true));
  const groups: { status: TaskStatus; items: Task[] }[] =
    filter === "done"
      ? [{ status: "done", items: visible.filter((x) => x.status === "done").sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)) }]
      : (["todo", "in_progress", "done"] as const).map((status) => ({
          status,
          items: visible
            .filter((x) => x.status === status)
            .sort(status === "done" ? (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) : (a, b) => a.order - b.order),
        }));
  const openCount = top.filter((x) => x.status !== "done").length;
  const current = openId ? (tasks?.find((x) => x.id === openId) ?? null) : null;
  const where = conversation.kind === "channel" ? `#${conversation.name}` : conversation.name;

  if (openId && tasks && !current) {
    // Deleted (or never visible): back to the list.
    return (
      <>
        <PanelHeader title={t("title")} sub={where} onClose={onClose} />
        <div className="p-6 text-center">
          <p className="text-[13px] text-ink-mute">{t("gone")}</p>
          <button type="button" onClick={() => setOpenId(null)} className={`${BTN} mt-3`}>
            <ArrowLeft size={14} aria-hidden />
            {t("allTasks")}
          </button>
        </div>
      </>
    );
  }

  if (current) {
    return (
      <TaskDetail
        key={current.id}
        task={current}
        subtasks={subsOf(current.id).sort((a, b) => a.order - b.order)}
        parent={current.parentId ? (tasks?.find((x) => x.id === current.parentId) ?? null) : null}
        members={members}
        me={me}
        where={where}
        error={error}
        onSave={save}
        onPut={put}
        onOpen={setOpenId}
        onBack={() => (setOpenId(null), setError(null))}
        onClose={onClose}
        onDeleted={() => {
          setOpenId(current.parentId);
          void reload();
        }}
        onError={setError}
      />
    );
  }

  return (
    <>
      <PanelHeader title={t("title")} sub={tasks ? `${where} · ${t("openCount", { count: openCount })}` : where} onClose={onClose} />
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <div role="tablist" aria-label={t("filter")} className="grid flex-1 grid-cols-3 gap-1 rounded-md bg-sheet-muted p-0.5">
          {(["all", "mine", "done"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className="h-7 rounded text-[12.5px] font-medium text-ink-mute transition-colors hover:text-ink aria-selected:bg-sheet aria-selected:text-ink aria-selected:shadow-sm"
            >
              {t(`filters.${f}`)}
            </button>
          ))}
        </div>
        {conversation.joined && (
          <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY} aria-label={t("newTask")} title={t("newTask")}>
            <Plus size={15} aria-hidden />
            <span className="hidden sm:inline">{t("new")}</span>
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mx-3 mt-2 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4">
        {creating && (
          <NewTaskForm
            members={members}
            me={me}
            onCancel={() => setCreating(false)}
            onCreate={async (input) => {
              const r = await createTask(conversation.id, input);
              if (!r.ok) return errorText(r.error);
              put(r.data);
              setCreating(false);
              return null;
            }}
          />
        )}
        {!conversation.joined ? (
          <p className="p-6 text-center text-[13px] text-ink-mute">{t("membersOnly")}</p>
        ) : failed ? (
          <p className="p-6 text-center text-[13px] text-ink-mute">{errorText(failed)}</p>
        ) : !tasks ? (
          <div className="grid h-32 place-items-center">
            <Loader2 size={18} className="animate-spin text-ink-mute" aria-label={t("loading")} />
          </div>
        ) : visible.length === 0 && !creating ? (
          <div className="px-4 py-10 text-center">
            <ListChecks size={28} className="mx-auto text-ink-mute" aria-hidden />
            <p className="mt-3 text-[13.5px] font-medium text-ink">{filter === "all" ? t("emptyTitle") : filter === "mine" ? t("emptyMine") : t("emptyDone")}</p>
            {filter === "all" && <p className="mt-1 text-[12.5px] text-ink-mute">{t("emptyBody")}</p>}
            {filter === "all" && (
              <button type="button" onClick={() => setCreating(true)} className={`${BTN_PRIMARY} mt-4`}>
                <Plus size={15} aria-hidden />
                {t("newTask")}
              </button>
            )}
          </div>
        ) : (
          groups.map(({ status, items }) => {
            if (!items.length && (status === "done" || filter === "done")) return null;
            const collapsible = status === "done" && filter !== "done";
            const open = !collapsible || showDone;
            return (
              <section key={status} className="mt-2" aria-label={t(`status.${status}`)}>
                {collapsible ? (
                  <button
                    type="button"
                    onClick={() => setShowDone((v) => !v)}
                    aria-expanded={open}
                    className="flex h-7 w-full items-center gap-1 px-1 text-left font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase hover:text-ink"
                  >
                    {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                    {t(`status.${status}`)} · {items.length}
                  </button>
                ) : (
                  filter !== "done" && (
                    <h4 className="flex h-7 items-center px-1 font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">
                      {t(`status.${status}`)} · {items.length}
                    </h4>
                  )
                )}
                {open && (
                  <ul className="space-y-px">
                    {items.length === 0 && <li className="px-2 py-1.5 text-[12.5px] text-ink-mute">{t("none")}</li>}
                    {items.map((task) => (
                      <li key={task.id}>
                        <TaskRow
                          task={task}
                          onOpen={() => setOpenId(task.id)}
                          onToggle={() => void save(task.id, { status: task.status === "done" ? "todo" : "done" })}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </>
  );
}

function TaskRow({ task, onOpen, onToggle, context }: { task: Task; onOpen: () => void; onToggle: () => void; context?: React.ReactNode }) {
  const t = useTranslations("tasks");
  const done = task.status === "done";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="pt-px">
        <CheckButton done={done} onToggle={onToggle} label={done ? t("markOpen", { title: task.title }) : t("markDone", { title: task.title })} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 text-[13.5px] leading-snug break-words ${done ? "text-ink-mute line-through" : "text-ink"}`}>{task.title}</span>
          <PriorityFlag priority={task.priority} />
        </span>
        {context}
        {(task.due || task.subtasks.total > 0 || task.status === "in_progress") && (
          <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            {task.status === "in_progress" && <span className="text-[11.5px] font-medium text-accent">{t("status.in_progress")}</span>}
            <DueChip task={task} />
            <Progress {...task.subtasks} />
          </span>
        )}
      </span>
      <Assignees people={task.assignees} />
    </div>
  );
}

function NewTaskForm({
  members,
  me,
  onCreate,
  onCancel,
  compact = false,
}: {
  members: TaskPerson[];
  me: ChatUser;
  /** Returns an error message, or null when created. */
  onCreate: (input: TaskInput) => Promise<string | null>;
  onCancel: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("tasks");
  const [title, setTitle] = useState("");
  const [assignees, setAssignees] = useState<number[]>([]);
  const [due, setDue] = useState<DueValue>(null);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const people = [{ id: me.id, name: me.name, email: me.email }, ...members.filter((m) => m.id !== me.id)];
  const picked = people.filter((p) => assignees.includes(p.id));
  // DueEditor wants a TaskDue; build one for display (at is only used for timed values).
  const dueView: TaskDue | null = due
    ? { ...due, at: due.time ? new Date(`${due.date}T${due.time}:00`).getTime() : new Date(`${due.date}T23:59:59`).getTime() }
    : null;

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCreate({ title, assigneeIds: assignees, due, priority });
    setBusy(false);
    if (err) setError(err);
    else if (compact) {
      setTitle("");
      setAssignees([]);
      setDue(null);
      inputRef.current?.focus();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
      className={compact ? "mt-1" : "rise mb-2 rounded-lg border border-line bg-sheet p-2.5 shadow-sm"}
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TASK_TITLE_MAX}
          placeholder={compact ? t("addSubtask") : t("titlePlaceholder")}
          aria-label={compact ? t("addSubtask") : t("titleLabel")}
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-sheet px-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute"
        />
        {compact && (
          <>
            <AssigneePicker members={people} value={picked} onChange={setAssignees} compact />
            <button type="submit" disabled={!title.trim() || busy} className="icon-btn h-8 w-8" aria-label={t("add")} title={t("add")}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={15} aria-hidden />}
            </button>
          </>
        )}
      </div>
      {!compact && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <AssigneePicker members={people} value={picked} onChange={setAssignees} />
            <PrioritySelect value={priority} onChange={setPriority} />
          </div>
          <div className="mt-2">
            <DueEditor value={dueView} onChange={setDue} />
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}
      {!compact && (
        <div className="mt-2.5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={BTN}>
            {t("cancel")}
          </button>
          <button type="submit" disabled={!title.trim() || busy} className={BTN_PRIMARY}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t("create")}
          </button>
        </div>
      )}
    </form>
  );
}

function TaskDetail({
  task,
  subtasks,
  parent,
  members,
  me,
  where,
  error,
  onSave,
  onPut,
  onOpen,
  onBack,
  onClose,
  onDeleted,
  onError,
}: {
  task: Task;
  subtasks: Task[];
  parent: Task | null;
  members: TaskPerson[];
  me: ChatUser;
  where: string;
  error: string | null;
  onSave: (id: string, patch: Parameters<typeof updateTask>[1]) => Promise<boolean>;
  onPut: (task: Task) => void;
  onOpen: (id: string | null) => void;
  onBack: () => void;
  onClose: () => void;
  onDeleted: () => void;
  onError: (e: string | null) => void;
}) {
  const t = useTranslations("tasks");
  const locale = useLocale();
  const errorText = useErrorText();
  const [title, setTitle] = useState(task.title);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(task.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  const meHandle = me.email.split("@")[0].toLowerCase();

  // Someone else edited it: follow, unless I'm in the middle of typing.
  const titleFocused = useRef(false);
  useEffect(() => {
    if (!titleFocused.current) setTitle(task.title);
  }, [task.title]);
  useEffect(() => {
    if (!editingDesc) setDesc(task.description);
  }, [task.description, editingDesc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  const saveTitle = async () => {
    const next = title.replace(/\s+/g, " ").trim();
    if (!next) return setTitle(task.title);
    if (next !== task.title) await onSave(task.id, { title: next });
  };

  const canDelete = task.createdBy.id === me.id || !members.some((m) => m.id === task.createdBy.id);
  const doneSubs = subtasks.filter((s) => s.status === "done").length;
  const people = [{ id: me.id, name: me.name, email: me.email }, ...members.filter((m) => m.id !== me.id)];

  const remove = async () => {
    setConfirmDelete(false);
    const r = await deleteTask(task.id);
    if (!r.ok) return onError(errorText(r.error));
    onDeleted();
  };

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={() => (parent ? onOpen(parent.id) : onBack())}
          className="icon-btn h-8 w-8"
          aria-label={parent ? t("backToTask", { title: parent.title }) : t("allTasks")}
          title={parent ? parent.title : t("allTasks")}
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] text-ink-mute">{parent ? `${where} › ${parent.title}` : where}</p>
          <p className="truncate text-[13px] font-semibold text-ink">{parent ? t("subtask") : t("task")}</p>
        </div>
        {canDelete && (
          <button type="button" onClick={() => setConfirmDelete(true)} className="icon-btn h-8 w-8 hover:text-danger" aria-label={t("delete")} title={t("delete")}>
            <Trash2 size={15} aria-hidden />
          </button>
        )}
        <button type="button" onClick={onClose} className="icon-btn h-8 w-8" aria-label={t("close")}>
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {confirmDelete && (
          <div role="alertdialog" aria-label={t("delete")} className="mb-3 rounded-lg border border-danger/40 bg-danger/5 p-3">
            <p className="text-[13px] text-ink">{task.subtasks.total ? t("confirmDeleteWithSubtasks", { count: task.subtasks.total }) : t("confirmDelete")}</p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className={BTN} autoFocus>
                {t("cancel")}
              </button>
              <button type="button" onClick={() => void remove()} className={`${BTN} border-danger/50 text-danger hover:bg-danger/10 hover:text-danger`}>
                {t("delete")}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}

        <div className="flex items-start gap-2.5">
          <span className="pt-2">
            <CheckButton
              done={task.status === "done"}
              onToggle={() => void onSave(task.id, { status: task.status === "done" ? "todo" : "done" })}
              label={task.status === "done" ? t("markOpen", { title: task.title }) : t("markDone", { title: task.title })}
            />
          </span>
          <textarea
            value={title}
            rows={1}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
            onFocus={() => (titleFocused.current = true)}
            onBlur={() => {
              titleFocused.current = false;
              void saveTitle();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setTitle(task.title);
                e.currentTarget.blur();
              }
            }}
            maxLength={TASK_TITLE_MAX}
            aria-label={t("titleLabel")}
            className={`field-sizing-content min-h-9 w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[16px] leading-snug font-semibold outline-none hover:border-line focus:border-ink-mute ${task.status === "done" ? "text-ink-mute line-through" : "text-ink"}`}
          />
        </div>

        <dl className="mt-4 grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-2.5 text-[13px]">
          <dt className="text-ink-mute">{t("statusLabel")}</dt>
          <dd>
            <div role="radiogroup" aria-label={t("statusLabel")} className="inline-grid grid-cols-3 gap-0.5 rounded-md bg-sheet-muted p-0.5">
              {(["todo", "in_progress", "done"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={task.status === s}
                  onClick={() => task.status !== s && void onSave(task.id, { status: s })}
                  className="h-7 rounded px-2 text-[12px] font-medium whitespace-nowrap text-ink-mute transition-colors hover:text-ink aria-checked:bg-sheet aria-checked:text-ink aria-checked:shadow-sm"
                >
                  {t(`status.${s}`)}
                </button>
              ))}
            </div>
          </dd>

          <dt className="text-ink-mute">{t("assigneesLabel")}</dt>
          <dd className="min-w-0">
            <AssigneePicker members={people} value={task.assignees} onChange={(ids) => void onSave(task.id, { assigneeIds: ids })} />
          </dd>

          <dt className="text-ink-mute">{t("due")}</dt>
          <dd>
            <DueEditor value={task.due} onChange={(due) => void onSave(task.id, { due })} />
            {task.due && isOverdue(task) && <p className="mt-1 text-[12px] font-medium text-danger">{t("overdue")}</p>}
            {task.due?.time && task.due.timeZone !== localTz() && (
              <p className="mt-1 text-[11.5px] text-ink-mute">{t("setInZone", { zone: task.due.timeZone.replace(/_/g, " ") })}</p>
            )}
          </dd>

          <dt className="text-ink-mute">{t("priorityLabel")}</dt>
          <dd>
            <PrioritySelect value={task.priority} onChange={(priority) => void onSave(task.id, { priority })} />
          </dd>
        </dl>

        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("descriptionLabel")}</h4>
            {!editingDesc && (
              <button type="button" onClick={() => setEditingDesc(true)} className="text-[12px] text-accent hover:underline">
                {task.description ? t("edit") : t("addDescription")}
              </button>
            )}
          </div>
          {editingDesc ? (
            <div>
              <textarea
                autoFocus
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDesc(task.description);
                    setEditingDesc(false);
                  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void onSave(task.id, { description: desc }).then((ok) => ok && setEditingDesc(false));
                  }
                }}
                maxLength={TASK_DESCRIPTION_MAX}
                rows={5}
                placeholder={t("descriptionPlaceholder")}
                aria-label={t("descriptionLabel")}
                className="w-full resize-y rounded-md border border-line bg-sheet px-2.5 py-2 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-mute focus:border-ink-mute"
              />
              <div className="mt-1.5 flex items-center justify-end gap-2">
                <span className="mr-auto text-[11.5px] text-ink-mute">{t("descriptionHint")}</span>
                <button type="button" onClick={() => (setDesc(task.description), setEditingDesc(false))} className={BTN}>
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void onSave(task.id, { description: desc }).then((ok) => ok && setEditingDesc(false))}
                  className={BTN_PRIMARY}
                >
                  {t("save")}
                </button>
              </div>
            </div>
          ) : task.description ? (
            <div className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-ink">
              <Markdown text={task.description} meHandle={meHandle} />
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-mute">{t("noDescription")}</p>
          )}
        </div>

        {!task.parentId && (
          <div className="mt-6">
            <div className="mb-1.5 flex items-center gap-2">
              <h4 className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{t("subtasks")}</h4>
              {subtasks.length > 0 && (
                <span className="text-[11.5px] text-ink-mute tabular-nums">
                  {doneSubs}/{subtasks.length}
                </span>
              )}
            </div>
            {subtasks.length > 0 && (
              <div
                className="mb-2 h-1.5 overflow-hidden rounded-full bg-sheet-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={subtasks.length}
                aria-valuenow={doneSubs}
                aria-label={t("subtasksProgress", { done: doneSubs, total: subtasks.length })}
              >
                <div className="h-full rounded-full bg-signal transition-[width]" style={{ width: `${(doneSubs / subtasks.length) * 100}%` }} />
              </div>
            )}
            <ul className="space-y-px">
              {subtasks.map((s) => (
                <li key={s.id}>
                  <TaskRow
                    task={s}
                    onOpen={() => onOpen(s.id)}
                    onToggle={() => void onSave(s.id, { status: s.status === "done" ? "todo" : "done" })}
                  />
                </li>
              ))}
            </ul>
            {addingSub ? (
              <NewTaskForm
                compact
                members={members}
                me={me}
                onCancel={() => setAddingSub(false)}
                onCreate={async (input) => {
                  const r = await createTask(task.conversationId, input, task.id);
                  if (!r.ok) return errorText(r.error);
                  onPut(r.data);
                  onPut({ ...task, subtasks: { total: task.subtasks.total + 1, done: task.subtasks.done } });
                  return null;
                }}
              />
            ) : (
              <button type="button" onClick={() => setAddingSub(true)} className="mt-1 flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-mute hover:bg-hover hover:text-ink">
                <Plus size={14} aria-hidden />
                {t("addSubtask")}
              </button>
            )}
          </div>
        )}

        <p className="mt-6 text-[11.5px] text-ink-mute">
          {t("createdBy", {
            name: task.createdBy.id === me.id ? t("you") : task.createdBy.name || t("someone"),
            date: new Date(task.created).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }),
          })}
          {task.completedAt && ` · ${t("completedOn", { date: new Date(task.completedAt).toLocaleDateString(locale, { day: "numeric", month: "short" }) })}`}
        </p>
      </div>
    </>
  );
}

// ---------- My tasks (sidebar tab) ----------

const BUCKETS: DueBucket[] = ["overdue", "today", "upcoming", "none"];

export function MyTasks({
  query,
  subscribe,
  activeId,
  onOpenTask,
}: {
  query: string;
  subscribe: Subscribe;
  activeId: string | null;
  onOpenTask: (conversationId: string, taskId: string) => void;
}) {
  const t = useTranslations("tasks");
  const errorText = useErrorText();
  const [items, setItems] = useState<MyTask[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const reload = useCallback(async () => {
    const r = await listMyTasks(false);
    if (r.ok) {
      setItems(r.data);
      setFailed(null);
    } else setFailed(r.error);
  }, []);
  useEffect(() => {
    void reload();
    // Buckets move with the clock (today → overdue).
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  useTaskEvents(subscribe, null, reload);

  const complete = async (task: MyTask) => {
    setItems((list) => list?.filter((x) => x.id !== task.id) ?? list);
    const r = await updateTask(task.id, { status: "done" });
    if (!r.ok) {
      setFailed(r.error);
      void reload();
    }
  };

  const q = fold(query.trim());
  const shown = (items ?? []).filter(
    (x) => !q || fold(x.title).includes(q) || fold(x.conversation.name).includes(q) || (x.parentTitle && fold(x.parentTitle).includes(q)),
  );
  const now = Date.now();

  if (failed && !items) return <p className="px-2 py-3 text-[12.5px] text-ink-mute">{errorText(failed)}</p>;
  if (!items)
    return (
      <div className="grid h-24 place-items-center">
        <Loader2 size={16} className="animate-spin text-ink-mute" aria-label={t("loading")} />
      </div>
    );
  if (!shown.length)
    return (
      <div className="px-3 py-8 text-center">
        <ListChecks size={26} className="mx-auto text-ink-mute" aria-hidden />
        <p className="mt-3 text-[13px] font-medium text-ink">{q ? t("noMatches") : t("myEmptyTitle")}</p>
        {!q && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-mute">{t("myEmptyBody")}</p>}
      </div>
    );

  return (
    <div>
      {failed && <p className="px-2 pt-2 text-[12px] text-danger">{errorText(failed)}</p>}
      {BUCKETS.map((b) => {
        const list = shown.filter((x) => dueBucket(x, now) === b);
        if (!list.length) return null;
        return (
          <section key={b} aria-label={t(`bucket.${b}`)}>
            <h3 className={`flex items-center px-2 pt-3 pb-1 font-mono text-[10.5px] tracking-[0.16em] uppercase ${b === "overdue" ? "text-danger" : "text-ink-mute"}`}>
              {t(`bucket.${b}`)} · {list.length}
            </h3>
            <ul className="space-y-px">
              {list.map((task) => (
                <li key={task.id} className={task.id === activeId ? "rounded-md bg-primary-soft" : undefined}>
                  <TaskRow
                    task={task}
                    onOpen={() => onOpenTask(task.conversation.id, task.id)}
                    onToggle={() => void complete(task)}
                    context={
                      <span className="mt-0.5 block truncate text-[12px] text-ink-mute">
                        {task.conversation.name}
                        {task.parentTitle ? ` › ${task.parentTitle}` : ""}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
