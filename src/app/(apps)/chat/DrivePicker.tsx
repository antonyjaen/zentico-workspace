"use client";

// Sharing Drive files in Chat: the "Choose from Drive" picker (Composer), the "Send in Chat"
// dialog (Drive) and the access step both use before posting.
import { ChevronRight, CircleAlert, Clock, HardDrive, Loader2, Search, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileIcon } from "@/app/(apps)/drive/FileIcon";
import { formatDate } from "@/app/(apps)/drive/shared";
import { getOverview } from "./actions";
import { browseDrive, checkDriveAccess, sendDriveFiles } from "./drive-actions";
import {
  BODY_MAX,
  MAX_DRIVE_PICKS,
  type ChatMessage,
  type ConversationSummary,
  type DriveAccessCheck,
  type DriveGrant,
  type DrivePick,
  type DrivePickItem,
} from "./shared";
import { BTN, BTN_PRIMARY, ConversationIcon, FIELD, Label, Modal, fold, useErrorText } from "./ui";

/* ------------------------------------------------------------- sending */

type Sent = { messages: ChatMessage[]; grantFailed: number };

/** Check → (access step when someone can't open the files) → grant + post. */
function useDriveSend() {
  const errorText = useErrorText();
  const [phase, setPhase] = useState<"idle" | "checking" | "access" | "sending">("idle");
  const [check, setCheck] = useState<DriveAccessCheck | null>(null);
  const [grant, setGrant] = useState<DriveGrant>("viewer");
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (conversationId: string, picks: DrivePick[], text: string, threadRoot: number | null, g: DriveGrant): Promise<Sent | null> => {
      setPhase("sending");
      setError(null);
      const r = await sendDriveFiles(conversationId, picks, g, text, threadRoot).catch(() => ({ ok: false as const, error: "failed" }));
      if (!r.ok) {
        setError(errorText(r.error));
        setPhase(check ? "access" : "idle");
        return null;
      }
      setPhase("idle");
      return r.data;
    },
    [check, errorText],
  );

  /** Runs the access check; posts right away when everyone can open the files. */
  const start = useCallback(
    async (conversationId: string, picks: DrivePick[], text: string, threadRoot: number | null): Promise<Sent | null> => {
      setPhase("checking");
      setError(null);
      const r = await checkDriveAccess(conversationId, picks).catch(() => ({ ok: false as const, error: "failed" }));
      if (!r.ok) {
        setError(errorText(r.error));
        setPhase("idle");
        return null;
      }
      const needs = r.data.supported && r.data.files.some((f) => f.missing.length || f.unknown.length);
      if (!needs) return send(conversationId, picks, text, threadRoot, "none");
      setCheck(r.data);
      setGrant(r.data.files.some((f) => f.canShare && f.missing.length) ? "viewer" : "none");
      setPhase("access");
      return null;
    },
    [errorText, send],
  );

  const reset = () => {
    setCheck(null);
    setPhase("idle");
    setError(null);
  };

  return { phase, check, grant, setGrant, error, start, send, reset };
}

/** "N people in this chat don't have access" with the grant choice. */
function AccessStep({ check, grant, onGrant }: { check: DriveAccessCheck; grant: DriveGrant; onGrant: (g: DriveGrant) => void }) {
  const t = useTranslations("chat");
  const people = new Map<number, string>();
  for (const f of check.files) for (const u of [...f.missing, ...f.unknown]) people.set(u.id, u.name);
  const names = [...people.values()];
  const blocked = check.files.filter((f) => !f.canShare && f.missing.length);
  const shareable = check.files.some((f) => f.canShare && f.missing.length);
  const unknown = new Map<number, string>();
  for (const f of check.files) for (const u of f.unknown) unknown.set(u.id, u.name);
  const options: { value: DriveGrant; label: string; disabled: boolean }[] = [
    { value: "viewer", label: t("drive.grantView"), disabled: !shareable },
    { value: "editor", label: t("drive.grantEdit"), disabled: !shareable },
    { value: "none", label: t("drive.grantNone"), disabled: false },
  ];
  return (
    <div className="space-y-3">
      <div className="flex gap-3 rounded-lg border border-line bg-sheet-muted p-3">
        <Users size={18} className="mt-0.5 shrink-0 text-ink-mute" aria-hidden />
        <div className="min-w-0 text-[13px]">
          <p className="font-medium text-ink">{t("drive.accessTitle", { count: names.length })}</p>
          <p className="mt-0.5 text-ink-mute">
            {names.slice(0, 6).join(", ")}
            {names.length > 6 && ` ${t("drive.andMore", { count: names.length - 6 })}`}
          </p>
          {check.files.length > 1 && (
            <ul className="mt-2 space-y-0.5 text-[12.5px] text-ink-soft">
              {check.files
                .filter((f) => f.missing.length || f.unknown.length)
                .map((f) => (
                  <li key={`${f.accountId}:${f.fileId}`} className="flex items-center gap-1.5">
                    <FileIcon item={{ name: f.name, isFolder: f.isFolder, type: "" }} size={13} />
                    <span className="min-w-0 truncate">{f.name}</span>
                    <span className="shrink-0 text-ink-mute">· {t("drive.peopleCount", { count: f.missing.length + f.unknown.length })}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>

      {blocked.length > 0 && (
        <p className="flex gap-2 text-[12.5px] text-ink-soft">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-amber" aria-hidden />
          {t("drive.cantShare", { names: blocked.map((f) => f.name).join(", "), count: blocked.length })}
        </p>
      )}
      {unknown.size > 0 && (
        <p className="flex gap-2 text-[12.5px] text-ink-soft">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-ink-mute" aria-hidden />
          {t("drive.notInDirectory", { names: [...unknown.values()].join(", ") })}
        </p>
      )}

      <fieldset className="space-y-1">
        <legend className="sr-only">{t("drive.accessChoice")}</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-ink hover:bg-hover ${o.disabled ? "pointer-events-none opacity-50" : ""}`}
          >
            <input type="radio" name="drive-grant" value={o.value} checked={grant === o.value} disabled={o.disabled} onChange={() => onGrant(o.value)} className="accent-[var(--color-primary)]" />
            {o.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/* -------------------------------------------------------------- picker */

type Tab = "recent" | "my" | "shared";
type Place = { tab: Tab; accountId: string | null; folderId: string | null; accountName?: string | null };
const pickKey = (i: { accountId: string | null; id: string }) => `${i.accountId ?? ""}:${i.id}`;

/** "Choose from Drive": browse, search and multi-select, then the access step and send. */
export function DrivePickerDialog({
  conversationId,
  threadRoot,
  text,
  onClose,
  onSent,
}: {
  conversationId: string;
  threadRoot: number | null;
  /** Composer text, sent with the first card. */
  text: string;
  onClose: () => void;
  onSent: (messages: ChatMessage[]) => void;
}) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const errorText = useErrorText();
  const [place, setPlace] = useState<Place>({ tab: "recent", accountId: null, folderId: null });
  const [data, setData] = useState<{ items: DrivePickItem[]; path: { id: string; name: string }[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Map<string, DrivePickItem>>(new Map());
  const flow = useDriveSend();

  useEffect(() => {
    let live = true;
    setData(null);
    setLoadError(null);
    browseDrive(place.tab, place.accountId, place.folderId)
      .then((r) => {
        if (!live) return;
        if (r.ok) setData(r.data);
        else setLoadError(errorText(r.error));
      })
      .catch(() => live && setLoadError(errorText("failed")));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- errorText is stable in practice
  }, [place]);

  const items = useMemo(() => {
    const q = fold(query.trim());
    return (data?.items ?? []).filter((i) => !q || fold(i.name).includes(q) || fold(i.location ?? "").includes(q));
  }, [data, query]);

  const toggle = (i: DrivePickItem) =>
    setPicked((prev) => {
      const next = new Map(prev);
      const k = pickKey(i);
      if (next.has(k)) next.delete(k);
      else if (next.size < MAX_DRIVE_PICKS) next.set(k, i);
      return next;
    });

  const go = (p: Place) => {
    setQuery("");
    setPlace(p);
  };

  const picks: DrivePick[] = [...picked.values()].map((i) => ({ accountId: i.accountId, fileId: i.id }));
  const busy = flow.phase === "checking" || flow.phase === "sending";
  const submit = async () => {
    const r =
      flow.phase === "access"
        ? await flow.send(conversationId, picks, text, threadRoot, flow.grant)
        : await flow.start(conversationId, picks, text, threadRoot);
    if (r) {
      onSent(r.messages);
      onClose();
    }
  };

  const tabs: { id: Tab; label: string; icon: typeof Clock }[] = [
    { id: "recent", label: t("drive.tabRecent"), icon: Clock },
    { id: "my", label: t("drive.tabMy"), icon: HardDrive },
    { id: "shared", label: t("drive.tabShared"), icon: Users },
  ];

  return (
    <Modal
      title={t("drive.pickTitle")}
      onClose={onClose}
      wide
      footer={
        <>
          {flow.error && <p className="mr-auto text-[12.5px] text-danger">{flow.error}</p>}
          {!flow.error && picked.size > 0 && flow.phase !== "access" && (
            <p className="mr-auto text-[12.5px] text-ink-mute">{t("drive.selectedCount", { count: picked.size })}</p>
          )}
          <button type="button" onClick={flow.phase === "access" ? flow.reset : onClose} className={BTN}>
            {flow.phase === "access" ? t("back") : t("cancel")}
          </button>
          <button type="button" onClick={submit} disabled={busy || picked.size === 0} className={BTN_PRIMARY}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {flow.phase === "access" ? t("drive.shareAndSend") : t("send")}
          </button>
        </>
      }
    >
      {flow.phase === "access" && flow.check ? (
        <AccessStep check={flow.check} grant={flow.grant} onGrant={flow.setGrant} />
      ) : (
        <div className="space-y-3">
          <div role="tablist" className="flex gap-1 rounded-lg border border-line p-0.5">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={place.tab === id}
                onClick={() => go({ tab: id, accountId: null, folderId: null })}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] text-ink-soft transition-colors hover:text-ink aria-selected:bg-hover aria-selected:font-medium aria-selected:text-ink"
              >
                <Icon size={14} aria-hidden />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>

          <div className="relative">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-mute" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("drive.search")}
              aria-label={t("drive.search")}
              maxLength={200}
              className={`${FIELD} pl-8`}
            />
          </div>

          {place.tab !== "recent" && (place.folderId || place.accountId) && (
            <nav aria-label={t("drive.location")} className="flex flex-wrap items-center gap-0.5 text-[12.5px]">
              <button type="button" onClick={() => go({ tab: place.tab, accountId: null, folderId: null })} className="rounded px-1.5 py-0.5 text-ink-soft hover:bg-hover hover:text-ink">
                {place.tab === "my" ? t("drive.tabMy") : t("drive.tabShared")}
              </button>
              {place.tab === "shared" && place.accountId && place.accountName && (
                <>
                  <ChevronRight size={13} className="text-ink-mute" aria-hidden />
                  <button type="button" onClick={() => go({ ...place, folderId: null })} className="rounded px-1.5 py-0.5 text-ink-soft hover:bg-hover hover:text-ink">
                    {place.accountName}
                  </button>
                </>
              )}
              {(data?.path ?? []).map((p, i, all) => (
                <span key={p.id} className="flex items-center gap-0.5">
                  <ChevronRight size={13} className="text-ink-mute" aria-hidden />
                  {i === all.length - 1 ? (
                    <span className="px-1.5 py-0.5 font-medium text-ink">{p.name}</span>
                  ) : (
                    <button type="button" onClick={() => go({ ...place, folderId: p.id })} className="rounded px-1.5 py-0.5 text-ink-soft hover:bg-hover hover:text-ink">
                      {p.name}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}

          <div className="min-h-64">
            {loadError ? (
              <p className="py-10 text-center text-[13px] text-danger">{loadError}</p>
            ) : !data ? (
              <p className="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-mute">
                <Loader2 size={15} className="animate-spin" aria-hidden />
                {t("loading")}
              </p>
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-ink-mute">{query ? t("drive.noMatches") : t("drive.empty")}</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {items.map((i) => {
                  const checked = picked.has(pickKey(i));
                  const full = !checked && picked.size >= MAX_DRIVE_PICKS;
                  return (
                    <li key={pickKey(i)} className="flex items-center gap-2.5 py-1.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={full}
                        onChange={() => toggle(i)}
                        aria-label={t("drive.select", { name: i.name })}
                        className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          i.isFolder
                            ? go({
                                tab: place.tab === "recent" ? "my" : place.tab,
                                accountId: place.tab === "shared" ? i.accountId : null,
                                accountName: place.tab === "shared" ? (place.accountName ?? i.owner) : null,
                                folderId: i.id,
                              })
                            : toggle(i)
                        }
                        disabled={!i.isFolder && full}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left hover:bg-hover disabled:opacity-50"
                        title={i.isFolder ? t("drive.openFolder", { name: i.name }) : i.name}
                      >
                        <FileIcon item={i} size={18} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] text-ink">{i.name}</span>
                          <span className="block truncate text-[11.5px] text-ink-mute">
                            {[i.location ?? (i.owner ? null : t("drive.tabMy")), formatDate(i.modified, locale)].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {i.isFolder && <ChevronRight size={15} className="shrink-0 text-ink-mute" aria-hidden />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------- Drive → Chat */

/** Drive's "Send in Chat": pick a conversation, add an optional message, then the access step. */
export function SendToChatDialog({
  items,
  onClose,
}: {
  items: { accountId: string | null; id: string; name: string; isFolder: boolean; type: string }[];
  onClose: () => void;
}) {
  const t = useTranslations("chat");
  const errorText = useErrorText();
  const [list, setList] = useState<(ConversationSummary & { team: string | null })[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<{ id: string; name: string; grantFailed: number } | null>(null);
  const flow = useDriveSend();
  const picks = items.slice(0, MAX_DRIVE_PICKS).map((i) => ({ accountId: i.accountId, fileId: i.id }));

  useEffect(() => {
    let live = true;
    getOverview()
      .then((r) => {
        if (!live) return;
        if (!r.ok) return setLoadError(errorText(r.error));
        const channels = r.data.teams.flatMap((tm) => tm.channels.filter((c) => c.joined).map((c) => ({ ...c, team: tm.name })));
        const all = [...r.data.chats.map((c) => ({ ...c, team: null })), ...channels].sort((a, b) => b.lastActivity - a.lastActivity);
        setList(all);
      })
      .catch(() => live && setLoadError(errorText("failed")));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  const shown = useMemo(() => {
    const q = fold(query.trim());
    const l = (list ?? []).filter((c) => !q || fold(c.name).includes(q) || fold(c.team ?? "").includes(q));
    return q ? l : l.slice(0, 30);
  }, [list, query]);

  const chosen = list?.find((c) => c.id === target) ?? null;
  const label = (c: ConversationSummary & { team: string | null }) => (c.kind === "channel" ? `#${c.name}` : c.name);
  const busy = flow.phase === "checking" || flow.phase === "sending";

  const submit = async () => {
    if (!chosen) return;
    const r =
      flow.phase === "access"
        ? await flow.send(chosen.id, picks, message, null, flow.grant)
        : await flow.start(chosen.id, picks, message, null);
    if (r) setSent({ id: chosen.id, name: label(chosen), grantFailed: r.grantFailed });
  };

  const title = items.length === 1 ? t("drive.sendOneTitle", { name: items[0].name }) : t("drive.sendManyTitle", { count: items.length });

  if (sent)
    return (
      <Modal
        title={title}
        onClose={onClose}
        footer={
          <>
            <button type="button" onClick={onClose} className={BTN}>
              {t("close")}
            </button>
            <a href={`/chat?c=${sent.id}`} className={BTN_PRIMARY}>
              {t("drive.openChat")}
            </a>
          </>
        }
      >
        <p className="text-[13.5px] text-ink">{t("drive.sentTo", { name: sent.name })}</p>
        {sent.grantFailed > 0 && <p className="mt-2 text-[12.5px] text-danger">{t("drive.grantFailed", { count: sent.grantFailed })}</p>}
      </Modal>
    );

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          {flow.error && <p className="mr-auto text-[12.5px] text-danger">{flow.error}</p>}
          <button type="button" onClick={flow.phase === "access" ? flow.reset : onClose} className={BTN}>
            {flow.phase === "access" ? t("back") : t("cancel")}
          </button>
          <button type="button" onClick={submit} disabled={busy || !chosen} className={BTN_PRIMARY}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {flow.phase === "access" ? t("drive.shareAndSend") : t("send")}
          </button>
        </>
      }
    >
      {flow.phase === "access" && flow.check ? (
        <AccessStep check={flow.check} grant={flow.grant} onGrant={flow.setGrant} />
      ) : (
        <div className="space-y-3">
          <ul className="flex flex-wrap gap-1.5">
            {items.map((i) => (
              <li key={`${i.accountId ?? ""}:${i.id}`} className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-sheet-muted px-2 py-1 text-[12.5px] text-ink">
                <FileIcon item={i} size={14} />
                <span className="truncate">{i.name}</span>
              </li>
            ))}
          </ul>
          {items.length > MAX_DRIVE_PICKS && <p className="text-[12px] text-ink-mute">{t("drive.tooMany", { count: MAX_DRIVE_PICKS })}</p>}

          <div>
            <Label htmlFor="send-to-chat-search">{t("drive.sendTo")}</Label>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-mute" aria-hidden />
              <input
                id="send-to-chat-search"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("drive.searchChats")}
                maxLength={200}
                className={`${FIELD} pl-8`}
              />
            </div>
            <div className="mt-1.5 max-h-60 overflow-y-auto overscroll-contain">
              {loadError ? (
                <p className="py-6 text-center text-[13px] text-danger">{loadError}</p>
              ) : !list ? (
                <p className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-mute">
                  <Loader2 size={15} className="animate-spin" aria-hidden />
                  {t("loading")}
                </p>
              ) : shown.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-ink-mute">{t("noMatches")}</p>
              ) : (
                <ul role="listbox" aria-label={t("drive.sendTo")} className="space-y-0.5">
                  {shown.map((c) => (
                    <li key={c.id} role="option" aria-selected={c.id === target}>
                      <button
                        type="button"
                        onClick={() => setTarget(c.id)}
                        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${c.id === target ? "bg-primary-soft" : "hover:bg-hover"}`}
                      >
                        <ConversationIcon c={c} size={26} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] text-ink">{label(c)}</span>
                          {c.team && <span className="block truncate text-[11.5px] text-ink-mute">{c.team}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="send-to-chat-message">{t("drive.messageOptional")}</Label>
            <textarea
              id="send-to-chat-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={BODY_MAX}
              rows={2}
              className="w-full resize-none rounded-md border border-line bg-sheet px-2.5 py-1.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute hover:border-line-strong focus:border-ink-mute"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
