"use client";

import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Keyboard,
  Mail,
  MailOpen,
  OctagonAlert,
  Paperclip,
  RotateCw,
  Rows3,
  Rows4,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { usePopover } from "@/components/usePopover";
import { destroyEmails, moveTo, moveToRole, setFlagged, setSeen } from "./actions";
import { composeHref, threadHref } from "./hrefs";
import {
  DENSITY_COOKIE,
  DRAG_MIME,
  DROP_EVENT,
  mailboxTree,
  type Density,
  type DropDetail,
  type MailboxLite,
  type MailboxRole,
} from "./listShared";
import { MailLive } from "./MailLive";
import { useShortcuts } from "./useShortcuts";

/** One conversation row, pre-formatted on the server (dates use the server's view of "today"). */
export type MailRow = {
  key: string;
  emailId: string;
  threadId: string;
  emailIds: string[];
  isDraft: boolean;
  sender: string;
  senderEmail?: string;
  subject: string;
  preview: string;
  receivedAt: string;
  dateLabel: string;
  dateTitle: string;
  hasAttachment: boolean;
  threadSize: number;
  unread: boolean;
  flagged: boolean;
};

type Op =
  | { type: "remove"; keys: string[] }
  | { type: "patch"; keys: string[]; unread?: boolean; flagged?: boolean };

function reduce(rows: MailRow[], op: Op): MailRow[] {
  const keys = new Set(op.keys);
  if (op.type === "remove") return rows.filter((r) => !keys.has(r.key));
  return rows.map((r) =>
    keys.has(r.key)
      ? { ...r, unread: op.unread ?? r.unread, flagged: op.flagged ?? r.flagged }
      : r,
  );
}

type Kind = "archive" | "delete" | "spam" | "notSpam" | "read" | "unread" | "star" | "unstar" | "move";

export function MailListClient({
  rows: serverRows,
  mailboxId,
  role,
  mailboxes,
  currentPath,
  prevHref,
  nextHref,
  rangeLabel,
  emptyText,
  initialDensity,
}: {
  rows: MailRow[];
  /** Mailbox id, or "search". */
  mailboxId: string;
  role: MailboxRole;
  mailboxes: MailboxLite[];
  currentPath: string;
  prevHref: string | null;
  nextHref: string | null;
  rangeLabel: string;
  emptyText: string;
  initialDensity: Density;
}) {
  const t = useTranslations("mailActions");
  const tm = useTranslations("mail");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, applyOp] = useOptimistic(serverRows, reduce);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>(initialDensity);
  const [error, setError] = useState<string | null>(null);
  const help = useRef<HTMLDialogElement>(null);

  const isSearch = mailboxId === "search";
  const trashLike = role === "trash" || role === "junk";
  const selectedKeys = useMemo(() => rows.filter((r) => selected.has(r.key)).map((r) => r.key), [rows, selected]);
  const focusedIndex = rows.findIndex((r) => r.key === focusedKey);
  const focused = focusedIndex >= 0 ? rows[focusedIndex] : null;

  const folderLabel = (m: MailboxLite) => (m.role && tm.has(`folders.${m.role}`) ? tm(`folders.${m.role}`) : m.name);
  const rowHref = (r: MailRow) =>
    r.isDraft ? composeHref(currentPath, "draft", r.emailId) : threadHref(mailboxId, r.threadId);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(() => {
    if (!focusedKey) return;
    document.querySelector(`[data-row="${CSS.escape(focusedKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusedKey]);

  function act(kind: Kind, keys: string[], target?: string) {
    const targets = rows.filter((r) => keys.includes(r.key));
    if (!targets.length) return;
    const ids = targets.flatMap((r) => r.emailIds);
    keys = targets.map((r) => r.key);
    const remove: Op = { type: "remove", keys };
    let op: Op;
    let call: () => Promise<void>;
    switch (kind) {
      case "archive":
        op = remove;
        call = () => moveToRole(ids, "archive");
        break;
      case "delete":
        op = remove;
        if (trashLike) {
          if (!window.confirm(t("confirmDestroy", { count: keys.length }))) return;
          call = () => destroyEmails(ids);
        } else call = () => moveToRole(ids, "trash");
        break;
      case "spam":
        op = remove;
        call = () => moveToRole(ids, "junk");
        break;
      case "notSpam":
        op = remove;
        call = () => moveToRole(ids, "inbox");
        break;
      case "move":
        if (!target || target === mailboxId) return;
        op = remove;
        call = () => moveTo(ids, target);
        break;
      case "read":
      case "unread":
        op = { type: "patch", keys, unread: kind === "unread" };
        call = () => setSeen(ids, kind === "read");
        break;
      case "star":
      case "unstar":
        op = { type: "patch", keys, flagged: kind === "star" };
        call = () => setFlagged(ids, kind === "star");
        break;
    }
    // Search spans every folder, so a moved conversation still matches: don't hide it.
    if (op.type === "remove" && isSearch && kind !== "delete") op = { type: "patch", keys };

    if (op.type === "remove") {
      const gone = new Set(keys);
      if (focusedKey && gone.has(focusedKey)) {
        const after = rows.slice(focusedIndex + 1).find((r) => !gone.has(r.key));
        const before = rows.slice(0, focusedIndex).reverse().find((r) => !gone.has(r.key));
        setFocusedKey((after ?? before)?.key ?? null);
      }
      setSelected((s) => new Set([...s].filter((k) => !gone.has(k))));
    }

    const finalOp = op;
    startTransition(async () => {
      applyOp(finalOp);
      try {
        await call();
        router.refresh();
      } catch {
        setError(t("actionFailed"));
      }
    });
  }

  // Rows dropped on a folder in the nav.
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    const onDrop = (e: Event) => {
      const { keys, mailboxId: target } = (e as CustomEvent<DropDetail>).detail;
      actRef.current("move", keys, target);
    };
    window.addEventListener(DROP_EVENT, onDrop);
    return () => window.removeEventListener(DROP_EVENT, onDrop);
  }, []);

  function toggle(key: string, shift = false) {
    const on = !selected.has(key);
    const next = new Set(selected);
    const from = anchor ? rows.findIndex((r) => r.key === anchor) : -1;
    const to = rows.findIndex((r) => r.key === key);
    if (shift && from >= 0 && to >= 0) {
      for (const r of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) on ? next.add(r.key) : next.delete(r.key);
    } else on ? next.add(key) : next.delete(key);
    setSelected(next);
    setAnchor(key);
  }

  const selectWhere = (pred: (r: MailRow) => boolean) => setSelected(new Set(rows.filter(pred).map((r) => r.key)));

  function changeDensity() {
    const next: Density = density === "compact" ? "comfortable" : "compact";
    setDensity(next);
    document.cookie = `${DENSITY_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  const starKind = (keys: string[]): Kind =>
    rows.filter((r) => keys.includes(r.key)).every((r) => r.flagged) ? "unstar" : "star";

  useShortcuts((e) => {
    if (help.current?.open) return false;
    const targets = selectedKeys.length ? selectedKeys : focused ? [focused.key] : [];
    const moveFocus = (delta: number) => {
      if (!rows.length) return;
      const i = focusedIndex < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, focusedIndex + delta));
      setFocusedKey(rows[i].key);
    };
    switch (e.key) {
      case "j":
        moveFocus(1);
        return true;
      case "k":
        moveFocus(-1);
        return true;
      case "o":
      case "Enter":
        if (e.key === "Enter" && (e.target as HTMLElement).closest?.("a,button")) return false;
        if (!focused) return false;
        router.push(rowHref(focused));
        return true;
      case "x":
        if (!focused) return false;
        toggle(focused.key);
        return true;
      case "s":
        act(starKind(targets), targets);
        return true;
      case "e":
        if (role === "archive") return false;
        act("archive", targets);
        return true;
      case "#":
        act("delete", targets);
        return true;
      case "I":
        act("read", targets);
        return true;
      case "U":
        act("unread", targets);
        return true;
      case "c":
        router.push(composeHref(currentPath, "new"));
        return true;
      case "r":
      case "a":
      case "f":
        if (!focused) return false;
        router.push(
          composeHref(currentPath, e.key === "r" ? "reply" : e.key === "a" ? "replyAll" : "forward", focused.emailId),
        );
        return true;
      case "?":
        help.current?.showModal();
        return true;
      case "Escape":
        if (!selected.size) return false;
        setSelected(new Set());
        return true;
      default:
        return false;
    }
  });

  const allSelected = rows.length > 0 && selectedKeys.length === rows.length;
  const someSelected = selectedKeys.length > 0;
  const compact = density === "compact";

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
        <SelectMenu
          all={allSelected}
          some={someSelected}
          disabled={!rows.length}
          onToggle={() => setSelected(allSelected || someSelected ? new Set() : new Set(rows.map((r) => r.key)))}
          onPick={(which) =>
            which === "all"
              ? selectWhere(() => true)
              : which === "none"
                ? setSelected(new Set())
                : which === "read"
                  ? selectWhere((r) => !r.unread)
                  : which === "unread"
                    ? selectWhere((r) => r.unread)
                    : which === "starred"
                      ? selectWhere((r) => r.flagged)
                      : selectWhere((r) => !r.flagged)
          }
        />

        {someSelected ? (
          <div className="flex min-w-0 flex-1 items-center gap-0.5" role="toolbar" aria-label={t("bulkActions")}>
            <span className="mr-2 ml-1 font-mono text-[12px] tabular-nums text-ink-soft">
              {t("selected", { count: selectedKeys.length })}
            </span>
            {role !== "archive" && (
              <ToolButton label={t("archive")} kbd="e" onClick={() => act("archive", selectedKeys)}>
                <Archive size={17} aria-hidden />
              </ToolButton>
            )}
            <ToolButton
              label={trashLike ? t("deleteForever") : t("delete")}
              kbd="#"
              onClick={() => act("delete", selectedKeys)}
            >
              <Trash2 size={17} aria-hidden />
            </ToolButton>
            {role === "junk" ? (
              <ToolButton label={t("notSpam")} onClick={() => act("notSpam", selectedKeys)}>
                <ShieldCheck size={17} aria-hidden />
              </ToolButton>
            ) : (
              <ToolButton label={t("spam")} onClick={() => act("spam", selectedKeys)}>
                <OctagonAlert size={17} aria-hidden />
              </ToolButton>
            )}
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <ToolButton label={t("markRead")} kbd="⇧I" onClick={() => act("read", selectedKeys)}>
              <MailOpen size={17} aria-hidden />
            </ToolButton>
            <ToolButton label={t("markUnread")} kbd="⇧U" onClick={() => act("unread", selectedKeys)}>
              <Mail size={17} aria-hidden />
            </ToolButton>
            <ToolButton
              label={starKind(selectedKeys) === "star" ? t("star") : t("unstar")}
              kbd="s"
              onClick={() => act(starKind(selectedKeys), selectedKeys)}
            >
              <Star size={17} aria-hidden />
            </ToolButton>
            <MovePicker
              mailboxes={mailboxes.filter((m) => m.id !== mailboxId)}
              label={folderLabel}
              onPick={(id) => act("move", selectedKeys, id)}
            />
            <button
              type="button"
              className="icon-btn ml-auto h-9 w-9"
              aria-label={t("clearSelection")}
              title={t("clearSelection")}
              onClick={() => setSelected(new Set())}
            >
              <X size={17} aria-hidden />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn h-9 w-9"
              aria-label={tm("refresh")}
              title={tm("refresh")}
              onClick={() => startTransition(() => router.refresh())}
            >
              <RotateCw size={17} aria-hidden className={pending ? "animate-spin" : undefined} />
            </button>
            <button
              type="button"
              className="icon-btn h-9 w-9"
              aria-label={compact ? t("comfortable") : t("compact")}
              title={`${t("density")}: ${compact ? t("compact") : t("comfortable")}`}
              onClick={changeDensity}
            >
              {compact ? <Rows4 size={17} aria-hidden /> : <Rows3 size={17} aria-hidden />}
            </button>
            <button
              type="button"
              className="icon-btn h-9 w-9"
              aria-label={t("shortcuts")}
              title={`${t("shortcuts")} (?)`}
              onClick={() => help.current?.showModal()}
            >
              <Keyboard size={17} aria-hidden />
            </button>
            <MailLive pending={pending} />
            {error && (
              <span role="alert" className="ml-2 truncate text-[13px] text-danger">
                {error}
              </span>
            )}
            <span className="ml-auto font-mono text-[12px] tabular-nums text-ink-mute">{rangeLabel}</span>
            <PageLink href={prevHref} label={t("previousPage")}>
              <ChevronLeft size={18} aria-hidden />
            </PageLink>
            <PageLink href={nextHref} label={t("nextPage")}>
              <ChevronRight size={18} aria-hidden />
            </PageLink>
          </>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="grid flex-1 place-items-center p-10 text-center">
          <div className="rise">
            <p className="text-[17px] font-medium text-ink">{emptyText}</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">{tm("empty")}</p>
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto" aria-label={t("conversations")}>
          {rows.map((r, i) => (
            <Row
              key={r.key}
              row={r}
              index={i}
              href={rowHref(r)}
              compact={compact}
              selected={selected.has(r.key)}
              focused={r.key === focusedKey}
              onToggle={(shift) => toggle(r.key, shift)}
              onFocus={() => setFocusedKey(r.key)}
              onAct={(kind) => act(kind, [r.key])}
              dragKeys={() => (selected.has(r.key) ? selectedKeys : [r.key])}
              archiveable={role !== "archive"}
              trashLike={trashLike}
            />
          ))}
        </ul>
      )}

      <ShortcutsDialog ref={help} />
    </>
  );
}

function ToolButton({
  label,
  kbd,
  onClick,
  children,
}: {
  label: string;
  kbd?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="icon-btn h-9 w-9"
      aria-label={label}
      title={kbd ? `${label} (${kbd})` : label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PageLink({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  if (!href)
    return (
      <span className="icon-btn h-9 w-9 opacity-35" aria-hidden>
        {children}
      </span>
    );
  return (
    <Link href={href} className="icon-btn h-9 w-9" aria-label={label} title={label}>
      {children}
    </Link>
  );
}

type SelectPick = "all" | "none" | "read" | "unread" | "starred" | "unstarred";

function SelectMenu({
  all,
  some,
  disabled,
  onToggle,
  onPick,
}: {
  all: boolean;
  some: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPick: (which: SelectPick) => void;
}) {
  const t = useTranslations("mailActions");
  const { open, toggle, setOpen, ref } = usePopover();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = some && !all;
  }, [some, all]);

  return (
    <div ref={ref} className="relative flex items-center">
      <label className="grid h-9 w-8 cursor-pointer place-items-center rounded-md hover:bg-hover" title={t("select")}>
        <input
          ref={box}
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-primary"
          checked={all}
          disabled={disabled}
          onChange={onToggle}
          aria-label={all || some ? t("selectNone") : t("selectAll")}
        />
      </label>
      <button
        type="button"
        className="icon-btn h-9 w-5"
        aria-label={t("selectMenu")}
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute top-10 left-0 z-50 w-44 p-1.5" style={{ transformOrigin: "top left" }}>
          {(["all", "none", "read", "unread", "starred", "unstarred"] as const).map((w) => (
            <button
              key={w}
              type="button"
              role="menuitem"
              className="flex w-full rounded-lg px-3 py-2 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
              onClick={() => {
                onPick(w);
                setOpen(false);
              }}
            >
              {t(`pick.${w}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MovePicker({
  mailboxes,
  label,
  onPick,
}: {
  mailboxes: MailboxLite[];
  label: (m: MailboxLite) => string;
  onPick: (mailboxId: string) => void;
}) {
  const t = useTranslations("mailActions");
  const { open, toggle, setOpen, ref } = usePopover();
  const tree = mailboxTree(mailboxes);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="icon-btn h-9 w-9"
        aria-label={t("moveTo")}
        title={t("moveTo")}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <FolderInput size={17} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("moveTo")}
          className="pop absolute top-11 left-0 z-50 max-h-80 w-60 overflow-y-auto p-1.5"
          style={{ transformOrigin: "top left" }}
        >
          <p className="px-3 pt-1.5 pb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">
            {t("moveTo")}
          </p>
          {tree.map(({ mailbox: m, depth }) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-lg py-2 pr-3 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => {
                setOpen(false);
                onPick(m.id);
              }}
            >
              <span className="truncate">{label(m)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  row: r,
  index,
  href,
  compact,
  selected,
  focused,
  onToggle,
  onFocus,
  onAct,
  dragKeys,
  archiveable,
  trashLike,
}: {
  row: MailRow;
  index: number;
  href: string;
  compact: boolean;
  selected: boolean;
  focused: boolean;
  onToggle: (shift: boolean) => void;
  onFocus: () => void;
  onAct: (kind: Kind) => void;
  dragKeys: () => string[];
  archiveable: boolean;
  trashLike: boolean;
}) {
  const t = useTranslations("mailActions");
  const tm = useTranslations("mail");
  const strong = r.unread ? "font-semibold text-ink" : "text-ink-soft";

  return (
    <li
      data-row={r.key}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragKeys()));
        e.dataTransfer.setData("text/plain", r.subject);
      }}
      onMouseDown={onFocus}
      className={`rise group relative flex items-center gap-1 border-b border-line/70 pr-3 pl-2 transition-colors ${
        compact ? "h-9 text-[13px]" : "h-12 text-[14px]"
      } ${selected ? "bg-primary-soft" : r.unread ? "bg-sheet" : "bg-sheet-muted/50"} hover:bg-hover ${
        focused ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""
      }`}
      style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
    >
      <label className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-line/60">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-primary"
          checked={selected}
          readOnly
          onClick={(e) => onToggle(e.shiftKey)}
          aria-label={t("selectConversation", { subject: r.subject || tm("noSubject") })}
        />
      </label>
      <button
        type="button"
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-line/60 ${
          r.flagged ? "text-amber" : "text-ink-mute/60 hover:text-ink"
        }`}
        aria-pressed={r.flagged}
        aria-label={r.flagged ? t("unstar") : t("star")}
        title={r.flagged ? t("unstar") : t("star")}
        onClick={() => onAct(r.flagged ? "unstar" : "star")}
      >
        <Star size={16} aria-hidden fill={r.flagged ? "currentColor" : "none"} />
      </button>

      <Link
        href={href}
        draggable={false}
        className="flex h-full min-w-0 flex-1 items-center gap-4 pl-1 focus-visible:rounded-sm focus-visible:outline-offset-[-2px]"
      >
        <span className={`flex w-[200px] shrink-0 items-baseline gap-1.5 truncate ${strong}`} title={r.senderEmail}>
          <span className="truncate">{r.sender}</span>
          {r.threadSize > 1 && (
            <span className="font-mono text-[11px] font-normal tabular-nums text-ink-mute">{r.threadSize}</span>
          )}
          {r.isDraft && <span className="text-[12px] font-normal text-danger">{t("draft")}</span>}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className={strong}>{r.subject || tm("noSubject")}</span>
          {r.preview && <span className="text-ink-mute"> — {r.preview}</span>}
        </span>
        {r.hasAttachment && <Paperclip size={15} className="shrink-0 text-ink-mute" aria-label={t("attachment")} />}
        <time
          dateTime={r.receivedAt}
          title={r.dateTitle}
          className={`w-16 shrink-0 text-right text-[12.5px] tabular-nums group-focus-within:invisible group-hover:invisible ${
            r.unread ? "font-semibold text-ink" : "text-ink-mute"
          }`}
        >
          {r.dateLabel}
        </time>
      </Link>

      <div className="absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg bg-hover pl-1 group-focus-within:flex group-hover:flex">
        {archiveable && (
          <QuickAction label={t("archive")} onClick={() => onAct("archive")}>
            <Archive size={16} aria-hidden />
          </QuickAction>
        )}
        <QuickAction label={trashLike ? t("deleteForever") : t("delete")} onClick={() => onAct("delete")}>
          <Trash2 size={16} aria-hidden />
        </QuickAction>
        {r.unread ? (
          <QuickAction label={t("markRead")} onClick={() => onAct("read")}>
            <MailOpen size={16} aria-hidden />
          </QuickAction>
        ) : (
          <QuickAction label={t("markUnread")} onClick={() => onAct("unread")}>
            <Mail size={16} aria-hidden />
          </QuickAction>
        )}
      </div>
    </li>
  );
}

function QuickAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="icon-btn h-8 w-8" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

const SHORTCUTS: [keys: string[], id: string][] = [
  [["j", "k"], "navigate"],
  [["o", "Enter"], "open"],
  [["x"], "select"],
  [["s"], "star"],
  [["e"], "archive"],
  [["#"], "delete"],
  [["⇧", "I"], "markRead"],
  [["⇧", "U"], "markUnread"],
  [["c"], "compose"],
  [["r"], "reply"],
  [["a"], "replyAll"],
  [["f"], "forward"],
  [["/"], "search"],
  [["Esc"], "clear"],
  [["?"], "help"],
];

function ShortcutsDialog({ ref }: { ref: React.Ref<HTMLDialogElement> }) {
  const t = useTranslations("mailActions");
  return (
    <dialog
      ref={ref}
      aria-labelledby="shortcuts-title"
      className="pop m-auto w-[min(440px,calc(100vw-32px))] p-0 text-ink backdrop:bg-black/40"
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
    >
      <div className="flex items-center border-b border-line px-5 py-3.5">
        <h2 id="shortcuts-title" className="text-[15px] font-medium">
          {t("shortcuts")}
        </h2>
        <form method="dialog" className="ml-auto">
          <button className="icon-btn h-8 w-8" aria-label={t("close")}>
            <X size={16} aria-hidden />
          </button>
        </form>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2.5 px-5 py-4 text-[14px]">
        {SHORTCUTS.map(([keys, id]) => (
          <div key={id} className="contents">
            <dt className="text-ink-soft">{t(`help.${id}`)}</dt>
            <dd className="flex items-center justify-end gap-1">
              {keys.map((k) => (
                <kbd key={k} className="kbd">
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
