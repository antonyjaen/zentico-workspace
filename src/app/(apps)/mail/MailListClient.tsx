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
  Menu,
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
import type { Label } from "@/lib/mail-labels";
import { destroyEmails, moveTo, moveToRole, setFlagged, setLabel, setSeen } from "./actions";
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
import { LabelChip, LabelPicker } from "./LabelPicker";
import { MailLive } from "./MailLive";
import { useOpenMailNav } from "./MailNavDrawer";
import { MobileSearch } from "./MobileSearch";
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
  /** Label ids on the conversation. */
  labels: string[];
  /** Shared account the conversation belongs to (undefined: the user's own account). */
  accountId?: string;
  accountName?: string;
};

/** What the list shows: a folder, search results, a label, or the unified inbox. */
export type ListView = "mailbox" | "search" | "label" | "unified";

type Op =
  | { type: "remove"; keys: string[] }
  | { type: "patch"; keys: string[]; unread?: boolean; flagged?: boolean }
  | { type: "label"; keys: string[]; id: string; on: boolean };

function reduce(rows: MailRow[], op: Op): MailRow[] {
  const keys = new Set(op.keys);
  if (op.type === "remove") return rows.filter((r) => !keys.has(r.key));
  if (op.type === "label")
    return rows.map((r) =>
      keys.has(r.key)
        ? { ...r, labels: op.on ? [...new Set([...r.labels, op.id])] : r.labels.filter((l) => l !== op.id) }
        : r,
    );
  return rows.map((r) =>
    keys.has(r.key)
      ? { ...r, unread: op.unread ?? r.unread, flagged: op.flagged ?? r.flagged }
      : r,
  );
}

type Kind =
  | "archive"
  | "delete"
  | "spam"
  | "notSpam"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "move"
  | "label"
  | "unlabel";

export function MailListClient({
  rows: serverRows,
  mailboxId,
  view = "mailbox",
  labels = [],
  account,
  title,
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
  /** Mailbox id, or a virtual list id ("search", "label:<id>", "unified"). */
  mailboxId: string;
  view?: ListView;
  labels?: Label[];
  /** Shared account the whole list belongs to. */
  account?: string;
  title?: string;
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
  const openNav = useOpenMailNav();
  // Touch devices: rows are not draggable (long-press selects instead).
  const [coarse, setCoarse] = useState(false);
  useEffect(() => setCoarse(window.matchMedia("(pointer: coarse)").matches), []);

  // Search and label views span folders, so a moved conversation still matches: keep it shown.
  const spansFolders = view === "search" || view === "label";
  const viewedLabel = view === "label" ? mailboxId.slice("label:".length) : null;
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const trashLike = role === "trash" || role === "junk";
  const selectedKeys = useMemo(() => rows.filter((r) => selected.has(r.key)).map((r) => r.key), [rows, selected]);
  const focusedIndex = rows.findIndex((r) => r.key === focusedKey);
  const focused = focusedIndex >= 0 ? rows[focusedIndex] : null;

  const folderLabel = (m: MailboxLite) => (m.role && tm.has(`folders.${m.role}`) ? tm(`folders.${m.role}`) : m.name);
  const rowHref = (r: MailRow) => {
    if (r.isDraft && !r.accountId) return composeHref(currentPath, "draft", r.emailId);
    const href = threadHref(view === "mailbox" ? mailboxId : "search", r.threadId);
    return r.accountId ? `${href}?account=${encodeURIComponent(r.accountId)}` : href;
  };
  const labelState = (id: string): "all" | "some" | "none" => {
    const sel = rows.filter((r) => selected.has(r.key));
    const n = sel.filter((r) => r.labels.includes(id)).length;
    return n === 0 ? "none" : n === sel.length ? "all" : "some";
  };

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
    keys = targets.map((r) => r.key);
    // Rows can come from several accounts (unified inbox): one call per account.
    const groups = new Map<string | undefined, string[]>();
    for (const r of targets) groups.set(r.accountId, [...(groups.get(r.accountId) ?? []), ...r.emailIds]);
    const remove: Op = { type: "remove", keys };
    let op: Op;
    let each: (ids: string[], account?: string) => Promise<void>;
    switch (kind) {
      case "archive":
        op = remove;
        each = (ids, acc) => moveToRole(ids, "archive", acc);
        break;
      case "delete":
        op = remove;
        if (trashLike) {
          if (!window.confirm(t("confirmDestroy", { count: keys.length }))) return;
          each = (ids, acc) => destroyEmails(ids, acc);
        } else each = (ids, acc) => moveToRole(ids, "trash", acc);
        break;
      case "spam":
        op = remove;
        each = (ids, acc) => moveToRole(ids, "junk", acc);
        break;
      case "notSpam":
        op = remove;
        each = (ids, acc) => moveToRole(ids, "inbox", acc);
        break;
      case "move":
        if (!target || target === mailboxId) return;
        op = remove;
        each = (ids, acc) => moveTo(ids, target, acc);
        break;
      case "read":
      case "unread":
        op = { type: "patch", keys, unread: kind === "unread" };
        each = (ids, acc) => setSeen(ids, kind === "read", acc);
        break;
      case "star":
      case "unstar":
        op = { type: "patch", keys, flagged: kind === "star" };
        each = (ids, acc) => setFlagged(ids, kind === "star", acc);
        break;
      case "label":
      case "unlabel":
        if (!target) return;
        op = kind === "unlabel" && target === viewedLabel ? remove : { type: "label", keys, id: target, on: kind === "label" };
        each = (ids, acc) => setLabel(ids, target, kind === "label", acc);
        break;
    }
    const call = async () => {
      for (const [acc, ids] of groups) await each(ids, acc);
    };
    if (op.type === "remove" && spansFolders && kind !== "delete" && kind !== "unlabel") op = { type: "patch", keys };

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

  /** Bulk actions: inline in the header from `sm` up; in a bottom bar on phones (bigger targets, menus open upward). */
  const bulkButtons = (phone: boolean) => {
    const btn = phone ? "icon-btn h-11 w-10" : "icon-btn h-9 w-9";
    const menu = phone ? PHONE_MENU : undefined;
    return (
      <>
        {role !== "archive" && (
          <ToolButton label={t("archive")} kbd="e" className={btn} onClick={() => act("archive", selectedKeys)}>
            <Archive size={17} aria-hidden />
          </ToolButton>
        )}
        <ToolButton
          label={trashLike ? t("deleteForever") : t("delete")}
          kbd="#"
          className={btn}
          onClick={() => act("delete", selectedKeys)}
        >
          <Trash2 size={17} aria-hidden />
        </ToolButton>
        {role === "junk" ? (
          <ToolButton label={t("notSpam")} className={btn} onClick={() => act("notSpam", selectedKeys)}>
            <ShieldCheck size={17} aria-hidden />
          </ToolButton>
        ) : (
          <ToolButton label={t("spam")} className={btn} onClick={() => act("spam", selectedKeys)}>
            <OctagonAlert size={17} aria-hidden />
          </ToolButton>
        )}
        {!phone && <span className="mx-1 h-5 w-px bg-line" aria-hidden />}
        <ToolButton label={t("markRead")} kbd="⇧I" className={btn} onClick={() => act("read", selectedKeys)}>
          <MailOpen size={17} aria-hidden />
        </ToolButton>
        <ToolButton label={t("markUnread")} kbd="⇧U" className={btn} onClick={() => act("unread", selectedKeys)}>
          <Mail size={17} aria-hidden />
        </ToolButton>
        <ToolButton
          label={starKind(selectedKeys) === "star" ? t("star") : t("unstar")}
          kbd="s"
          className={btn}
          onClick={() => act(starKind(selectedKeys), selectedKeys)}
        >
          <Star size={17} aria-hidden />
        </ToolButton>
        {!account && (
          <LabelPicker
            labels={labels}
            stateOf={labelState}
            onToggle={(id, on) => act(on ? "label" : "unlabel", selectedKeys, id)}
            buttonClassName={btn}
            menuClassName={menu}
          />
        )}
        {view !== "unified" && (
          <MovePicker
            mailboxes={mailboxes.filter((m) => m.id !== mailboxId)}
            label={folderLabel}
            onPick={(id) => act("move", selectedKeys, id)}
            buttonClassName={btn}
            menuClassName={menu}
          />
        )}
      </>
    );
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3 max-sm:px-1.5">
        {openNav && !someSelected && (
          <button
            type="button"
            className="icon-btn h-10 w-10 lg:hidden"
            aria-label={t("mobile.folders")}
            title={t("mobile.folders")}
            onClick={openNav}
          >
            <Menu size={19} aria-hidden />
          </button>
        )}
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
            <div className="hidden sm:contents">{bulkButtons(false)}</div>
            <button
              type="button"
              className="icon-btn ml-auto h-10 w-10 sm:h-9 sm:w-9"
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
              className="icon-btn h-10 w-10 sm:h-9 sm:w-9"
              aria-label={tm("refresh")}
              title={tm("refresh")}
              onClick={() => startTransition(() => router.refresh())}
            >
              <RotateCw size={17} aria-hidden className={pending ? "animate-spin" : undefined} />
            </button>
            <MobileSearch />
            <button
              type="button"
              className="icon-btn h-9 w-9 max-sm:hidden"
              aria-label={compact ? t("comfortable") : t("compact")}
              title={`${t("density")}: ${compact ? t("compact") : t("comfortable")}`}
              onClick={changeDensity}
            >
              {compact ? <Rows4 size={17} aria-hidden /> : <Rows3 size={17} aria-hidden />}
            </button>
            <button
              type="button"
              className="icon-btn h-9 w-9 max-sm:hidden"
              aria-label={t("shortcuts")}
              title={`${t("shortcuts")} (?)`}
              onClick={() => help.current?.showModal()}
            >
              <Keyboard size={17} aria-hidden />
            </button>
            <MailLive pending={pending} />
            {title && <h1 className="ml-2 min-w-0 truncate text-[14px] font-medium text-ink">{title}</h1>}
            {error && (
              <span role="alert" className="ml-2 truncate text-[13px] text-danger max-sm:hidden">
                {error}
              </span>
            )}
            <span className="ml-auto font-mono text-[12px] tabular-nums text-ink-mute max-sm:hidden">{rangeLabel}</span>
            <PageLink href={prevHref} label={t("previousPage")} className="max-sm:ml-auto">
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
        <ul className="flex-1 overflow-y-auto max-lg:pb-24" aria-label={t("conversations")}>
          {rows.map((r, i) => (
            <Row
              key={r.key}
              row={r}
              index={i}
              href={rowHref(r)}
              compact={compact}
              selected={selected.has(r.key)}
              selecting={someSelected}
              draggable={!coarse}
              focused={r.key === focusedKey}
              onToggle={(shift) => toggle(r.key, shift)}
              onFocus={() => setFocusedKey(r.key)}
              onAct={(kind) => act(kind, [r.key])}
              dragKeys={() => (selected.has(r.key) ? selectedKeys : [r.key])}
              archiveable={role !== "archive"}
              trashLike={trashLike}
              labels={r.labels
                .filter((id) => id !== viewedLabel)
                .map((id) => labelById.get(id))
                .filter((l): l is Label => !!l)}
            />
          ))}
        </ul>
      )}

      {/* Phones: the selection's actions sit in a bottom bar within thumb reach (hides the compose button). */}
      {someSelected && (
        <div
          data-mail-bulkbar
          role="toolbar"
          aria-label={t("bulkActions")}
          className="fixed inset-x-0 bottom-0 z-[45] flex items-center justify-around border-t border-line bg-sheet px-1 pt-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-pop)] sm:hidden"
        >
          {bulkButtons(true)}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="pop fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 px-4 py-3 text-[14px] text-danger sm:hidden"
        >
          {error}
        </div>
      )}

      <ShortcutsDialog ref={help} />
    </>
  );
}

function ToolButton({
  label,
  kbd,
  onClick,
  className = "icon-btn h-9 w-9",
  children,
}: {
  label: string;
  kbd?: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={kbd ? `${label} (${kbd})` : label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Label/move menus opened from the phone bottom bar: a sheet just above the bar. */
const PHONE_MENU = "fixed inset-x-2 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-50 max-h-[60dvh]";

function PageLink({
  href,
  label,
  className = "",
  children,
}: {
  href: string | null;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!href)
    return (
      <span className={`icon-btn h-10 w-10 opacity-35 sm:h-9 sm:w-9 ${className}`} aria-hidden>
        {children}
      </span>
    );
  return (
    <Link href={href} className={`icon-btn h-10 w-10 sm:h-9 sm:w-9 ${className}`} aria-label={label} title={label}>
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
      <label className="grid h-10 w-9 cursor-pointer place-items-center rounded-md hover:bg-hover sm:h-9 sm:w-8" title={t("select")}>
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
        className="icon-btn h-10 w-6 sm:h-9 sm:w-5"
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
  buttonClassName = "icon-btn h-9 w-9",
  menuClassName = "absolute top-11 left-0 z-50 max-h-80 w-60",
}: {
  mailboxes: MailboxLite[];
  label: (m: MailboxLite) => string;
  onPick: (mailboxId: string) => void;
  buttonClassName?: string;
  /** Position and size of the menu. */
  menuClassName?: string;
}) {
  const t = useTranslations("mailActions");
  const { open, toggle, setOpen, ref } = usePopover();
  const tree = mailboxTree(mailboxes);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={buttonClassName}
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
          className={`pop overflow-y-auto p-1.5 ${menuClassName}`}
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
              className="flex w-full items-center rounded-lg py-2 pr-3 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink max-sm:min-h-11"
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
  selecting,
  draggable,
  focused,
  onToggle,
  onFocus,
  onAct,
  dragKeys,
  archiveable,
  trashLike,
  labels,
}: {
  row: MailRow;
  index: number;
  href: string;
  compact: boolean;
  selected: boolean;
  /** Some row is selected: on touch, tapping a row toggles it instead of opening it. */
  selecting: boolean;
  draggable: boolean;
  focused: boolean;
  onToggle: (shift: boolean) => void;
  onFocus: () => void;
  onAct: (kind: Kind) => void;
  dragKeys: () => string[];
  archiveable: boolean;
  trashLike: boolean;
  labels: Label[];
}) {
  const t = useTranslations("mailActions");
  const tm = useTranslations("mail");
  const strong = r.unread ? "font-semibold text-ink" : "text-ink-soft";

  // Touch: a long press selects the row (and starts selection mode).
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; touch: boolean; fired: boolean; x: number; y: number }>({
    touch: false,
    fired: false,
    x: 0,
    y: 0,
  });
  const cancelPress = () => clearTimeout(press.current.timer);
  useEffect(() => cancelPress, []);

  return (
    <li
      data-row={r.key}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragKeys()));
        e.dataTransfer.setData("text/plain", r.subject);
      }}
      onMouseDown={onFocus}
      onPointerDown={(e) => {
        const p = press.current;
        p.touch = e.pointerType === "touch";
        p.fired = false;
        cancelPress();
        if (!p.touch || (e.target as HTMLElement).closest("button,label")) return;
        p.x = e.clientX;
        p.y = e.clientY;
        p.timer = setTimeout(() => {
          p.fired = true;
          onToggle(false);
          navigator.vibrate?.(10);
        }, 450);
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (Math.abs(e.clientX - p.x) > 8 || Math.abs(e.clientY - p.y) > 8) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => press.current.touch && e.preventDefault()}
      className={`rise group relative flex items-center gap-1 border-b border-line/70 pr-1 pl-1 transition-colors sm:pr-3 sm:pl-2 ${
        compact ? "text-[13px] sm:h-9" : "text-[14px] sm:h-12"
      } ${selected ? "bg-primary-soft" : r.unread ? "bg-sheet" : "bg-sheet-muted/50"} hover:bg-hover ${
        focused ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""
      }`}
      style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
    >
      <label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-line/60 sm:h-8 sm:w-8">
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
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-md transition-colors hover:bg-line/60 max-sm:order-last sm:h-8 sm:w-8 ${
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
        onClick={(e) => {
          // After a long press, or while selecting on touch, a tap (de)selects instead of opening.
          if (press.current.fired) {
            e.preventDefault();
            press.current.fired = false;
          } else if (selecting && press.current.touch) {
            e.preventDefault();
            onToggle(false);
          }
        }}
        // Phones: two lines (sender + date, then subject + preview); a single row from sm up.
        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-2 pl-1 select-none [-webkit-touch-callout:none] focus-visible:rounded-sm focus-visible:outline-offset-[-2px] sm:flex sm:h-full sm:gap-4 sm:py-0 sm:select-auto"
      >
        <span
          className={`flex w-[200px] shrink-0 items-baseline gap-1.5 truncate max-sm:col-start-1 max-sm:row-start-1 max-sm:w-auto ${strong}`}
          title={r.senderEmail}
        >
          <span className="truncate">{r.sender}</span>
          {r.threadSize > 1 && (
            <span className="font-mono text-[11px] font-normal tabular-nums text-ink-mute">{r.threadSize}</span>
          )}
          {r.isDraft && <span className="text-[12px] font-normal text-danger">{t("draft")}</span>}
        </span>
        {r.accountName && (
          <span
            className="hidden max-w-[140px] shrink-0 truncate rounded-md bg-primary-soft px-1.5 font-mono text-[11px] leading-[20px] text-ink-soft md:inline"
            title={r.accountName}
          >
            {r.accountName}
          </span>
        )}
        {labels.length > 0 && (
          <span className="-mr-2 hidden shrink-0 items-center gap-1 md:flex">
            {labels.slice(0, 3).map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
            {labels.length > 3 && <span className="font-mono text-[11px] text-ink-mute">+{labels.length - 3}</span>}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate max-sm:col-start-1 max-sm:row-start-2">
          <span className={strong}>{r.subject || tm("noSubject")}</span>
          {r.preview && <span className="text-ink-mute"> — {r.preview}</span>}
        </span>
        {r.hasAttachment && (
          <Paperclip
            size={15}
            className="shrink-0 text-ink-mute max-sm:col-start-2 max-sm:row-start-2 max-sm:justify-self-end"
            aria-label={t("attachment")}
          />
        )}
        <time
          dateTime={r.receivedAt}
          title={r.dateTitle}
          className={`w-16 shrink-0 text-right text-[12.5px] tabular-nums max-sm:col-start-2 max-sm:row-start-1 sm:group-focus-within:invisible sm:group-hover:invisible ${
            r.unread ? "font-semibold text-ink" : "text-ink-mute"
          }`}
        >
          {r.dateLabel}
        </time>
      </Link>

      {/* Hover actions (desktop); on phones the same actions come from selecting the row. */}
      <div className="absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg bg-hover pl-1 sm:group-focus-within:flex sm:group-hover:flex">
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
