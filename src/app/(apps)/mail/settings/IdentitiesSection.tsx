"use client";

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Identity } from "@/lib/mail-settings";
import { deleteIdentity, saveIdentity, type ActionResult } from "./actions";
import { RichEditor } from "./RichEditor";
import { Field, Status, inputCls, primaryBtn, secondaryBtn, textareaCls } from "./ui";

export function IdentitiesSection({ identities }: { identities: Identity[] }) {
  const t = useTranslations("mailSettings.identities");
  const [open, setOpen] = useState<string | null>(identities[0]?.id ?? null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {identities.length === 0 && <li className="px-4 py-6 text-[14px] text-ink-mute">{t("none")}</li>}
        {identities.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              aria-expanded={open === i.id}
              onClick={() => setOpen(open === i.id ? null : i.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">{i.name || i.email}</span>
                <span className="block truncate font-mono text-[12px] text-ink-mute">{i.email}</span>
              </span>
              <ChevronDown
                size={16}
                aria-hidden
                className={`shrink-0 text-ink-mute transition-transform ${open === i.id ? "rotate-180" : ""}`}
              />
            </button>
            {open === i.id && (
              <div className="border-t border-line bg-sheet-muted/50 px-4 py-5">
                <IdentityForm identity={i} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="rounded-lg border border-line p-4">
          <h3 className="mb-4 text-[14px] font-medium text-ink">{t("addTitle")}</h3>
          <IdentityForm onDone={() => setAdding(false)} />
        </div>
      ) : (
        <button type="button" className={secondaryBtn} onClick={() => setAdding(true)}>
          <Plus size={15} aria-hidden />
          {t("add")}
        </button>
      )}
    </div>
  );
}

function IdentityForm({ identity, onDone }: { identity?: Identity; onDone?: () => void }) {
  const t = useTranslations("mailSettings.identities");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState(identity?.name ?? "");
  const [replyTo, setReplyTo] = useState(identity?.replyTo?.[0]?.email ?? "");
  const [textSignature, setTextSignature] = useState(identity?.textSignature ?? "");
  const [htmlSignature, setHtmlSignature] = useState(identity?.htmlSignature ?? "");
  // Mirror the rich signature into the plain-text one until the user edits it separately.
  const [textTouched, setTextTouched] = useState(Boolean(identity?.textSignature));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveIdentity({ id: identity?.id, email, name, replyTo, textSignature, htmlSignature });
      setResult(r);
      if (r.ok) {
        router.refresh();
        onDone?.();
      }
    });
  };

  const remove = () => {
    if (!identity || !window.confirm(t("confirmDelete", { email: identity.email }))) return;
    start(async () => {
      const r = await deleteIdentity(identity.id);
      setResult(r);
      if (r.ok) router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {!identity && (
        <Field label={t("email")} hint={t("emailHint")}>
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
            autoComplete="off"
          />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("name")}>
          <input maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </Field>
        <Field label={t("replyTo")} hint={t("replyToHint")}>
          <input
            type="email"
            maxLength={254}
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
      <div>
        <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">{t("htmlSignature")}</span>
        <RichEditor
          label={t("htmlSignature")}
          initialHtml={htmlSignature}
          onChange={(html, plain) => {
            setHtmlSignature(html);
            if (!textTouched) setTextSignature(plain);
          }}
        />
      </div>
      <Field label={t("textSignature")} hint={t("textSignatureHint")}>
        <textarea
          rows={3}
          maxLength={5000}
          value={textSignature}
          onChange={(e) => {
            setTextTouched(true);
            setTextSignature(e.target.value);
          }}
          className={textareaCls}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn}>
          {identity ? t("save") : t("create")}
        </button>
        {onDone && (
          <button type="button" className={secondaryBtn} onClick={onDone}>
            {t("cancel")}
          </button>
        )}
        {identity?.mayDelete && (
          <button
            type="button"
            disabled={pending}
            onClick={remove}
            className={`${secondaryBtn} text-danger hover:text-danger`}
          >
            <Trash2 size={14} aria-hidden />
            {t("delete")}
          </button>
        )}
        <Status result={result} />
      </div>
    </form>
  );
}
