"use client";

// Chat shell: conversation list on the left, the open conversation on the right (one at a time
// on mobile), live updates from /api/chat/events fanned out to the open views.
import { MessageSquare, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DesktopPrompt } from "./DesktopPrompt";
import { getOverview } from "./actions";
import { Conversation } from "./Conversation";
import { CreateChannelDialog, CreateTeamDialog, NewChatDialog, TeamMembersDialog } from "./Dialogs";
import { AddressBookMenu, PeopleList, PeoplePane, usePeopleData, type PeopleView } from "./People";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { isConversationId, OPEN_CONVERSATION_EVENT, UNREAD_EVENT, type ChatEvent, type ChatOverview, type ConversationSummary } from "./shared";
import { MyTasks } from "./TasksPanel";
import { isTaskId, OPEN_TASK_EVENT, type OpenTaskDetail } from "./tasks-shared";

export type Subscribe = (fn: (e: ChatEvent) => void) => () => void;

type DialogState =
  | { kind: "newChat" }
  | { kind: "newTeam" }
  | { kind: "teamMembers"; teamId: string }
  | { kind: "newChannel"; teamId: string }
  | null;

const urlFor = (id: string | null) => (id ? `/chat?c=${id}` : "/chat");
const TAB_KEY = "zw_chat_tab";

export function ChatApp({ initial, initialId, initialTask = null }: { initial: ChatOverview; initialId: string | null; initialTask?: string | null }) {
  const t = useTranslations("chat");
  const [data, setData] = useState(initial);
  const [activeId, setActiveId] = useState<string | null>(initialId);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [connected, setConnected] = useState(true);
  const [tab, setTabState] = useState<SidebarTab>("chats");
  const [person, setPerson] = useState<PeopleView | null>(null);
  const [scheduleIn, setScheduleIn] = useState<string | null>(null);
  // Open the Tasks panel of a conversation (on a task): from a link, a notification or My tasks.
  const [focusTask, setFocusTask] = useState<{ conversationId: string; taskId: string | null; n: number } | null>(() =>
    initialId && initialTask ? { conversationId: initialId, taskId: initialTask, n: 0 } : null,
  );
  const people = usePeopleData(tab === "people" || person !== null);
  const listeners = useRef(new Set<(e: ChatEvent) => void>());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const dataRef = useRef(data);
  dataRef.current = data;
  const me = data.me;

  const subscribe = useCallback<Subscribe>((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  // Coalesce bursts of "something changed" into one overview refresh.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(async () => {
      const r = await getOverview();
      if (r.ok) setData(r.data);
    }, 250);
  }, []);

  const allConversations = useMemo(() => [...data.chats, ...data.teams.flatMap((tm) => tm.channels)], [data]);
  const active = allConversations.find((c) => c.id === activeId) ?? null;

  // Rail badge: same rule as the server (joined conversations only).
  const total = useMemo(() => allConversations.reduce((n, c) => n + (c.joined ? c.unread : 0), 0), [allConversations]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: total }));
  }, [total]);

  const patch = useCallback((id: string, fn: (c: ConversationSummary) => ConversationSummary) => {
    setData((d) => ({
      ...d,
      chats: d.chats.map((c) => (c.id === id ? fn(c) : c)),
      teams: d.teams.map((tm) => ({ ...tm, channels: tm.channels.map((c) => (c.id === id ? fn(c) : c)) })),
    }));
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      es = new EventSource("/api/chat/events");
      es.onopen = () => {
        setConnected(true);
        refresh(); // catch up on anything missed while disconnected
      };
      es.onerror = () => {
        setConnected(false);
        // The browser retries dropped streams itself, but gives up on HTTP errors; retry those.
        if (es?.readyState === EventSource.CLOSED && !closed) retry = setTimeout(connect, 10_000);
      };
      es.onmessage = onMessage;
    };
    const onMessage = (msg: MessageEvent<string>) => {
      let event: ChatEvent;
      try {
        event = JSON.parse(msg.data) as ChatEvent;
      } catch {
        return;
      }
      for (const fn of listeners.current) fn(event);
      if (event.type === "message") {
        const m = event.message;
        // Ephemeral app notices only show in the open conversation.
        if (m.threadRoot !== null || m.ephemeral) return;
        const known = dataRef.current.chats.some((c) => c.id === m.conversationId) ||
          dataRef.current.teams.some((tm) => tm.channels.some((c) => c.id === m.conversationId));
        // A conversation I haven't seen yet (e.g. someone just DMed me): reload the list.
        if (!known) return refresh();
        const isActive = activeRef.current === m.conversationId && document.visibilityState === "visible";
        patch(m.conversationId, (c) => {
          const mine = m.author?.id === me.id;
          return {
            ...c,
            lastActivity: m.created,
            lastMessage:
              m.kind === "system"
                ? c.lastMessage
                : { preview: m.body || [...(m.meta?.files ?? []), ...(m.meta?.drive ?? [])].map((f) => f.name).join(", ") || m.meta?.meeting?.title || m.meta?.cards?.[0]?.title || "", author: m.author?.name ?? null, kind: m.kind, created: m.created },
            unread: mine || isActive || m.kind === "system" || !c.joined ? c.unread : c.unread + 1,
          };
        });
        setData((d) => ({ ...d, chats: [...d.chats].sort((a, b) => b.lastActivity - a.lastActivity) }));
      } else if (event.type === "read") {
        refresh();
      } else if (event.type === "conversations") {
        refresh();
      }
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [me.id, patch, refresh]);

  const open = useCallback(
    (id: string | null) => {
      setActiveId(id);
      if (id) patch(id, (c) => ({ ...c, unread: 0 }));
      const url = urlFor(id);
      if (window.location.pathname + window.location.search !== url) window.history.pushState(null, "", url);
    },
    [patch],
  );

  const setTab = useCallback((next: SidebarTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (!initialId && (saved === "people" || saved === "tasks")) setTabState(saved);
    } catch {}
  }, [initialId]);

  const openConversation = useCallback(
    (id: string | null) => {
      setPerson(null);
      setScheduleIn(null);
      setFocusTask(null);
      open(id);
    },
    [open],
  );

  const selectPerson = useCallback(
    (v: PeopleView | null) => {
      setPerson(v);
      if (v && activeRef.current) open(null);
    },
    [open],
  );

  // A notification asked to open a conversation while Chat is already on screen.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail;
      if (isConversationId(id)) openConversation(id);
    };
    window.addEventListener(OPEN_CONVERSATION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpen);
  }, [openConversation]);

  const openTask = useCallback(
    (conversationId: string, taskId: string | null) => {
      if (activeRef.current !== conversationId) openConversation(conversationId);
      setFocusTask((f) => ({ conversationId, taskId, n: (f?.n ?? 0) + 1 }));
    },
    [openConversation],
  );

  // System lines and notifications ask to open a task.
  useEffect(() => {
    const onTask = (e: Event) => {
      const d = (e as CustomEvent<OpenTaskDetail>).detail;
      if (d && isConversationId(d.conversationId) && (d.taskId === null || isTaskId(d.taskId))) openTask(d.conversationId, d.taskId);
    };
    window.addEventListener(OPEN_TASK_EVENT, onTask);
    return () => window.removeEventListener(OPEN_TASK_EVENT, onTask);
  }, [openTask]);

  useEffect(() => {
    const onPop = () => setActiveId(new URLSearchParams(window.location.search).get("c"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const dialogTeam = dialog && "teamId" in dialog ? (data.teams.find((tm) => tm.id === dialog.teamId) ?? null) : null;

  const created = (id: string) => {
    setDialog(null);
    refresh();
    openConversation(id);
  };

  const showMain = !!activeId || !!person;

  return (
    <main className="sheet flex min-w-0 flex-1 overflow-hidden">
      <div className={`${showMain ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-line md:w-[300px] md:border-r`}>
        <DesktopPrompt />
        <Sidebar
          data={data}
          activeId={activeId}
          connected={connected}
          onOpen={openConversation}
          tab={tab}
          onTab={setTab}
          renderPeople={(query) => <PeopleList query={query} people={people} view={person} onSelect={selectPerson} />}
          renderTasks={(query) => (
            <MyTasks
              query={query}
              subscribe={subscribe}
              activeId={focusTask && focusTask.conversationId === activeId ? focusTask.taskId : null}
              onOpenTask={openTask}
            />
          )}
          peopleActions={
            <>
              <button
                type="button"
                onClick={() => selectPerson({ kind: "newContact", back: person })}
                disabled={!people.data?.contacts}
                className="icon-btn h-8 w-8"
                aria-label={t("people.newContact")}
                title={t("people.newContact")}
              >
                <UserPlus size={17} aria-hidden />
              </button>
              <AddressBookMenu onImported={() => void people.reload(true)} />
            </>
          }
          onNewChat={() => setDialog({ kind: "newChat" })}
          onNewTeam={() => setDialog({ kind: "newTeam" })}
          onTeamMembers={(teamId) => setDialog({ kind: "teamMembers", teamId })}
          onNewChannel={(teamId) => setDialog({ kind: "newChannel", teamId })}
        />
      </div>
      <section className={`${showMain ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {activeId ? (
          <Conversation
            key={activeId}
            id={activeId}
            me={me}
            summary={active}
            subscribe={subscribe}
            onBack={() => open(null)}
            onChanged={refresh}
            onOpen={openConversation}
            onRead={() => patch(activeId, (c) => ({ ...c, unread: 0 }))}
            autoSchedule={scheduleIn === activeId}
            focusTask={focusTask?.conversationId === activeId ? focusTask : null}
          />
        ) : person ? (
          <PeoplePane
            view={person}
            people={people}
            onSelect={selectPerson}
            onBack={() => setPerson(null)}
            onOpenConversation={(id, schedule) => {
              refresh();
              setTab("chats");
              openConversation(id);
              if (schedule) setScheduleIn(id);
            }}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-10 text-center">
            <div className="rise max-w-sm">
              <span
                className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
                style={{ color: "var(--color-app-chat)" }}
              >
                <MessageSquare size={26} aria-hidden />
              </span>
              <p className="mt-6 text-[17px] font-medium text-ink">{t("emptyTitle")}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{t("emptyBody")}</p>
              <button
                type="button"
                onClick={() => setDialog({ kind: "newChat" })}
                className="mt-6 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-[13.5px] font-medium text-primary-ink hover:bg-primary-hover"
              >
                {t("newChat")}
              </button>
            </div>
          </div>
        )}
      </section>

      {dialog?.kind === "newChat" && <NewChatDialog onClose={() => setDialog(null)} onCreated={created} />}
      {dialog?.kind === "newTeam" && <CreateTeamDialog onClose={() => setDialog(null)} onCreated={created} />}
      {dialog?.kind === "teamMembers" && dialogTeam && (
        <TeamMembersDialog
          team={dialogTeam}
          onClose={() => setDialog(null)}
          onChanged={refresh}
        />
      )}
      {dialog?.kind === "newChannel" && dialogTeam && (
        <CreateChannelDialog team={dialogTeam} onClose={() => setDialog(null)} onCreated={created} />
      )}
    </main>
  );
}
