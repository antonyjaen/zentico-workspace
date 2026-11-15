"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { saveContact, type FormState } from "./actions";
import type { AddressBook, Contact, EmailLabel, PhoneLabel } from "@/lib/contacts";

const INPUT =
  "h-9 w-full rounded-md border border-line bg-sheet px-3 text-[14px] text-ink placeholder:text-ink-mute transition-colors hover:border-line-strong focus:border-line-strong focus:outline-none";
const SELECT = `${INPUT.replace("w-full", "w-auto")} shrink-0 pr-2`;
const LEGEND = "mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute";

type Row<L> = { key: number; label: L; value: string };
let seq = 0;
const rows = <L,>(list: { label: L; value: string }[], fallback: L): Row<L>[] =>
  (list.length ? list : [{ label: fallback, value: "" }]).map((r) => ({ ...r, key: ++seq }));

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[12.5px] text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function MultiRows<L extends string>({
  name,
  type,
  labels,
  initial,
  fallback,
  placeholder,
  addText,
}: {
  name: "email" | "phone";
  type: string;
  labels: { value: L; text: string }[];
  initial: { label: L; value: string }[];
  fallback: L;
  placeholder: string;
  addText: string;
}) {
  const t = useTranslations("contacts");
  const [list, setList] = useState(() => rows(initial, fallback));
  return (
    <div className="space-y-2">
      {list.map((r) => (
        <div key={r.key} className="flex gap-2">
          <input
            name={`${name}Value`}
            type={type}
            defaultValue={r.value}
            placeholder={placeholder}
            maxLength={name === "email" ? 254 : 50}
            aria-label={placeholder}
            className={INPUT}
          />
          <select name={`${name}Label`} defaultValue={r.label} aria-label={t("label")} className={SELECT}>
            {labels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.text}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-btn h-9 w-9 shrink-0"
            aria-label={t("remove")}
            onClick={() => setList((xs) => (xs.length > 1 ? xs.filter((x) => x.key !== r.key) : rows([], fallback)))}
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      ))}
      {list.length < 10 && (
        <button
          type="button"
          onClick={() => setList((xs) => [...xs, ...rows([], fallback)])}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus size={14} aria-hidden />
          {addText}
        </button>
      )}
    </div>
  );
}

export function ContactForm({
  books,
  defaultBookId,
  contact,
  draft,
  backHref,
  onCancel,
  saveAction,
  onSaved,
}: {
  books: AddressBook[];
  defaultBookId: string;
  contact?: Contact;
  /** Prefilled values for a new contact (e.g. "Add to contacts" from Chat → People). */
  draft?: Pick<Contact, "given" | "surname" | "emails">;
  backHref?: string;
  /** Used instead of the back link when the form is embedded (Chat). */
  onCancel?: () => void;
  /** Alternative save action that returns `{ ok: id }` instead of redirecting. */
  saveAction?: (prev: FormState, fd: FormData) => Promise<FormState>;
  onSaved?: (id: string) => void;
}) {
  const t = useTranslations("contacts");
  const [state, action, pending] = useActionState(saveAction ?? saveContact, undefined);
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  useEffect(() => {
    if (state?.ok) savedRef.current?.(state.ok);
  }, [state]);
  const src: Partial<Contact> | undefined = contact ?? draft;
  const a = contact?.address;
  const emailLabels: { value: EmailLabel; text: string }[] = (["work", "home", "other"] as const).map((v) => ({
    value: v,
    text: t(`labels.${v}`),
  }));
  const phoneLabels: { value: PhoneLabel; text: string }[] = (["mobile", "work", "home", "other"] as const).map(
    (v) => ({ value: v, text: t(`labels.${v}`) }),
  );
  const errorText = state?.error
    ? state.error === "empty"
      ? t("errors.empty")
      : state.error.startsWith("invalid:")
        ? t("errors.invalid", { field: state.error.slice(8) })
        : t("errors.failed")
    : null;

  return (
    <form action={action} className="flex min-h-0 flex-1 flex-col">
      {contact && <input type="hidden" name="id" value={contact.id} />}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="flex-1 truncate text-[14px] font-medium text-ink">
          {contact ? t("editTitle") : t("newTitle")}
        </h2>
        {onCancel || !backHref ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 items-center rounded-md px-3 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
          >
            {t("cancel")}
          </button>
        ) : (
          <Link
            href={backHref}
            className="inline-flex h-8 items-center rounded-md px-3 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
          >
            {t("cancel")}
          </Link>
        )}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? t("saving") : t("save")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] space-y-7 px-6 py-7">
          {errorText && (
            <p role="alert" className="rounded-md border border-danger/40 px-3 py-2 text-[13.5px] text-danger">
              {errorText}
            </p>
          )}

          <fieldset>
            <legend className={LEGEND}>{t("name")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("given")}>
                <input name="given" defaultValue={src?.given} maxLength={200} autoFocus className={INPUT} />
              </Field>
              <Field label={t("surname")}>
                <input name="surname" defaultValue={src?.surname} maxLength={200} className={INPUT} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className={LEGEND}>{t("emails")}</legend>
            <MultiRows
              name="email"
              type="email"
              labels={emailLabels}
              initial={src?.emails ?? []}
              fallback="work"
              placeholder={t("emailPlaceholder")}
              addText={t("addEmail")}
            />
          </fieldset>

          <fieldset>
            <legend className={LEGEND}>{t("phones")}</legend>
            <MultiRows
              name="phone"
              type="tel"
              labels={phoneLabels}
              initial={contact?.phones ?? []}
              fallback="mobile"
              placeholder={t("phonePlaceholder")}
              addText={t("addPhone")}
            />
          </fieldset>

          <fieldset>
            <legend className={LEGEND}>{t("work")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("company")}>
                <input name="company" defaultValue={contact?.company} maxLength={200} className={INPUT} />
              </Field>
              <Field label={t("jobTitle")}>
                <input name="title" defaultValue={contact?.title} maxLength={200} className={INPUT} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className={LEGEND}>{t("address")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("street")} className="sm:col-span-2">
                <input name="street" defaultValue={a?.street} maxLength={300} className={INPUT} />
              </Field>
              <Field label={t("locality")}>
                <input name="locality" defaultValue={a?.locality} maxLength={200} className={INPUT} />
              </Field>
              <Field label={t("region")}>
                <input name="region" defaultValue={a?.region} maxLength={200} className={INPUT} />
              </Field>
              <Field label={t("postcode")}>
                <input name="postcode" defaultValue={a?.postcode} maxLength={40} className={INPUT} />
              </Field>
              <Field label={t("country")}>
                <input name="country" defaultValue={a?.country} maxLength={200} className={INPUT} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className={LEGEND}>{t("more")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("birthday")}>
                <input
                  name="birthday"
                  type="date"
                  defaultValue={/^\d{4}-\d{2}-\d{2}$/.test(contact?.birthday ?? "") ? contact!.birthday : undefined}
                  className={INPUT}
                />
              </Field>
              <Field label={t("addressBook")}>
                <select name="addressBookId" defaultValue={defaultBookId} className={`${INPUT} pr-2`}>
                  {books.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name || t("defaultBook")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("notes")} className="sm:col-span-2">
                <textarea
                  name="notes"
                  defaultValue={contact?.notes}
                  maxLength={5000}
                  rows={4}
                  className={`${INPUT} h-auto resize-y py-2 leading-relaxed`}
                />
              </Field>
            </div>
          </fieldset>
        </div>
      </div>
    </form>
  );
}
