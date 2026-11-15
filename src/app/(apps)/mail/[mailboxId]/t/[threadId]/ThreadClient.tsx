"use client";

import {
  Archive,
  ArrowLeft,
  Forward,
  MailOpen,
  OctagonAlert,
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
import { useEffect, useRef, useState, useTransition } from "react";
import { destroyEmails, moveToRole, setFlagged, setSeen } from "../../../actions";
import { composeHref } from "../../../hrefs";
import type { MailboxRole } from "@/lib/mail";

/** Marks the thread's unread messages as read once, when it is opened. */
export function MarkSeen({ ids }: { ids: string[] }) {
  const done = useRef(new Set<string>());
  const key = ids.join(",");
  useEffect(() => {
    const pending = ids.filter((id) => !done.current.has(id));
    if (!pending.length) return;
    pending.forEach((id) => done.current.add(id));
    setSeen(pending, true).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

export function ThreadToolbar({
  backHref,
  role,
  actionIds,
  allIds,
  latestId,
  starred,
  currentPath,
}: {
  /** Mailbox list to go back to; null when opened from search (uses history). */
  backHref: string | null;
  role: MailboxRole;
  /** Messages the move actions apply to (the ones in the current mailbox). */
  actionIds: string[];
  allIds: string[];
  latestId: string;
  starred: boolean;
  currentPath: string;
}) {
  const t = useTranslations("mailRead");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [isStarred, setIsStarred] = useState(starred);
  const [error, setError] = useState(false);

  useEffect(() => setIsStarred(starred), [starred]);

  const goBack = () => {
    if (backHref) router.push(backHref);
    else if (window.history.length > 1) router.back();
    else router.push("/mail");
  };

  const run = (fn: () => Promise<void>, leave = true) =>
    startTransition(async () => {
      setError(false);
      try {
        await fn();
        if (leave) goBack();
      } catch {
        setError(true);
      }
    });

  const toggleStar = () => {
    const next = !isStarred;
    setIsStarred(next);
    startTransition(async () => {
      try {
        // Starring flags the latest message; unstarring clears every flag in the thread.
        await setFlagged(next ? [latestId] : allIds, next);
      } catch {
        setIsStarred(!next);
        setError(true);
      }
    });
  };

  const inTrash = role === "trash";
  const inJunk = role === "junk";

  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line px-2 sm:px-3">
      {backHref ? (
        <Link href={backHref} className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={18} aria-hidden />
        </Link>
      ) : (
        <ToolButton icon={ArrowLeft} label={t("back")} onClick={goBack} />
      )}
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      {role !== "archive" && !inTrash && (
        <ToolButton icon={Archive} label={t("archive")} disabled={pending} onClick={() => run(() => moveToRole(actionIds, "archive"))} />
      )}
      {inJunk ? (
        <ToolButton icon={ShieldCheck} label={t("notSpam")} disabled={pending} onClick={() => run(() => moveToRole(actionIds, "inbox"))} />
      ) : (
        <ToolButton icon={OctagonAlert} label={t("spam")} disabled={pending} onClick={() => run(() => moveToRole(actionIds, "junk"))} />
      )}
      <ToolButton
        icon={Trash2}
        label={inTrash ? t("deleteForever") : t("delete")}
        disabled={pending}
        onClick={() => {
          if (inTrash && !window.confirm(t("deleteForeverConfirm"))) return;
          run(() => (inTrash ? destroyEmails(actionIds) : moveToRole(actionIds, "trash")));
        }}
      />
      <ToolButton icon={MailOpen} label={t("markUnread")} disabled={pending} onClick={() => run(() => setSeen(allIds, false))} />
      <button
        type="button"
        onClick={toggleStar}
        disabled={pending}
        aria-pressed={isStarred}
        aria-label={isStarred ? t("unstar") : t("star")}
        title={isStarred ? t("unstar") : t("star")}
        className="icon-btn h-9 w-9"
      >
        <Star size={17} aria-hidden className={isStarred ? "fill-amber text-amber" : ""} />
      </button>

      {error && (
        <span role="alert" className="ml-2 hidden truncate text-[12.5px] text-danger sm:inline">
          {t("actionFailed")}
        </span>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <ComposeLink icon={Reply} label={t("reply")} href={composeHref(currentPath, "reply", latestId)} />
        <ComposeLink icon={ReplyAll} label={t("replyAll")} href={composeHref(currentPath, "replyAll", latestId)} />
        <ComposeLink icon={Forward} label={t("forward")} href={composeHref(currentPath, "forward", latestId)} />
      </div>
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="icon-btn h-9 w-9">
      <Icon size={17} aria-hidden />
    </button>
  );
}

function ComposeLink({ icon: Icon, label, href }: { icon: LucideIcon; label: string; href: string }) {
  return (
    <Link href={href} scroll={false} aria-label={label} title={label} className="icon-btn h-9 w-9">
      <Icon size={17} aria-hidden />
    </Link>
  );
}
