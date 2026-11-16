"use client";

import {
  Archive,
  ArrowLeft,
  ChevronsUpDown,
  Forward,
  ImageOff,
  Keyboard,
  MailOpen,
  MoreVertical,
  OctagonAlert,
  Printer,
  Reply,
  ReplyAll,
  ShieldCheck,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import * as mail from "../../../actions";
import { LabelChip, LabelPicker } from "../../../LabelPicker";
import { composeHref, type ComposeMode } from "../../../hrefs";
import { useShortcuts } from "../../../useShortcuts";
import { usePopover } from "@/components/usePopover";
import type { MailboxRole } from "@/lib/mail";
import { labelsOf, type Label } from "@/lib/mail-labels";
import type { ReadMessage } from "@/lib/mail-read";
import { Lightbox, SourceViewer } from "./Attachments";
import { MessageCard, type MessageAction } from "./MessageCard";
import { useAppTheme } from "./MessageFrame";

/** Marks the thread's unread messages as read once, when it is opened. */
export function MarkSeen({ ids, account }: { ids: string[]; account?: string }) {
  const done = useRef(new Set<string>());
  const key = ids.join(",");
  useEffect(() => {
    const pending = ids.filter((id) => !done.current.has(id));
    if (!pending.length) return;
    pending.forEach((id) => done.current.add(id));
    mail.setSeen(pending, true, account).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

/** Threads at least this long fold their middle messages behind "N older messages". */
const FOLD_FROM = 5;

export function ThreadView({
  messages,
  me,
  backHref,
  role,
  actionIds,
  unreadIds,
  currentPath,
  imagesHref,
  subject,
  labels,
  account,
  allLabels = [],
}: {
  messages: ReadMessage[];
  /** Signed-in user's email (lowercase). */
  me: string | null;
  /** Mailbox list to go back to; null when opened from search (uses history). */
  backHref: string | null;
  role: MailboxRole;
  /** Messages the move actions apply to (the ones in the current mailbox). */
  actionIds: string[];
  unreadIds: string[];
  currentPath: string;
  /** Link that reloads the thread with remote images allowed; null when none are blocked. */
  imagesHref: string | null;
  subject: string;
  labels: string[];
  /** Shared account the thread belongs to (undefined: the user's own). */
  account?: string;
  /** The user's label definitions (for chips and the Label menu). */
  allLabels?: Label[];
}) {
  const t = useTranslations("mailRead");
  // Mail actions bound to the thread's account.
  const setSeen = (ids: string[], seen: boolean) => mail.setSeen(ids, seen, account);
  const setFlagged = (ids: string[], flagged: boolean) => mail.setFlagged(ids, flagged, account);
  const moveToRole = (ids: string[], role: Parameters<typeof mail.moveToRole>[1]) => mail.moveToRole(ids, role, account);
  const destroyEmails = (ids: string[]) => mail.destroyEmails(ids, account);
  const router = useRouter();
  const theme = useAppTheme();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const visible = useMemo(() => messages.filter((m) => !removed.has(m.id)), [messages, removed]);
  const latest = visible[visible.length - 1] ?? messages[messages.length - 1];
  const allIds = visible.map((m) => m.id);

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([latest.id, ...unreadIds, ...messages.filter((m) => m.keywords.$draft).map((m) => m.id)]),
  );
  const [showOlder, setShowOlder] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(messages.map((m) => [m.id, !!m.keywords.$flagged])),
  );
  const [lightbox, setLightbox] = useState<{ messageId: string; index: number } | null>(null);
  const [source, setSource] = useState<ReadMessage | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const helpRef = useRef<HTMLDialogElement>(null);

  // Server refreshes (new replies, flag changes elsewhere) win over local optimistic state.
  useEffect(() => {
    setFlags(Object.fromEntries(messages.map((m) => [m.id, !!m.keywords.$flagged])));
    const newest = messages[messages.length - 1];
    if (newest) setExpanded((s) => (s.has(newest.id) ? s : new Set(s).add(newest.id)));
  }, [messages]);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(false), 6000);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const goBack = useCallback(() => {
    if (backHref) router.push(backHref);
    else if (window.history.length > 1) router.back();
    else router.push("/mail");
  }, [backHref, router]);

  const run = (fn: () => Promise<void>, after?: () => void) =>
    startTransition(async () => {
      setError(false);
      try {
        await fn();
        after?.();
      } catch {
        setError(true);
      }
    });

  const inTrash = role === "trash";
  const inJunk = role === "junk";
  const threadStarred = visible.some((m) => flags[m.id]);

  const archive = () => role !== "archive" && !inTrash && run(() => moveToRole(actionIds, "archive"), goBack);
  const deleteThread = () => {
    if (inTrash && !window.confirm(t("deleteForeverConfirm"))) return;
    run(() => (inTrash ? destroyEmails(actionIds) : moveToRole(actionIds, "trash")), goBack);
  };

  const setStar = (ids: string[], value: boolean) => {
    const prev = flags;
    setFlags((f) => ({ ...f, ...Object.fromEntries(ids.map((id) => [id, value])) }));
    startTransition(async () => {
      try {
        await setFlagged(ids, value);
      } catch {
        setFlags(prev);
        setError(true);
      }
    });
  };
  // Starring the thread flags the latest message; unstarring clears every flag.
  const toggleThreadStar = () => (threadStarred ? setStar(allIds, false) : setStar([latest.id], true));

  // Labels apply to every message of the thread (optimistic; server refresh reconciles).
  const [tagIds, setTagIds] = useState<string[]>(() => [...new Set(messages.flatMap((m) => labelsOf(m.keywords)))]);
  useEffect(() => setTagIds([...new Set(messages.flatMap((m) => labelsOf(m.keywords)))]), [messages]);
  const tags = tagIds.map((id) => allLabels.find((l) => l.id === id)).filter((l): l is Label => !!l);
  const toggleLabel = (id: string, on: boolean) => {
    const prev = tagIds;
    setTagIds((ts) => (on ? [...new Set([...ts, id])] : ts.filter((x) => x !== id)));
    startTransition(async () => {
      try {
        await mail.setLabel(allIds, id, on, account);
        router.refresh();
      } catch {
        setTagIds(prev);
        setError(true);
      }
    });
  };

  const onMessageAction = (m: ReadMessage, action: MessageAction) => {
    switch (action) {
      case "star":
        setStar([m.id], !flags[m.id]);
        return;
      case "source":
        setSource(m);
        return;
      case "markUnreadFromHere": {
        const from = visible.findIndex((x) => x.id === m.id);
        run(() => setSeen(visible.slice(from).map((x) => x.id), false), goBack);
        return;
      }
      case "delete": {
        if (inTrash && !window.confirm(t("deleteMessageForeverConfirm"))) return;
        const last = visible.length === 1;
        run(
          () => (inTrash ? destroyEmails([m.id]) : moveToRole([m.id], "trash")),
          () => {
            setRemoved((s) => new Set(s).add(m.id));
            if (last) goBack();
            else setToast(t("messageDeleted"));
          },
        );
        return;
      }
    }
  };

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allExpanded = visible.every((m) => expanded.has(m.id));
  const toggleAll = () => {
    setShowOlder(true);
    setExpanded(allExpanded ? new Set([latest.id]) : new Set(allIds));
  };

  // Fold the middle of long threads: keep the first message and the last two (or from the first
  // expanded one) visible.
  let fold: [number, number] | null = null;
  if (!showOlder && visible.length >= FOLD_FROM) {
    let end = visible.length - 2;
    for (let i = 1; i < end; i++) {
      if (expanded.has(visible[i].id)) {
        end = i;
        break;
      }
    }
    if (end - 1 >= 2) fold = [1, end];
  }

  const focusIndex = focusId ? visible.findIndex((m) => m.id === focusId) : -1;
  const focusMessage = (i: number) => {
    const m = visible[Math.max(0, Math.min(visible.length - 1, i))];
    if (!m) return;
    if (fold && visible.indexOf(m) >= fold[0] && visible.indexOf(m) < fold[1]) setShowOlder(true);
    setFocusId(m.id);
    requestAnimationFrame(() => refs.current.get(m.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const target = (focusIndex >= 0 ? visible[focusIndex] : null) ?? latest;
  const compose = (mode: ComposeMode, id = target.id) => router.push(composeHref(currentPath, mode, id), { scroll: false });

  const markUnread = () => run(() => setSeen(allIds, false), goBack);

  const print = () => {
    setShowOlder(true);
    setExpanded(new Set(allIds));
    // Let the expanded frames load and size themselves first.
    setTimeout(() => window.print(), 600);
  };

  useShortcuts((e) => {
    if (lightbox || source || helpRef.current?.open) return false;
    switch (e.key) {
      case "j":
      case "n":
        focusMessage(focusIndex < 0 ? 0 : focusIndex + 1);
        return true;
      case "k":
      case "p":
        focusMessage(focusIndex < 0 ? visible.length - 1 : focusIndex - 1);
        return true;
      case "o":
      case "Enter":
        if (e.key === "Enter" && (e.target as HTMLElement).closest?.("a,button,summary")) return false;
        if (focusIndex < 0) return false;
        toggle(visible[focusIndex].id);
        return true;
      case "r":
        compose(target.keywords.$draft ? "draft" : "reply");
        return true;
      case "a":
        compose("replyAll");
        return true;
      case "f":
        compose("forward");
        return true;
      case "s":
        setStar([target.id], !flags[target.id]);
        return true;
      case "e":
        if (role === "archive" || inTrash) return false;
        archive();
        return true;
      case "#":
        deleteThread();
        return true;
      case "u":
        goBack();
        return true;
      case ";":
        toggleAll();
        return true;
      case "c":
        router.push(composeHref(currentPath, "new"), { scroll: false });
        return true;
      case "?":
        helpRef.current?.showModal();
        return true;
      default:
        return false;
    }
  });

  const lightboxMessage = lightbox ? visible.find((m) => m.id === lightbox.messageId) : null;
  const previewable = lightboxMessage?.attachments.filter((a) => a.inlineHref) ?? [];

  return (
    <>
      <MarkSeen ids={unreadIds} account={account} />
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line px-2 sm:px-3 print:hidden">
        {backHref ? (
          <Link href={backHref} className={TOOL} aria-label={t("back")} title={`${t("back")} (u)`}>
            <ArrowLeft size={18} aria-hidden />
          </Link>
        ) : (
          <ToolButton icon={ArrowLeft} label={t("back")} hint="u" onClick={goBack} />
        )}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        {role !== "archive" && !inTrash && <ToolButton icon={Archive} label={t("archive")} hint="e" disabled={pending} onClick={archive} />}
        {inJunk ? (
          <ToolButton icon={ShieldCheck} label={t("notSpam")} disabled={pending} onClick={() => run(() => moveToRole(actionIds, "inbox"), goBack)} />
        ) : (
          <ToolButton icon={OctagonAlert} label={t("spam")} disabled={pending} onClick={() => run(() => moveToRole(actionIds, "junk"), goBack)} />
        )}
        <ToolButton icon={Trash2} label={inTrash ? t("deleteForever") : t("delete")} hint="#" disabled={pending} onClick={deleteThread} />
        <ToolButton icon={MailOpen} label={t("markUnread")} disabled={pending} className={`${TOOL} max-sm:hidden`} onClick={markUnread} />
        <button
          type="button"
          onClick={toggleThreadStar}
          disabled={pending}
          aria-pressed={threadStarred}
          aria-label={threadStarred ? t("unstar") : t("star")}
          title={threadStarred ? t("unstar") : t("star")}
          className={TOOL}
        >
          <Star size={17} aria-hidden className={threadStarred ? "fill-amber text-amber" : ""} />
        </button>
        {!account && (
          <LabelPicker
            labels={allLabels}
            stateOf={(id) => (tagIds.includes(id) ? "all" : "none")}
            onToggle={toggleLabel}
            buttonClassName={TOOL}
            // Phones: the menu would overflow from the toolbar; show it as a sheet near the bottom.
            menuClassName="absolute top-11 left-0 z-50 w-64 max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:w-auto"
          />
        )}

        {error && (
          <span role="alert" className="ml-2 hidden truncate text-[12.5px] text-danger sm:inline">
            {t("actionFailed")}
          </span>
        )}

        {/* Phones: reply/forward, mark unread and print move into an overflow menu. */}
        <ThreadMoreMenu
          items={[
            { icon: Reply, label: latest.keywords.$draft ? t("editDraft") : t("reply"), href: composeHref(currentPath, latest.keywords.$draft ? "draft" : "reply", latest.id) },
            { icon: ReplyAll, label: t("replyAll"), href: composeHref(currentPath, "replyAll", latest.id) },
            { icon: Forward, label: t("forward"), href: composeHref(currentPath, "forward", latest.id) },
            { icon: MailOpen, label: t("markUnread"), onClick: markUnread, disabled: pending },
            { icon: Printer, label: t("print"), onClick: print },
          ]}
        />

        <div className="ml-auto hidden items-center gap-0.5 sm:flex">
          <ToolButton icon={Printer} label={t("print")} onClick={print} />
          <ToolButton icon={Keyboard} label={t("shortcuts.title")} hint="?" onClick={() => helpRef.current?.showModal()} />
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <ComposeLink icon={Reply} label={t("reply")} hint="r" href={composeHref(currentPath, "reply", latest.id)} />
          <ComposeLink icon={ReplyAll} label={t("replyAll")} hint="a" href={composeHref(currentPath, "replyAll", latest.id)} />
          <ComposeLink icon={Forward} label={t("forward")} hint="f" href={composeHref(currentPath, "forward", latest.id)} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto print:overflow-visible" id="zw-thread">
        <div className="mx-auto w-full max-w-[960px] px-3 pb-12 pt-6 sm:px-6">
          <header className="rise flex items-start gap-3 px-1">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-[22px] font-semibold leading-[1.2] tracking-[-0.02em] text-ink sm:text-[26px]">{subject}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {labels.map((l) => (
                  <span key={l} className="inline-flex h-[22px] items-center rounded-md border border-line bg-sheet-muted px-2 text-[11.5px] font-medium text-ink-soft">
                    {l}
                  </span>
                ))}
                {tags.map((l) => (
                  <LabelChip key={l.id} label={l} />
                ))}
                <span className="font-mono text-[11.5px] text-ink-mute">{t("messages", { count: visible.length })}</span>
              </div>
            </div>
            {visible.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                className="icon-btn h-10 w-10 shrink-0 sm:h-8 sm:w-8 print:hidden"
                aria-label={allExpanded ? t("collapseAll") : t("expandAll")}
                title={`${allExpanded ? t("collapseAll") : t("expandAll")} (;)`}
              >
                <ChevronsUpDown size={16} aria-hidden />
              </button>
            )}
          </header>

          {imagesHref && (
            <div className="rise mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-sheet-muted px-3.5 py-2.5 text-[13px] text-ink-soft print:hidden">
              <ImageOff size={15} aria-hidden className="shrink-0 text-ink-mute" />
              <span className="min-w-0 flex-1">{t("imagesBlocked")}</span>
              <Link
                href={imagesHref}
                className="inline-flex h-7 items-center rounded-md border border-line-strong bg-sheet px-2.5 font-medium text-ink transition-colors hover:bg-hover"
              >
                {t("showImages")}
              </Link>
            </div>
          )}

          <ol className="rise mt-5 divide-y divide-line rounded-xl border border-line bg-sheet print:border-0 [&>li:first-child>button]:rounded-t-xl [&>li:last-child>button]:rounded-b-xl">
            {visible.map((m, i) => {
              if (fold && i >= fold[0] && i < fold[1]) {
                if (i !== fold[0]) return null;
                return (
                  <li key="older" className="relative print:hidden">
                    <button
                      type="button"
                      onClick={() => setShowOlder(true)}
                      className="group flex h-9 w-full items-center gap-3 px-3 transition-colors hover:bg-hover sm:px-4"
                    >
                      <span className="flex w-8 flex-col items-center gap-[3px]" aria-hidden>
                        <span className="h-px w-6 bg-line-strong" />
                        <span className="h-px w-6 bg-line-strong" />
                        <span className="h-px w-6 bg-line-strong" />
                      </span>
                      <span className="inline-flex h-6 items-center rounded-full border border-line-strong bg-sheet px-2.5 text-[12px] font-medium text-ink-soft group-hover:text-ink">
                        {t("olderMessages", { count: fold[1] - fold[0] })}
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <MessageCard
                  key={m.id}
                  ref={(el) => {
                    if (el) refs.current.set(m.id, el);
                    else refs.current.delete(m.id);
                  }}
                  m={m}
                  me={me}
                  expanded={expanded.has(m.id)}
                  focused={focusId === m.id}
                  theme={theme}
                  currentPath={currentPath}
                  inTrash={inTrash}
                  starred={!!flags[m.id]}
                  onToggle={() => {
                    setFocusId(m.id);
                    toggle(m.id);
                  }}
                  onAction={(a) => onMessageAction(m, a)}
                  onPreview={(index) => {
                    const a = m.attachments[index];
                    const at = m.attachments.filter((x) => x.inlineHref).indexOf(a);
                    if (at >= 0) setLightbox({ messageId: m.id, index: at });
                  }}
                  onToast={setToast}
                />
              );
            })}
          </ol>

          <div className="mt-5 flex flex-wrap gap-2 px-1 print:hidden">
            <ReplyButton icon={Reply} href={composeHref(currentPath, latest.keywords.$draft ? "draft" : "reply", latest.id)} label={latest.keywords.$draft ? t("editDraft") : t("reply")} />
            <ReplyButton icon={ReplyAll} href={composeHref(currentPath, "replyAll", latest.id)} label={t("replyAll")} />
            <ReplyButton icon={Forward} href={composeHref(currentPath, "forward", latest.id)} label={t("forward")} />
          </div>
        </div>
      </div>

      {lightbox && previewable.length > 0 && (
        <Lightbox
          items={previewable}
          index={Math.min(lightbox.index, previewable.length - 1)}
          onIndex={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
          onClose={() => setLightbox(null)}
        />
      )}
      {source?.sourceHref && (
        <SourceViewer href={source.sourceHref} emlHref={source.emlHref} title={source.subject || t("noSubject")} onClose={() => setSource(null)} />
      )}

      <ShortcutHelp ref={helpRef} />

      {error && (
        <div role="alert" className="pop fixed inset-x-3 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 px-4 py-3 text-[14px] text-danger sm:hidden print:hidden">
          {t("actionFailed")}
        </div>
      )}
      {toast && (
        <div role="status" className="pop fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 px-4 py-2.5 text-[13px] text-ink print:hidden">
          {toast}
        </div>
      )}

      {/* Print only the conversation, not the app chrome. */}
      <style>{`@media print{
        :root,[data-theme=dark]{--color-ink:#0a0a0a;--color-ink-soft:#404040;--color-ink-mute:#737373;--color-line:#e5e5e5;--color-line-strong:#d4d4d4;--color-sheet:#fff;--color-sheet-muted:#f5f5f5;color-scheme:light}
        html,body{height:auto!important;overflow:visible!important;background:#fff!important}
        body *{visibility:hidden}
        #zw-thread,#zw-thread *{visibility:visible}
        #zw-thread{position:absolute;inset:0 auto auto 0;width:100%;overflow:visible!important}
        #zw-thread iframe{break-inside:auto}
      }`}</style>
    </>
  );
}

function ShortcutHelp({ ref }: { ref: React.Ref<HTMLDialogElement> }) {
  const t = useTranslations("mailRead");
  const rows: [string, string][] = [
    ["j / k", t("shortcuts.nextPrev")],
    ["o / ↵", t("shortcuts.toggle")],
    [";", t("shortcuts.toggleAll")],
    ["r", t("reply")],
    ["a", t("replyAll")],
    ["f", t("forward")],
    ["s", t("star")],
    ["e", t("archive")],
    ["#", t("delete")],
    ["u", t("back")],
    ["c", t("shortcuts.compose")],
  ];
  return (
    <dialog
      ref={ref}
      className="pop m-auto w-[min(380px,calc(100vw-2rem))] p-0 text-ink backdrop:bg-black/40"
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
    >
      <div className="p-5">
        <h2 className="mb-3 text-[15px] font-semibold">{t("shortcuts.title")}</h2>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
          {rows.map(([keys, label]) => (
            <div key={keys} className="contents">
              <dt className="flex gap-1">
                {keys.split(" / ").map((k) => (
                  <span key={k} className="kbd">
                    {k}
                  </span>
                ))}
              </dt>
              <dd className="text-ink-soft">{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </dialog>
  );
}

function ReplyButton({ href, label, icon: Icon }: { href: string; label: string; icon: LucideIcon }) {
  return (
    <Link
      href={href}
      scroll={false}
      className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong px-3.5 sm:h-9 text-[13.5px] font-medium text-ink transition-colors hover:bg-hover"
    >
      <Icon size={15} aria-hidden className="text-ink-soft" />
      {label}
    </Link>
  );
}

/** Toolbar button: 40px touch target on phones, 36px from sm up. */
const TOOL = "icon-btn h-10 w-10 sm:h-9 sm:w-9";

function ToolButton({
  icon: Icon,
  label,
  hint,
  onClick,
  disabled,
  className = TOOL,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      className={className}
    >
      <Icon size={17} aria-hidden />
    </button>
  );
}

function ComposeLink({ icon: Icon, label, hint, href }: { icon: LucideIcon; label: string; hint: string; href: string }) {
  return (
    <Link href={href} scroll={false} aria-label={label} title={`${label} (${hint})`} className="icon-btn h-9 w-9">
      <Icon size={17} aria-hidden />
    </Link>
  );
}

type MoreItem = { icon: LucideIcon; label: string; href?: string; onClick?: () => void; disabled?: boolean };

/** Phone-only overflow menu for the thread actions that don't fit the toolbar. */
function ThreadMoreMenu({ items }: { items: MoreItem[] }) {
  const t = useTranslations("mailActions.mobile");
  const { open, toggle, setOpen, ref } = usePopover();
  const item = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink disabled:opacity-40";
  return (
    <div ref={ref} className="relative ml-auto sm:hidden">
      <button
        type="button"
        className={TOOL}
        aria-label={t("moreActions")}
        title={t("moreActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreVertical size={18} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={t("moreActions")} className="pop absolute top-11 right-0 z-50 w-56 p-1.5">
          {items.map(({ icon: Icon, label, href, onClick, disabled }) =>
            href ? (
              <Link key={label} href={href} scroll={false} role="menuitem" className={item} onClick={() => setOpen(false)}>
                <Icon size={16} aria-hidden />
                {label}
              </Link>
            ) : (
              <button
                key={label}
                type="button"
                role="menuitem"
                disabled={disabled}
                className={item}
                onClick={() => {
                  setOpen(false);
                  onClick?.();
                }}
              >
                <Icon size={16} aria-hidden />
                {label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
