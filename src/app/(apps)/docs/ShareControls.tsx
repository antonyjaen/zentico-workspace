"use client";

// Access controls for the editor top bars: "Only you" / "Shared with N" chip, View only badge,
// the Share button and the Drive share dialog (with Copy link) for the open file.
import { Eye, Lock, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import type { SharingData } from "../drive/actions";
import { ShareDialog } from "../drive/ShareDialog";
import type { DocAccess } from "./shared";

export function useDocShare(access: DocAccess | null | undefined) {
  const [count, setCount] = useState<number | null>(access?.sharedWith ?? null);
  const [open, setOpen] = useState(false);
  const onLoaded = useCallback((d: SharingData) => setCount(d.supported ? d.grants.length : null), []);
  return { access: access ?? null, count, open, setOpen, onLoaded };
}

type Share = ReturnType<typeof useDocShare>;

/** "Read only" badge; says "View only" when the viewer lacks edit rights on the file. */
export function ReadOnlyBadge({ share }: { share: Share }) {
  const t = useTranslations("docs");
  const viewOnly = share.access?.canEdit === false;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-mute"
      title={viewOnly ? t("share.viewOnlyHint") : undefined}
    >
      {viewOnly && <Eye size={12} aria-hidden />}
      {viewOnly ? t("share.viewOnly") : t("readOnly")}
    </span>
  );
}

/** "Only you" / "Shared with N"; opens the Share dialog when the viewer may share. */
export function AccessChip({ share }: { share: Share }) {
  const t = useTranslations("docs");
  if (share.count == null) return null;
  const Icon = share.count ? Users : Lock;
  const label = share.count ? t("share.sharedWith", { count: share.count }) : t("share.onlyYou");
  const cls = "hidden h-6 shrink-0 items-center gap-1 rounded-full bg-hover px-2 text-[11.5px] text-ink-mute md:inline-flex";
  if (!share.access?.canShare) {
    return (
      <span className={cls}>
        <Icon size={12} aria-hidden />
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => share.setOpen(true)}
      className={`${cls} transition-colors hover:text-ink`}
      title={t("share.manage")}
    >
      <Icon size={12} aria-hidden />
      {label}
    </button>
  );
}

export function ShareButton({ share }: { share: Share }) {
  const t = useTranslations("docs");
  if (!share.access?.canShare) return null;
  return (
    <button
      type="button"
      onClick={() => share.setOpen(true)}
      aria-haspopup="dialog"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-ink transition-colors hover:bg-primary-hover"
      title={t("share.manage")}
    >
      <Users size={15} aria-hidden />
      <span className="hidden sm:inline">{t("share.button")}</span>
    </button>
  );
}

/** The Drive share dialog for the open document, with "Copy link" to this editor. */
export function DocShareDialog({ share, file }: { share: Share; file: { id: string; name: string } }) {
  const path = usePathname();
  // Stable: the dialog reloads its data whenever onClose changes identity.
  const { setOpen } = share;
  const close = useCallback(() => setOpen(false), [setOpen]);
  if (!share.open) return null;
  return (
    <ShareDialog
      item={{ id: file.id, accountId: null, name: file.name, isFolder: false, type: "" }}
      onClose={close}
      onChanged={() => {}}
      onLoaded={share.onLoaded}
      link={path}
    />
  );
}
