"use client";

import { Plus, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useRef, useState } from "react";
import { createGroup, importVcf } from "./actions";

/** Inline "New group" field under the group list. */
export function NewGroup() {
  const t = useTranslations("contacts");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(createGroup, undefined);

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex h-8 items-center gap-3 rounded-md px-3 text-left text-[14px] text-ink-mute transition-colors hover:bg-hover hover:text-ink"
      >
        <Plus size={16} aria-hidden className="shrink-0" />
        {t("newGroup")}
      </button>
    );

  return (
    <form action={action} className="mt-1 px-1">
      <input
        name="name"
        autoFocus
        required
        maxLength={120}
        placeholder={t("groupName")}
        aria-label={t("groupName")}
        disabled={pending}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="h-8 w-full rounded-md border border-line bg-sheet px-2.5 text-[13.5px] text-ink placeholder:text-ink-mute focus:border-line-strong focus:outline-none"
      />
      {state?.error && <p className="mt-1 px-1 text-[12px] text-danger">{t(`errors.${state.error === "empty" ? "groupEmpty" : "failed"}`)}</p>}
    </form>
  );
}

/** "Import vCard": picking a .vcf file submits it straight away. */
export function ImportVcf() {
  const t = useTranslations("contacts");
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(importVcf, undefined);
  const errorKey = state?.error && ["noFile", "tooLarge", "noCards"].includes(state.error) ? state.error : "failed";

  return (
    <form ref={form} action={action}>
      <label
        aria-disabled={pending}
        className="flex h-8 cursor-pointer items-center gap-3 rounded-md px-3 text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-60"
      >
        <Upload size={16} aria-hidden className="shrink-0" />
        {pending ? t("importing") : t("import")}
        <input
          type="file"
          name="file"
          accept=".vcf,text/vcard,text/x-vcard"
          className="sr-only"
          onChange={(e) => e.currentTarget.files?.length && form.current?.requestSubmit()}
        />
      </label>
      {state?.ok && <p className="px-3 pb-1 text-[12px] text-ink-mute">{t("imported", { count: Number(state.ok) })}</p>}
      {state?.error && <p className="px-3 pb-1 text-[12px] text-danger">{t(`errors.${errorKey}`)}</p>}
    </form>
  );
}
