"use client";

import {
  Archive,
  ChevronDown,
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

export type SharedInbox = { account: MailAccount; mailboxes: Mailbox[] };

export function MailboxNav({
  mailboxes,
  labels,
  labelsAvailable,
  shared,
}: {
  mailboxes: Mailbox[];
  labels: Label[];
  /** False when the server has no Sieve (label definitions are stored in the filter script). */
  labelsAvailable: boolean;
  shared: SharedInbox[];
}) {
  const t = useTranslations("mail.folders");
  const tn = useTranslations("mailActions.nav");
  const pathname = usePathname();
  const account = useSearchParams().get("account");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline editors: renaming a folder/label, or creating a folder (under a parent or at the top).
  const [editing, setEditing] = useState<{ kind: "rename" | "newFolder" | "renameLabel" | "newLabel"; id: string | null } | null>(null);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error]);

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

  const tree = mailboxTree(mailboxes);
  const descendants = (id: string) => {
    const out = new Set<string>([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of mailboxes) if (m.parentId && out.has(m.parentId) && !out.has(m.id)) out.add(m.id), (grew = true);
    }
    return out;
  };

  return (
    <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-2 pb-6" aria-label="Mailboxes">
      {shared.length > 0 && (
        <Link
          href="/mail/unified"
          aria-current={pathname === "/mail/unified" ? "page" : undefined}
          style={{ paddingLeft: 12 }}
          className={`${ROW} text-ink-soft aria-[current=page]:font-medium`}
        >
          <Mails size={16} aria-hidden className="shrink-0" />
          <span className="flex-1 truncate">{tn("unified")}</span>
        </Link>
      )}

      {tree.map(({ mailbox: m, depth }) => {
        const Icon = (m.role && ROLE_ICON[m.role]) || Folder;
        const href = `/mail/${m.id}`;
        const active = !account && (pathname === href || pathname.startsWith(`${href}/`));
        const count = m.role === "drafts" ? m.totalEmails : m.role === "trash" || m.role === "junk" ? 0 : m.unreadEmails;
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
                  data-drop={dropTarget === m.id || undefined}
                  onDragOver={(e) => {
                    if (active || !e.dataTransfer.types.includes(DRAG_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropTarget(m.id);
                  }}
                  onDragLeave={() => setDropTarget((d) => (d === m.id ? null : d))}
                  onDrop={(e) => {
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
                  }}
                  style={{ paddingLeft: 12 + depth * 16 }}
                  className={`${ROW} max-lg:pr-11 data-[drop]:bg-hover data-[drop]:text-ink data-[drop]:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
                    m.unreadEmails > 0 && count > 0 ? "font-medium text-ink" : "text-ink-soft aria-[current=page]:font-medium"
                  }`}
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

      {/* Shared inboxes */}
      <SectionHeader title={tn("shared")} />
      {shared.length === 0 ? (
        <p className="px-3 py-1 text-[12.5px] leading-snug text-ink-mute">{tn("noShared")}</p>
      ) : (
        shared.map((s) => <SharedAccount key={s.account.id} shared={s} activeAccount={account} pathname={pathname} folderLabel={folderLabel} />)
      )}

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

/** One shared account: collapsible, inbox first, with the same folder tree. */
function SharedAccount({
  shared: { account, mailboxes },
  activeAccount,
  pathname,
  folderLabel,
}: {
  shared: SharedInbox;
  activeAccount: string | null;
  pathname: string;
  folderLabel: (m: Mailbox) => string;
}) {
  const tn = useTranslations("mailActions.nav");
  const [open, setOpen] = useState(activeAccount === account.id);
  const inbox = mailboxes.find((m) => m.role === "inbox");
  const hrefOf = (m: Mailbox) => `/mail/${m.id}?account=${encodeURIComponent(account.id)}`;
  const isActive = (m: Mailbox) => activeAccount === account.id && (pathname === `/mail/${m.id}` || pathname.startsWith(`/mail/${m.id}/`));
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <div className="flex items-center">
        <button
          type="button"
          className="icon-btn h-10 w-8 shrink-0 lg:h-8 lg:w-6"
          aria-expanded={open}
          aria-label={open ? tn("collapse") : tn("expand")}
          onClick={() => setOpen((o) => !o)}
        >
          <Chevron size={14} aria-hidden />
        </button>
        <Link
          href={inbox ? hrefOf(inbox) : "#"}
          aria-current={inbox && isActive(inbox) ? "page" : undefined}
          title={account.name}
          className={`${ROW} min-w-0 flex-1 pl-1.5 ${inbox && inbox.unreadEmails > 0 ? "font-medium text-ink" : "text-ink-soft"}`}
        >
          <Users size={16} aria-hidden className="shrink-0" />
          <span className="flex-1 truncate">{account.name}</span>
          {inbox && inbox.unreadEmails > 0 && (
            <span className="font-mono text-[12px] font-normal tabular-nums text-ink-mute">{inbox.unreadEmails}</span>
          )}
        </Link>
      </div>
      {open &&
        mailboxTree(mailboxes).map(({ mailbox: m, depth }) => {
          const Icon = (m.role && ROLE_ICON[m.role]) || Folder;
          return (
            <Link
              key={m.id}
              href={hrefOf(m)}
              aria-current={isActive(m) ? "page" : undefined}
              style={{ paddingLeft: 30 + depth * 14 }}
              className={`${ROW.replace("lg:h-8", "lg:h-7")} text-[13.5px] text-ink-soft aria-[current=page]:font-medium`}
            >
              <Icon size={14} aria-hidden className="shrink-0" />
              <span className="flex-1 truncate">{folderLabel(m)}</span>
              {m.unreadEmails > 0 && m.role !== "trash" && m.role !== "junk" && (
                <span className="font-mono text-[11.5px] tabular-nums text-ink-mute">{m.unreadEmails}</span>
              )}
            </Link>
          );
        })}
      {open && !mailboxes.length && <p className="py-1 pl-8 text-[12.5px] text-ink-mute">{tn("sharedEmpty")}</p>}
    </div>
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
