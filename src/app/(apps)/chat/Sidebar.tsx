"use client";

import { ChevronDown, ChevronRight, Contact, ListChecks, MessageSquare, MoreHorizontal, Plus, Search, SquarePen, UserPlus, Users, WifiOff, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { usePopover } from "@/components/usePopover";
import type { ChatOverview, ConversationSummary, TeamSummary } from "./shared";
import { ConversationIcon, fold, shortTime } from "./ui";

type Props = {
  data: ChatOverview;
  activeId: string | null;
  connected: boolean;
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onNewTeam: () => void;
  onTeamMembers: (teamId: string) => void;
  onNewChannel: (teamId: string) => void;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  /** People tab content for the current search. */
  renderPeople: (query: string) => React.ReactNode;
  /** People tab header actions. */
  peopleActions: React.ReactNode;
  /** My tasks tab content for the current search. */
  renderTasks: (query: string) => React.ReactNode;
};

export type SidebarTab = "chats" | "people" | "tasks";

const COLLAPSED_KEY = "zw_chat_collapsed";

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar({
  data,
  activeId,
  connected,
  onOpen,
  onNewChat,
  onNewTeam,
  onTeamMembers,
  onNewChannel,
  tab,
  onTab,
  renderPeople,
  peopleActions,
  renderTasks,
}: Props) {
  const t = useTranslations("chat");
  const tt = useTranslations("tasks");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => setCollapsed(readCollapsed()), []);
  const q = fold(query.trim());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });

  const match = (c: ConversationSummary) => !q || fold(c.name).includes(q) || (c.peer && fold(c.peer.email).includes(q));
  const teams = data.teams
    .map((tm) => ({ ...tm, channels: !q || fold(tm.name).includes(q) ? tm.channels : tm.channels.filter(match) }))
    .filter((tm) => tm.channels.length > 0 || !q);
  const chats = data.chats.filter(match);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <h1 className="flex-1 text-[15px] font-semibold tracking-tight text-ink">{t("title")}</h1>
        {!connected && (
          <span title={t("offline")} className="text-amber">
            <WifiOff size={15} aria-label={t("offline")} />
          </span>
        )}
        {tab === "people" ? (
          peopleActions
        ) : tab === "tasks" ? null : (
          <>
            <button type="button" onClick={onNewTeam} className="icon-btn h-8 w-8" aria-label={t("newTeam")} title={t("newTeam")}>
              <Users size={17} aria-hidden />
            </button>
            <button type="button" onClick={onNewChat} className="icon-btn h-8 w-8" aria-label={t("newChat")} title={t("newChat")}>
              <SquarePen size={17} aria-hidden />
            </button>
          </>
        )}
      </div>

      <div role="tablist" aria-label={t("title")} className="mx-3 mt-3 grid shrink-0 grid-cols-3 gap-1 rounded-md bg-sheet-muted p-0.5">
        {(["chats", "people", "tasks"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className="flex h-7 items-center justify-center gap-1.5 rounded text-[12.5px] font-medium text-ink-mute transition-colors hover:text-ink aria-selected:bg-sheet aria-selected:text-ink aria-selected:shadow-sm"
          >
            {id === "chats" ? <MessageSquare size={13} aria-hidden /> : id === "people" ? <Contact size={13} aria-hidden /> : <ListChecks size={13} aria-hidden />}
            {id === "chats" ? t("tabChats") : id === "people" ? t("tabPeople") : tt("tabMine")}
          </button>
        ))}
      </div>

      <div className="shrink-0 p-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-sheet-muted px-2.5 transition-colors focus-within:border-line-strong">
          <Search size={14} className="shrink-0 text-ink-mute" aria-hidden />
          <span className="sr-only">{t("search")}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "people" ? t("people.search") : tab === "tasks" ? tt("searchMine") : t("search")}
            maxLength={100}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-mute"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="text-ink-mute hover:text-ink" aria-label={t("clearSearch")}>
              <X size={13} aria-hidden />
            </button>
          )}
        </label>
      </div>

      {tab === "people" ? (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t("tabPeople")}>
          {renderPeople(query)}
        </nav>
      ) : tab === "tasks" ? (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={tt("tabMine")}>
          {renderTasks(query)}
        </nav>
      ) : (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t("title")}>
          <SectionTitle label={t("teams")} action={{ label: t("newTeam"), onClick: onNewTeam }} />
          {teams.length === 0 ? (
            <p className="px-2 pb-3 text-[12.5px] leading-relaxed text-ink-mute">{q ? t("noMatches") : t("noTeams")}</p>
          ) : (
            teams.map((team) => (
              <TeamBlock
                key={team.id}
                team={team}
                open={!collapsed.has(team.id) || !!q}
                onToggle={() => toggle(team.id)}
                activeId={activeId}
                onOpen={onOpen}
                onMembers={() => onTeamMembers(team.id)}
                onNewChannel={() => onNewChannel(team.id)}
              />
            ))
          )}

          <SectionTitle label={t("chats")} action={{ label: t("newChat"), onClick: onNewChat }} />
          {chats.length === 0 ? (
            <p className="px-2 pb-3 text-[12.5px] leading-relaxed text-ink-mute">{q ? t("noMatches") : t("noChats")}</p>
          ) : (
            <ul className="space-y-px">
              {chats.map((c) => (
                <li key={c.id}>
                  <ChatRow c={c} active={c.id === activeId} onOpen={() => onOpen(c.id)} />
                </li>
              ))}
            </ul>
          )}
        </nav>
      )}
    </div>
  );
}

function SectionTitle({ label, action }: { label: string; action: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-center justify-between px-2 pt-3 pb-1">
      <span className="font-mono text-[10.5px] tracking-[0.16em] text-ink-mute uppercase">{label}</span>
      <button type="button" onClick={action.onClick} className="icon-btn h-6 w-6" aria-label={action.label} title={action.label}>
        <Plus size={14} aria-hidden />
      </button>
    </div>
  );
}

function UnreadBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[10.5px] font-semibold text-primary-ink tabular-nums">
      {n > 99 ? "99+" : n}
    </span>
  );
}

function TeamBlock({
  team,
  open,
  onToggle,
  activeId,
  onOpen,
  onMembers,
  onNewChannel,
}: {
  team: TeamSummary;
  open: boolean;
  onToggle: () => void;
  activeId: string | null;
  onOpen: (id: string) => void;
  onMembers: () => void;
  onNewChannel: () => void;
}) {
  const t = useTranslations("chat");
  const menu = usePopover();
  const unread = team.channels.reduce((n, c) => n + (c.joined ? c.unread : 0), 0);
  return (
    <div className="mb-1">
      <div className="group relative flex items-center rounded-md hover:bg-hover">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-left">
          {open ? <ChevronDown size={14} className="shrink-0 text-ink-mute" aria-hidden /> : <ChevronRight size={14} className="shrink-0 text-ink-mute" aria-hidden />}
          <span className="truncate text-[13.5px] font-medium text-ink">{team.name}</span>
          {!open && <UnreadBadge n={unread} />}
        </button>
        <div ref={menu.ref} className="relative">
          <button
            type="button"
            onClick={menu.toggle}
            className="icon-btn h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            aria-label={t("teamOptions", { name: team.name })}
            aria-expanded={menu.open}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={15} aria-hidden />
          </button>
          {menu.open && (
            <div role="menu" className="pop absolute top-8 right-0 z-30 w-48 p-1">
              <MenuItem icon={<Plus size={14} />} label={t("newChannel")} onClick={() => (menu.setOpen(false), onNewChannel())} />
              <MenuItem
                icon={<UserPlus size={14} />}
                label={team.role === "owner" ? t("manageMembers") : t("viewMembers")}
                onClick={() => (menu.setOpen(false), onMembers())}
              />
            </div>
          )}
        </div>
      </div>
      {open && (
        <ul className="space-y-px">
          {team.channels.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                aria-current={c.id === activeId ? "page" : undefined}
                className="flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-6 text-left transition-colors hover:bg-hover aria-[current=page]:bg-primary-soft"
              >
                <ConversationIcon c={c} size={20} />
                <span className={`min-w-0 flex-1 truncate text-[13.5px] ${c.unread > 0 && c.joined ? "font-semibold text-ink" : c.joined ? "text-ink-soft" : "text-ink-mute"}`}>
                  {c.name}
                </span>
                {c.joined && <UnreadBadge n={c.unread} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-ink-soft hover:bg-hover hover:text-ink"
    >
      <span className="text-ink-mute" aria-hidden>
        {icon}
      </span>
      {label}
    </button>
  );
}

function ChatRow({ c, active, onOpen }: { c: ConversationSummary; active: boolean; onOpen: () => void }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const last = c.lastMessage;
  const preview = !last
    ? t("noMessagesYet")
    : last.kind === "meeting"
      ? `${t("previewMeeting")}${last.preview ? `: ${last.preview}` : ""}`
      : last.kind === "file"
        ? `📎 ${last.preview}`
        : last.preview;
  const author = last?.author && c.kind !== "dm" && last.kind !== "system" ? `${last.author.split(" ")[0]}: ` : "";
  const bold = c.unread > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-hover aria-[current=page]:bg-primary-soft"
    >
      <ConversationIcon c={c} size={34} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13.5px] ${bold ? "font-semibold text-ink" : "font-medium text-ink"}`}>{c.name}</span>
          {last && <span className="shrink-0 text-[11px] text-ink-mute tabular-nums">{shortTime(last.created, locale)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${bold ? "text-ink-soft" : "text-ink-mute"}`}>
            {author}
            {preview}
          </span>
          <UnreadBadge n={c.unread} />
        </span>
      </span>
    </button>
  );
}
