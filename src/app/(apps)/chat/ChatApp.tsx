"use client";

// Chat shell: conversation list on the left, the open conversation on the right (one at a time
// on mobile), live updates from /api/chat/events fanned out to the open views.
import { MessageSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOverview } from "./actions";
import { Conversation } from "./Conversation";
import { CreateChannelDialog, CreateTeamDialog, NewChatDialog, TeamMembersDialog } from "./Dialogs";
import { Sidebar } from "./Sidebar";
import { UNREAD_EVENT, type ChatEvent, type ChatOverview, type ConversationSummary } from "./shared";

export type Subscribe = (fn: (e: ChatEvent) => void) => () => void;

type DialogState =
  | { kind: "newChat" }
  | { kind: "newTeam" }
  | { kind: "teamMembers"; teamId: string }
  | { kind: "newChannel"; teamId: string }
  | null;

const urlFor = (id: string | null) => (id ? `/chat?c=${id}` : "/chat");

export function ChatApp({ initial, initialId }: { initial: ChatOverview; initialId: string | null }) {
  const t = useTranslations("chat");
  const [data, setData] = useState(initial);
  const [activeId, setActiveId] = useState<string | null>(initialId);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [connected, setConnected] = useState(true);
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
        if (m.threadRoot !== null) return;
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
                : { preview: m.body || (m.meta?.files ?? []).map((f) => f.name).join(", ") || m.meta?.meeting?.title || "", author: m.author?.name ?? null, kind: m.kind, created: m.created },
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

  useEffect(() => {
    const onPop = () => setActiveId(new URLSearchParams(window.location.search).get("c"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const dialogTeam = dialog && "teamId" in dialog ? (data.teams.find((tm) => tm.id === dialog.teamId) ?? null) : null;

  const created = (id: string) => {
    setDialog(null);
    refresh();
    open(id);
  };

  return (
    <main className="sheet flex min-w-0 flex-1 overflow-hidden">
      <div className={`${activeId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-line md:w-[300px] md:border-r`}>
        <Sidebar
          data={data}
          activeId={activeId}
          connected={connected}
          onOpen={open}
          onNewChat={() => setDialog({ kind: "newChat" })}
          onNewTeam={() => setDialog({ kind: "newTeam" })}
          onTeamMembers={(teamId) => setDialog({ kind: "teamMembers", teamId })}
          onNewChannel={(teamId) => setDialog({ kind: "newChannel", teamId })}
        />
      </div>
      <section className={`${activeId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {activeId ? (
          <Conversation
            key={activeId}
            id={activeId}
            me={me}
            summary={active}
            subscribe={subscribe}
            onBack={() => open(null)}
            onChanged={refresh}
            onOpen={open}
            onRead={() => patch(activeId, (c) => ({ ...c, unread: 0 }))}
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
