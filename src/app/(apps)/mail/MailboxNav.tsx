"use client";

import {
  Archive,
  ChevronRight,
  Ellipsis,
  File,
  Folder,
  Inbox,
  Mails,
  OctagonAlert,
  Plus,
  Send,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { usePopover } from "@/components/usePopover";
import type { Mailbox, MailAccount } from "@/lib/mail";
import { LABEL_COLOR_NAMES, LABEL_COLORS, type Label, type LabelColor } from "@/lib/mail-labels";
import { createFolder, createLabel, deleteFolder, deleteLabel, moveFolder, renameFolder, updateLabel } from "./actions";
import { LabelDot } from "./LabelPicker";
import { DRAG_MIME, DROP_EVENT, mailboxTree, type DropDetail } from "./listShared";

const ROLE_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  drafts: File,
  sent: Send,
  archive: Archive,
  junk: OctagonAlert,
  trash: Trash2,
};

// Rows are 40px tall in the phone/tablet drawer (touch), 32px in the desktop sidebar.
const ROW =
  "flex h-10 lg:h-8 items-center gap-3 rounded-md pr-3 text-[14px] transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-primary-soft aria-[current=page]:text-ink";
const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2 max-lg:min-h-11 text-left text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink";
const FIELD =
  "h-10 lg:h-8 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-mute focus:border-ink";

/** Which account sections are expanded, by account id (per browser). */
const OPEN_KEY = "zw_mail_nav_open";
/** Adds another signed-in address without switching away from the current one. */
const ADD_MAILBOX_HREF = "/api/auth/login?add=1&keep=1&returnTo=%2Fmail";

export type AccountInbox = { account: MailAccount; mailboxes: Mailbox[] };

/** Unread count shown on a folder row: drafts show their total, trash/junk nothing. */
const folderCount = (m: Mailbox) => (m.role === "drafts" ? m.totalEmails : m.role === "trash" || m.role === "junk" ? 0 : m.unreadEmails);

export function MailboxNav({
  own,
  others,
  stale,
  canAdd,
  labels,
  labelsAvailable,
}: {
  /** The active address; `account` is null when the account list couldn't be read. */
  own: { account: MailAccount | null; mailboxes: Mailbox[] };
  /** Other signed-in addresses, then mailboxes shared with any of them. */
  others: AccountInbox[];
  /** Signed-in addresses whose sign-in expired (they need a fresh sign-in to show their mail). */
  stale: string[];
  /** False when the browser already holds the maximum number of sign-ins. */
  canAdd: boolean;
  labels: Label[];
  /** False when the server has no Sieve (label definitions are stored in the filter script). */
  labelsAvailable: boolean;
}) {
  const t = useTranslations("mail.folders");
  const tn = useTranslations("mailActions.nav");
  const pathname = usePathname();
  const param = useSearchParams().get("account");
  // The account whose folder is open; null means the user's own (links without ?account).
  const viewing = param && param !== own.account?.id ? param : null;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline editors: renaming a folder/label, or creating a folder (under a parent or at the top).
  const [editing, setEditing] = useState<{ kind: "rename" | "newFolder" | "renameLabel" | "newLabel"; id: string | null } | null>(null);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) setOpenMap(saved as Record<string, boolean>);
    } catch {
      // Storage blocked or corrupt: keep the defaults.
    }
  }, []);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error]);

  const isOpen = (id: string, fallback: boolean) => (typeof openMap[id] === "boolean" ? openMap[id] : fallback);
  const toggleOpen = (id: string, fallback: boolean) =>
    setOpenMap((m) => {
      const next = { ...m, [id]: !(typeof m[id] === "boolean" ? m[id] : fallback) };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Not persisted; the section still toggles.
      }
      return next;
    });

  const folderLabel = (m: Mailbox) => (m.role && t.has(m.role) ? t(m.role) : m.name);

  /** Runs a sidebar mutation; shows a translated error on failure. */
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      try {
        const r = await fn();
        if (!r.ok) {
          const key = `errors.${r.error}`;
          setError(tn.has(key) ? tn(key) : tn("errors.generic"));
          return;
        }
        after?.();
        router.refresh();
      } catch {
        setError(tn("errors.generic"));
      }
    });

  const submitFolderName = (name: string) => {
    if (!editing || !name.trim()) return setEditing(null);
    const e = editing;
    if (e.kind === "rename" && e.id) run(() => renameFolder({ id: e.id!, name }), () => setEditing(null));
    if (e.kind === "newFolder") run(() => createFolder({ name, parentId: e.id }), () => setEditing(null));
    if (e.kind === "renameLabel" && e.id) run(() => updateLabel({ id: e.id!, name }), () => setEditing(null));
    if (e.kind === "newLabel") run(() => createLabel({ name, color: "blue" }), () => setEditing(null));
  };

  const mailboxes = own.mailboxes;
  const tree = mailboxTree(mailboxes);
  const descendants = (id: string) => {
    const out = new Set<string>([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of mailboxes) if (m.parentId && out.has(m.parentId) && !out.has(m.id)) out.add(m.id), (grew = true);
    }
    return out;
  };

  const isAt = (m: Mailbox) => pathname === `/mail/${m.id}` || pathname.startsWith(`/mail/${m.id}/`);
  // Rows dragged from the open list can only move within that list's account, so a folder only
  // accepts drops when it belongs to the account being viewed (never from the mixed unified list).
  const dropProps = (m: Mailbox, enabled: boolean) =>
    enabled && pathname !== "/mail/unified"
      ? {
          "data-drop": dropTarget === m.id || undefined,
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(m.id);
          },
          onDragLeave: () => setDropTarget((d) => (d === m.id ? null : d)),
          onDrop: (e: React.DragEvent) => {
            setDropTarget(null);
            let keys: unknown;
            try {
              keys = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
            } catch {
              return;
            }
            if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return;
            e.preventDefault();
            window.dispatchEvent(new CustomEvent<DropDetail>(DROP_EVENT, { detail: { keys, mailboxId: m.id } }));
          },
        }
      : {};
  const rowTone = (m: Mailbox) =>
    m.unreadEmails > 0 && folderCount(m) > 0 ? "font-medium text-ink" : "text-ink-soft aria-[current=page]:font-medium";
  const DROP_STYLE = "data-[drop]:bg-hover data-[drop]:text-ink data-[drop]:shadow-[inset_0_0_0_1px_var(--color-accent)]";

  const ownFolders = (
    <>
      {tree.map(({ mailbox: m, depth }) => {
        const Icon = (m.role && ROLE_ICON[m.role]) || Folder;
        const href = `/mail/${m.id}`;
        const active = !viewing && isAt(m);
        const count = folderCount(m);
        const renaming = editing?.kind === "rename" && editing.id === m.id;
        return (
          <div key={m.id}>
            {renaming ? (
              <InlineName
                initial={m.name}
                indent={12 + depth * 16}
                placeholder={tn("folderName")}
                disabled={pending}
                onSubmit={submitFolderName}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="group relative">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  {...dropProps(m, !viewing && !active)}
                  style={{ paddingLeft: 12 + depth * 16 }}
                  className={`${ROW} max-lg:pr-11 ${DROP_STYLE} ${rowTone(m)}`}
                >
                  <Icon size={16} aria-hidden className="shrink-0" />
                  <span className="flex-1 truncate">{folderLabel(m)}</span>
                  {count > 0 && (
                    <span className="font-mono text-[12px] font-normal tabular-nums text-ink-mute lg:group-focus-within:invisible lg:group-hover:invisible">
                      {count}
                    </span>
                  )}
                </Link>
                <FolderMenu
                  name={folderLabel(m)}
                  system={!!m.role}
                  parents={tree
                    .filter(({ mailbox: p }) => !descendants(m.id).has(p.id) && p.id !== m.parentId)
                    .map(({ mailbox: p, depth: d }) => ({ id: p.id, label: folderLabel(p), depth: d }))}
                  canMoveToTop={!!m.parentId}
                  disabled={pending}
                  onRename={() => setEditing({ kind: "rename", id: m.id })}
                  onNewSubfolder={() => setEditing({ kind: "newFolder", id: m.id })}
                  onMove={(parentId) => run(() => moveFolder({ id: m.id, parentId }))}
                  onDelete={() => run(() => deleteFolder({ id: m.id }), active ? () => router.push("/mail") : undefined)}
                />
              </div>
            )}
            {editing?.kind === "newFolder" && editing.id === m.id && (
              <InlineName
                initial=""
                indent={12 + (depth + 1) * 16}
                placeholder={tn("folderName")}
                disabled={pending}
                onSubmit={submitFolderName}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        );
      })}

      {editing?.kind === "newFolder" && editing.id === null ? (
        <InlineName initial="" indent={12} placeholder={tn("folderName")} disabled={pending} onSubmit={submitFolderName} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" onClick={() => setEditing({ kind: "newFolder", id: null })} style={{ paddingLeft: 12 }} className={`${ROW} text-ink-mute`}>
          <Plus size={16} aria-hidden className="shrink-0" />
          <span className="truncate">{tn("newFolder")}</span>
        </button>
      )}

      {/* Labels */}
      <SectionHeader
        title={tn("labels")}
        action={
          labelsAvailable ? (
            <button
              type="button"
              className="icon-btn h-10 w-10 lg:h-6 lg:w-6"
              aria-label={tn("newLabel")}
              title={tn("newLabel")}
              onClick={() => setEditing({ kind: "newLabel", id: null })}
            >
              <Plus size={14} aria-hidden />
            </button>
          ) : null
        }
      />
      {labels.map((l) => {
        const href = `/mail/label/${l.id}`;
        if (editing?.kind === "renameLabel" && editing.id === l.id)
          return (
            <InlineName key={l.id} initial={l.name} indent={12} placeholder={tn("labelName")} disabled={pending} onSubmit={submitFolderName} onCancel={() => setEditing(null)} />
          );
        return (
          <div key={l.id} className="group relative">
            <Link
              href={href}
              aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}
              style={{ paddingLeft: 16 }}
              className={`${ROW} max-lg:pr-11 text-ink-soft aria-[current=page]:font-medium`}
            >
              <LabelDot color={l.color} size={9} />
              <span className="flex-1 truncate pl-0.5">{l.name}</span>
            </Link>
            <LabelMenu
              label={l}
              disabled={pending}
              onRename={() => setEditing({ kind: "renameLabel", id: l.id })}
              onColor={(color) => run(() => updateLabel({ id: l.id, color }))}
              onDelete={() => run(() => deleteLabel({ id: l.id }), pathname.startsWith(href) ? () => router.push("/mail") : undefined)}
            />
          </div>
        );
      })}
      {editing?.kind === "newLabel" && (
        <InlineName initial="" indent={12} placeholder={tn("labelName")} disabled={pending} onSubmit={submitFolderName} onCancel={() => setEditing(null)} />
      )}
      {!labels.length && editing?.kind !== "newLabel" && (
        <p className="px-3 py-1 text-[12.5px] leading-snug text-ink-mute">{labelsAvailable ? tn("noLabels") : tn("labelsUnavailable")}</p>
      )}
    </>
  );

  /** Folders of another address: plain links that keep `?account` so the list and reader stay in it. */
  const otherFolders = ({ account, mailboxes: boxes }: AccountInbox) => {
    if (!boxes.length) return <p className="px-3 py-1 text-[12.5px] leading-snug text-ink-mute">{tn("sharedEmpty")}</p>;
    return mailboxTree(boxes).map(({ mailbox: m, depth }) => {
      const Icon = (m.role && ROLE_ICON[m.role]) || Folder;
      const active = viewing === account.id && isAt(m);
      const count = folderCount(m);
      return (
        <Link
          key={m.id}
          href={`/mail/${m.id}?account=${encodeURIComponent(account.id)}`}
          aria-current={active ? "page" : undefined}
          {...dropProps(m, viewing === account.id && !active && !account.isReadOnly)}
          style={{ paddingLeft: 12 + depth * 16 }}
          className={`${ROW} ${DROP_STYLE} ${rowTone(m)}`}
        >
          <Icon size={16} aria-hidden className="shrink-0" />
          <span className="flex-1 truncate">{folderLabel(m)}</span>
          {count > 0 && <span className="font-mono text-[12px] font-normal tabular-nums text-ink-mute">{count}</span>}
        </Link>
      );
    });
  };

  const inboxUnread = (boxes: Mailbox[]) => boxes.find((m) => m.role === "inbox")?.unreadEmails ?? 0;

  return (
    <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-2 pb-6" aria-label="Mailboxes">
      {others.length > 0 && (
        <Link
          href="/mail/unified"
          aria-current={pathname === "/mail/unified" ? "page" : undefined}
          style={{ paddingLeft: 12 }}
          className={`${ROW} mb-1.5 text-ink-soft aria-[current=page]:font-medium`}
        >
          <Mails size={16} aria-hidden className="shrink-0" />
          <span className="flex-1 truncate">{tn("unified")}</span>
        </Link>
      )}

      {own.account ? (
        <AccountSection
          account={own.account}
          unread={inboxUnread(own.mailboxes)}
          open={isOpen(own.account.id, true)}
          onToggle={() => toggleOpen(own.account!.id, true)}
        >
          {ownFolders}
        </AccountSection>
      ) : (
        ownFolders
      )}

      {others.map((s) => (
        <AccountSection
          key={s.account.id}
          account={s.account}
          unread={inboxUnread(s.mailboxes)}
          open={isOpen(s.account.id, viewing === s.account.id)}
          onToggle={() => toggleOpen(s.account.id, viewing === s.account.id)}
          separated
        >
          {otherFolders(s)}
        </AccountSection>
      ))}

      {stale.map((email) => (
        <section key={email} className="mt-2 border-t border-line pt-2">
          <div title={email} className="flex h-10 items-center gap-2.5 pr-2 pl-2 text-[13.5px] text-ink-mute lg:h-8">
            <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-[10.5px] font-semibold uppercase leading-none">
              {(email.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">{email}</span>
          </div>
          <a
            href={`/api/auth/login?add=1&keep=1&hint=${encodeURIComponent(email)}&returnTo=%2Fmail`}
            style={{ paddingLeft: 40 }}
            className={`${ROW} text-[12.5px] text-ink-soft underline-offset-2 hover:underline`}
          >
            {tn("signInAgain")}
          </a>
        </section>
      ))}

      <div className="mt-4 border-t border-line pt-3">
        {canAdd ? (
          <a href={ADD_MAILBOX_HREF} style={{ paddingLeft: 12 }} className={`${ROW} text-ink-mute`}>
            <Plus size={16} aria-hidden className="shrink-0" />
            <span className="truncate">{tn("addMailbox")}</span>
          </a>
        ) : (
          <span aria-disabled="true" style={{ paddingLeft: 12 }} className={`${ROW} cursor-not-allowed text-ink-mute opacity-60`}>
            <Plus size={16} aria-hidden className="shrink-0" />
            <span className="truncate">{tn("addMailbox")}</span>
          </span>
        )}
        <p className="pt-0.5 pr-3 pl-[40px] text-[12px] leading-snug text-ink-mute">{tn(canAdd ? "addMailboxHint" : "addMailboxLimit")}</p>
      </div>

      {error && (
        <p role="alert" className="mx-1 mt-2 rounded-md border border-line px-3 py-2 text-[12.5px] leading-snug text-danger">
          {error}
        </p>
      )}
    </nav>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mt-4 mb-0.5 flex h-10 lg:h-7 items-center justify-between pr-1 pl-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">{title}</span>
      {action}
    </div>
  );
}

/** One address in the sidebar: avatar, address and inbox unread; folders when expanded. */
function AccountSection({
  account,
  unread,
  open,
  onToggle,
  separated,
  children,
}: {
  account: MailAccount;
  unread: number;
  open: boolean;
  onToggle: () => void;
  separated?: boolean;
  children: React.ReactNode;
}) {
  const tn = useTranslations("mailActions.nav");
  const label = account.email || account.name;
  const at = label.indexOf("@");
  const own = account.kind === "own";
  return (
    <section className={separated ? "mt-2 border-t border-line pt-2" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={account.name && account.name !== label ? `${account.name} · ${label}` : label}
        className="flex h-10 w-full items-center gap-2.5 rounded-md pr-2 pl-2 text-left text-[13.5px] transition-colors duration-150 hover:bg-hover lg:h-8"
      >
        <span
          aria-hidden
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold uppercase leading-none ${
            own ? "bg-ink text-sheet" : "border border-line-strong text-ink-soft"
          }`}
        >
          {(label.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()}
        </span>
        {/* Same-name addresses differ only by domain: shorten the local part, never the domain. */}
        <span className="flex min-w-0 flex-1 font-medium text-ink">
          <span className="truncate">{at > 0 ? label.slice(0, at) : label}</span>
          {at > 0 && <span className="shrink-0">{label.slice(at)}</span>}
        </span>
        {(account.kind === "shared" || account.isReadOnly) && (
          <span title={tn(account.isReadOnly ? "readOnlyTag" : "sharedTag")} className="shrink-0 text-ink-mute">
            <Users size={13} aria-hidden />
            <span className="sr-only">{tn(account.isReadOnly ? "readOnlyTag" : "sharedTag")}</span>
          </span>
        )}
        {unread > 0 && <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-mute">{unread}</span>}
        <ChevronRight
          size={14}
          aria-hidden
          className={`shrink-0 text-ink-mute transition-transform duration-200 ease-[var(--ease-out-soft)] ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>}
    </section>
  );
}

function InlineName({
  initial,
  indent,
  placeholder,
  disabled,
  onSubmit,
  onCancel,
}: {
  initial: string;
  indent: number;
  placeholder: string;
  disabled: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="py-0.5 pr-1"
      style={{ paddingLeft: indent - 4 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && value.trim() !== initial) onSubmit(value.trim());
        else onCancel();
      }}
    >
      <input
        autoFocus
        value={value}
        maxLength={100}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onBlur={() => !disabled && onCancel()}
        className={FIELD}
      />
    </form>
  );
}

function MoreButton({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`icon-btn absolute top-1/2 right-1 h-10 w-10 -translate-y-1/2 lg:h-7 lg:w-7 lg:bg-hover ${
        open ? "flex" : "flex lg:hidden lg:group-focus-within:flex lg:group-hover:flex"
      }`}
    >
      <Ellipsis size={15} aria-hidden />
    </button>
  );
}

function FolderMenu({
  name,
  system,
  parents,
  canMoveToTop,
  disabled,
  onRename,
  onNewSubfolder,
  onMove,
  onDelete,
}: {
  name: string;
  system: boolean;
  parents: { id: string; label: string; depth: number }[];
  canMoveToTop: boolean;
  disabled: boolean;
  onRename: () => void;
  onNewSubfolder: () => void;
  onMove: (parentId: string | null) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("mailActions.nav");
  const { open, toggle, setOpen, ref } = usePopover();
  const [mode, setMode] = useState<"menu" | "move" | "confirm">("menu");
  useEffect(() => {
    if (!open) setMode("menu");
  }, [open]);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref}>
      <MoreButton open={open} label={t("folderOptions", { name })} onClick={toggle} />
      {open && (
        <div role="menu" className="pop absolute top-8 right-0 z-50 w-56 p-1.5 max-lg:top-10" style={{ transformOrigin: "top right" }}>
          {mode === "menu" && (
            <>
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={pick(onNewSubfolder)}>
                {t("newSubfolder")}
              </button>
              {!system && (
                <>
                  <button type="button" role="menuitem" className={MENU_ITEM} onClick={pick(onRename)}>
                    {t("rename")}
                  </button>
                  <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setMode("move")}>
                    {t("moveFolder")}
                  </button>
                  <hr className="my-1 border-line" />
                  <button type="button" role="menuitem" className={`${MENU_ITEM} text-danger hover:text-danger`} onClick={() => setMode("confirm")}>
                    {t("deleteFolder")}
                  </button>
                </>
              )}
            </>
          )}
          {mode === "move" && (
            <div className="max-h-72 overflow-y-auto">
              <p className="px-3 pt-1 pb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">{t("moveInto")}</p>
              {canMoveToTop && (
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={pick(() => onMove(null))}>
                  {t("topLevel")}
                </button>
              )}
              {parents.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  style={{ paddingLeft: 12 + p.depth * 12 }}
                  onClick={pick(() => onMove(p.id))}
                >
                  <span className="truncate">{p.label}</span>
                </button>
              ))}
            </div>
          )}
          {mode === "confirm" && (
            <div className="p-2 text-[13px] leading-snug text-ink-soft">
              <p>{t("confirmDeleteFolder", { name })}</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="h-8 rounded-md px-3 text-[13px] hover:bg-hover" onClick={() => setOpen(false)}>
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  className="h-8 rounded-md bg-danger px-3 text-[13px] font-medium text-white disabled:opacity-60"
                  onClick={pick(onDelete)}
                >
                  {t("delete")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LabelMenu({
  label,
  disabled,
  onRename,
  onColor,
  onDelete,
}: {
  label: Label;
  disabled: boolean;
  onRename: () => void;
  onColor: (c: LabelColor) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("mailActions.nav");
  const { open, toggle, setOpen, ref } = usePopover();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!open) setConfirm(false);
  }, [open]);

  return (
    <div ref={ref}>
      <MoreButton open={open} label={t("labelOptions", { name: label.name })} onClick={toggle} />
      {open && (
        <div role="menu" className="pop absolute top-8 right-0 z-50 w-56 p-1.5 max-lg:top-10" style={{ transformOrigin: "top right" }}>
          {confirm ? (
            <div className="p-2 text-[13px] leading-snug text-ink-soft">
              <p>{t("confirmDeleteLabel", { name: label.name })}</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="h-8 rounded-md px-3 text-[13px] hover:bg-hover" onClick={() => setOpen(false)}>
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  className="h-8 rounded-md bg-danger px-3 text-[13px] font-medium text-white disabled:opacity-60"
                  onClick={() => {
                    setOpen(false);
                    onDelete();
                  }}
                >
                  {t("delete")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="px-3 pt-1 pb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">{t("color")}</p>
              <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                {LABEL_COLOR_NAMES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={t(`colors.${c}`)}
                    title={t(`colors.${c}`)}
                    aria-pressed={label.color === c}
                    onClick={() => {
                      setOpen(false);
                      onColor(c);
                    }}
                    className="grid h-6 w-6 place-items-center rounded-full ring-offset-2 ring-offset-sheet aria-pressed:ring-2 aria-pressed:ring-ink"
                    style={{ background: LABEL_COLORS[c] }}
                  />
                ))}
              </div>
              <hr className="my-1 border-line" />
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  onRename();
                }}
              >
                {t("rename")}
              </button>
              <button type="button" role="menuitem" className={`${MENU_ITEM} text-danger hover:text-danger`} onClick={() => setConfirm(true)}>
                {t("deleteLabel")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
