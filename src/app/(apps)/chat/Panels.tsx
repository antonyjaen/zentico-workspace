"use client";

import { Check, Loader2, LogOut, Pencil, UserPlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { addChannelMembers, addPeople, getTeamMembers, getThread, leaveConversation, renameConversation } from "./actions";
import { addApps, removeApp } from "./app-actions";
import type { Subscribe } from "./ChatApp";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { NAME_MAX, TYPING_TTL_MS, type ChatMessage, type ChatUser, type ConversationDetail, type Person } from "./shared";
import { AppBadge, appsAsPeople, Avatar, BTN, BTN_PRIMARY, FIELD, Label, PeoplePicker, useApps, usePeople, useErrorText, useUserName } from "./ui";

const groupedWith = (prev: ChatMessage | undefined, m: ChatMessage | undefined) =>
  !!prev && !!m && prev.author?.id === m.author?.id && !prev.deleted && m.created - prev.created < 5 * 60_000;

/** Why I can't rename a group or channel (shown instead of the edit button). */
export function renameDeniedText(c: Pick<ConversationDetail, "kind">, t: (key: "renameChannelDenied" | "renameGroupDenied") => string): string {
  return c.kind === "channel" ? t("renameChannelDenied") : t("renameGroupDenied");
}

export function PanelHeader({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  const t = useTranslations("chat");
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[14px] font-semibold text-ink">{title}</h3>
        {sub && <p className="truncate text-[12px] text-ink-mute">{sub}</p>}
      </div>
      <button type="button" onClick={onClose} className="icon-btn h-8 w-8" aria-label={t("close")}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

export function ThreadPanel({
  rootId,
  conversation,
  me,
  subscribe,
  nameOf,
  onClose,
}: {
  rootId: number;
  conversation: ConversationDetail;
  me: ChatUser;
  subscribe: Subscribe;
  nameOf: (id: number) => string;
  onClose: () => void;
}) {
  const t = useTranslations("chat");
  // Same look as the conversation: bubbles in DMs and groups, the classic list in channels.
  const variant = conversation.kind === "channel" ? "list" : conversation.kind;
  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [replies, setReplies] = useState<ChatMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [typing, setTyping] = useState<{ name: string; until: number } | null>(null);

  useEffect(() => {
    let live = true;
    getThread(rootId).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailed(true);
      setRoot(r.data.root);
      setReplies(r.data.replies);
    });
    return () => {
      live = false;
    };
  }, [rootId]);

  const upsert = useCallback((m: ChatMessage) => {
    if (m.id === rootId) return setRoot(m);
    setReplies((list) => {
      if (!list) return list;
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const next = [...list];
        next[i] = m;
        return next;
      }
      return [...list, m].sort((a, b) => a.id - b.id);
    });
  }, [rootId]);

  useEffect(
    () =>
      subscribe((e) => {
        if ((e.type === "message" || e.type === "update") && (e.message.threadRoot === rootId || e.message.id === rootId)) {
          if (e.type === "update" && e.message.threadRoot === rootId) {
            // Only replace existing replies on update.
            setReplies((list) => (list ? list.map((x) => (x.id === e.message.id ? e.message : x)) : list));
          } else upsert(e.message);
          if (e.type === "message") setTyping(null);
        } else if (e.type === "typing" && e.threadRoot === rootId && e.user.id !== me.id) {
          setTyping({ name: e.user.name, until: Date.now() + TYPING_TTL_MS });
        }
      }),
    [subscribe, rootId, upsert, me.id],
  );

  useEffect(() => {
    if (!typing) return;
    const timer = setTimeout(() => setTyping(null), Math.max(0, typing.until - Date.now()));
    return () => clearTimeout(timer);
  }, [typing]);

  return (
    <>
      <PanelHeader title={t("thread")} sub={conversation.kind === "channel" ? `#${conversation.name}` : conversation.name} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto py-2 @container">
        {failed ? (
          <p className="p-6 text-center text-[13px] text-ink-mute">{t("errors.notFound")}</p>
        ) : !root || !replies ? (
          <div className="grid h-32 place-items-center">
            <Loader2 size={18} className="animate-spin text-ink-mute" aria-label={t("loading")} />
          </div>
        ) : (
          <>
            <MessageItem m={root} me={me} grouped={false} variant={variant} nameOf={nameOf} onUpdate={upsert} canInteract={conversation.joined} />
            <div className="flex items-center gap-3 px-5 py-2">
              <span className="text-[12px] text-ink-mute">{t("replies", { count: replies.filter((r) => !r.deleted).length })}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            {replies.map((m, i) => (
              <MessageItem
                key={m.id}
                m={m}
                me={me}
                grouped={groupedWith(replies[i - 1], m)}
                last={!groupedWith(m, replies[i + 1])}
                variant={variant}
                nameOf={nameOf}
                onUpdate={upsert}
                canInteract={conversation.joined}
              />
            ))}
          </>
        )}
      </div>
      <div className="h-5 shrink-0 truncate px-5 text-[12px] text-ink-mute" aria-live="polite">
        {typing && t("typingOne", { name: typing.name })}
      </div>
      {conversation.joined && root && !root.deleted && (
        <Composer
          conversationId={conversation.id}
          threadRoot={rootId}
          me={me}
          members={conversation.members}
          placeholder={t("replyPlaceholder")}
          onSent={upsert}
        />
      )}
    </>
  );
}

export function MembersPanel({
  conversation,
  renameRequest = 0,
  me,
  onClose,
  onChanged,
  onLeft,
}: {
  conversation: ConversationDetail;
  /** Changes (>0) whenever the header asks to open the rename form. */
  renameRequest?: number;
  me: ChatUser;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onLeft: () => void;
}) {
  const t = useTranslations("chat");
  const ta = useTranslations("apps");
  const errorText = useErrorText();
  const userName = useUserName();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (renameRequest > 0) setRenaming(true);
  }, [renameRequest]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(errorText(r.error ?? "failed"));
    return r.ok;
  };

  return (
    <>
      <PanelHeader title={t("members")} sub={t("memberCount", { count: conversation.memberCount })} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {conversation.canRename && renaming ? (
          <RenameForm
            conversation={conversation}
            busy={busy}
            onCancel={() => setRenaming(false)}
            onSave={async (name, description) => {
              if (await run(() => renameConversation(conversation.id, name, description))) {
                setRenaming(false);
                await onChanged();
              }
            }}
          />
        ) : (
          conversation.kind !== "dm" && (
            <div className="mb-3 rounded-lg border border-line p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-ink">{conversation.kind === "channel" ? `#${conversation.name}` : conversation.name}</p>
                  {conversation.description && <p className="mt-1 text-[12.5px] whitespace-pre-wrap text-ink-soft">{conversation.description}</p>}
                  {!conversation.canRename && <p className="mt-1.5 text-[12px] text-ink-mute">{renameDeniedText(conversation, t)}</p>}
                </div>
                {conversation.canRename && (
                  <button type="button" onClick={() => setRenaming(true)} className="icon-btn h-7 w-7" aria-label={t("rename")} title={t("rename")}>
                    <Pencil size={14} aria-hidden />
                  </button>
                )}
              </div>
            </div>
          )
        )}

        {conversation.canManage &&
          (adding ? (
            <AddMembers
              conversation={conversation}
              busy={busy}
              onCancel={() => setAdding(false)}
              onAdd={async (people, ids, appIds) => {
                const humans = people.filter((p) => !p.bot);
                let ok = true;
                if (humans.length)
                  ok = await run(() =>
                    conversation.kind === "channel" ? addChannelMembers(conversation.id, ids) : addPeople(conversation.id, humans),
                  );
                if (ok && appIds.length) ok = await run(() => addApps(conversation.id, appIds));
                if (ok) {
                  setAdding(false);
                  await onChanged();
                }
              }}
            />
          ) : (
            <button type="button" onClick={() => setAdding(true)} className={`${BTN} mb-3 w-full`}>
              <UserPlus size={15} aria-hidden />
              {t("addPeople")}
            </button>
          ))}

        {error && <p className="mb-2 text-[12.5px] text-danger">{error}</p>}

        <ul className="space-y-0.5">
          {conversation.members.map((u) => (
            <li key={u.id} className="group flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <Avatar name={u.name} email={u.email} bot={u.bot} size={30} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] text-ink">
                    {userName(u)}
                    {u.id === me.id && <span className="text-ink-mute"> ({t("you")})</span>}
                  </span>
                  {u.bot && <AppBadge bot={u.bot} />}
                </span>
                <span className="block truncate text-[12px] text-ink-mute">{u.bot ? u.bot.description || `@${u.email.split("@")[0]}` : u.email}</span>
              </span>
              {conversation.kind === "channel" && u.role === "owner" && !u.bot && (
                <span className="shrink-0 rounded border border-line px-1.5 py-px text-[10.5px] text-ink-mute">{t("owner")}</span>
              )}
              {u.bot && conversation.joined && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    if (await run(() => removeApp(conversation.id, u.id))) await onChanged();
                  }}
                  className="icon-btn h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger"
                  aria-label={ta("remove", { name: userName(u) })}
                  title={ta("remove", { name: userName(u) })}
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {conversation.kind !== "dm" && conversation.joined && (
        <div className="shrink-0 border-t border-line p-3">
          {confirmLeave ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[12.5px] text-ink-soft">{t("confirmLeave")}</span>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (await run(() => leaveConversation(conversation.id))) onLeft();
                }}
                className="h-8 rounded-md px-3 text-[13px] font-medium text-danger hover:bg-hover"
              >
                {t("leave")}
              </button>
              <button type="button" onClick={() => setConfirmLeave(false)} className={BTN}>
                {t("cancel")}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmLeave(true)} className={`${BTN} w-full hover:text-danger`}>
              <LogOut size={14} aria-hidden />
              {conversation.kind === "channel" ? t("leaveChannel") : t("leaveGroup")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function RenameForm({
  conversation,
  busy,
  onSave,
  onCancel,
}: {
  conversation: ConversationDetail;
  busy: boolean;
  onSave: (name: string | null, description: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("chat");
  const [name, setName] = useState(conversation.rawName ?? "");
  const [description, setDescription] = useState(conversation.description);
  return (
    <form
      className="mb-3 space-y-3 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name.trim() || null, description.trim());
      }}
    >
      <div>
        <Label htmlFor="rename-name">{t("name")}</Label>
        <input
          id="rename-name"
          autoFocus
          value={name}
          maxLength={NAME_MAX}
          required={conversation.kind === "channel"}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
          placeholder={conversation.kind === "group" ? t("groupNamePlaceholder") : ""}
        />
        {conversation.kind === "group" && <p className="mt-1 text-[12px] text-ink-mute">{t("groupNameEmptyHint")}</p>}
      </div>
      <div>
        <Label htmlFor="rename-desc">{t("description")}</Label>
        <textarea
          id="rename-desc"
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={`${FIELD} h-auto py-1.5`}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          {t("cancel")}
        </button>
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          <Check size={14} aria-hidden />
          {t("save")}
        </button>
      </div>
    </form>
  );
}

function AddMembers({
  conversation,
  busy,
  onAdd,
  onCancel,
}: {
  conversation: ConversationDetail;
  busy: boolean;
  onAdd: (people: Person[], ids: number[], appIds: number[]) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("chat");
  const ta = useTranslations("apps");
  const directory = usePeople();
  const apps = useApps();
  const userName = useUserName();
  const [teamPeople, setTeamPeople] = useState<ChatUser[] | null>(null);
  const [picked, setPicked] = useState<Person[]>([]);
  const isChannel = conversation.kind === "channel";

  useEffect(() => {
    if (!isChannel || !conversation.teamId) return;
    getTeamMembers(conversation.teamId).then((r) => setTeamPeople(r.ok ? r.data : []));
  }, [isChannel, conversation.teamId]);

  const memberEmails = useMemo(() => new Set(conversation.members.map((m) => m.email)), [conversation.members]);
  const candidates = useMemo(() => {
    const source = isChannel ? (teamPeople?.filter((u) => !u.bot).map((u) => ({ email: u.email, name: u.name })) ?? null) : directory;
    // Apps are searchable too (mine, shared ones and my Claude).
    const appPeople = appsAsPeople(apps, userName) ?? [];
    return source ? [...appPeople, ...source].filter((p) => !memberEmails.has(p.email)) : null;
  }, [isChannel, teamPeople, directory, memberEmails, apps, userName]);

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-line p-3">
      <PeoplePicker
        value={picked}
        onChange={setPicked}
        people={candidates}
        autoFocus
        placeholder={isChannel ? ta("searchTeamMembersOrApps") : ta("searchPeopleOrApps")}
      />
      {isChannel && candidates?.length === 0 && <p className="text-[12px] text-ink-mute">{t("everyoneIsHere")}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          {t("cancel")}
        </button>
        <button
          type="button"
          disabled={busy || picked.length === 0}
          onClick={() => {
            const ids = isChannel ? (teamPeople ?? []).filter((u) => picked.some((p) => p.email === u.email && !p.bot)).map((u) => u.id) : [];
            const appIds = (apps ?? []).filter((u) => picked.some((p) => p.bot && p.email === u.email)).map((u) => u.id);
            onAdd(picked, ids, appIds);
          }}
          className={BTN_PRIMARY}
        >
          {t("add")}
        </button>
      </div>
    </div>
  );
}
