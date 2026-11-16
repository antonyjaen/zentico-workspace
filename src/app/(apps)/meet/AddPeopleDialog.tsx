"use client";

import { Check, Link2, Loader2, Mail, MessageSquare, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Person } from "../chat/shared";
import { Avatar, BTN, BTN_PRIMARY, Label, Modal, PeoplePicker, usePeople } from "../chat/ui";
import { getInviteContext, inviteToMeeting, type InviteOutcome } from "./invite-actions";
import { meetHref } from "./shared";

const MAX_INVITEES = 50;

/** Meet-style "Add people": pick people from the directory (or type any address) and invite them. */
export function AddPeopleDialog({ roomName, onClose }: { roomName: string; onClose: () => void }) {
  const t = useTranslations("meet");
  const people = usePeople();
  const [picked, setPicked] = useState<Person[]>([]);
  const [conversation, setConversation] = useState<string | null>(null);
  const [addToConv, setAddToConv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ list: InviteOutcome[]; names: Map<string, string>; conv: "ok" | "failed" | null } | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void getInviteContext(roomName)
      .then((r) => live && r.ok && setConversation(r.data.conversation))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [roomName]);

  const errorText = (code: string) => (t.has(`inviteErrors.${code}`) ? t(`inviteErrors.${code}` as "inviteErrors.failed") : t("inviteErrors.failed"));

  const send = async () => {
    if (busy || picked.length === 0) return;
    if (picked.length > MAX_INVITEES) return setError(errorText("tooMany"));
    setBusy(true);
    setError(null);
    try {
      const r = await inviteToMeeting(roomName, picked, addToConv);
      if (!r.ok) setError(errorText(r.error));
      else {
        setResults({ list: r.data.results, names: new Map(picked.map((p) => [p.email.toLowerCase(), p.name])), conv: r.data.conversation });
        // Keep only the people whose invite failed, ready to retry.
        const failed = new Set(r.data.results.filter((x) => x.status === "failed").map((x) => x.email));
        setPicked((cur) => cur.filter((p) => failed.has(p.email.toLowerCase())));
      }
    } catch {
      setError(errorText("failed"));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${meetHref(roomName)}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal
      title={t("addPeople")}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={copyLink} className={`${BTN} mr-auto`}>
            {copied ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
            {copied ? t("linkCopiedShort") : t("copyMeetingLink")}
          </button>
          <button type="button" onClick={onClose} className={BTN}>
            {results ? t("done") : t("cancel")}
          </button>
          <button type="button" onClick={send} disabled={busy || picked.length === 0} className={BTN_PRIMARY}>
            {busy && <Loader2 size={14} aria-hidden className="animate-spin" />}
            {t("sendInvites", { count: picked.length })}
          </button>
        </>
      }
    >
      <Label>{t("invitePeopleLabel")}</Label>
      <PeoplePicker value={picked} onChange={setPicked} people={people} allowFree autoFocus placeholder={t("invitePlaceholder")} />
      <p className="mt-2 text-[12px] leading-relaxed text-ink-mute">{t("inviteHint")}</p>
      {conversation && (
        <label className="mt-3 flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-app-meet)]"
            checked={addToConv}
            onChange={(e) => setAddToConv(e.target.checked)}
          />
          <span className="text-[13px] leading-snug text-ink-soft">{t("inviteAddToConversation", { name: conversation })}</span>
        </label>
      )}
      {copied === false && <p className="mt-3 text-[12.5px] text-danger">{t("copyFailed")}</p>}
      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {results && (
        <div className="mt-4" aria-live="polite">
          <p className="mb-1.5 text-[12.5px] font-medium text-ink-soft">{t("inviteResults")}</p>
          {results.list.length === 0 ? (
            <p className="text-[12.5px] text-ink-mute">{t("inviteNobody")}</p>
          ) : (
            <ul className="space-y-1">
              {results.list.map((r) => {
                const name = results.names.get(r.email) || r.email;
                return (
                  <li key={r.email} className="flex items-center gap-2.5 py-1">
                    <Avatar name={name} email={r.email} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{name}</span>
                      {name !== r.email && <span className="block truncate text-[11.5px] text-ink-mute">{r.email}</span>}
                    </span>
                    <span className={`flex shrink-0 items-center gap-1 text-[12px] ${r.status === "failed" ? "text-danger" : "text-ink-soft"}`}>
                      {r.status === "chat" ? (
                        <MessageSquare size={13} aria-hidden />
                      ) : r.status === "email" ? (
                        <Mail size={13} aria-hidden />
                      ) : (
                        <X size={13} aria-hidden />
                      )}
                      {t(`inviteStatus_${r.status}`)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {results.conv && (
            <p className={`mt-2 text-[12.5px] ${results.conv === "ok" ? "text-ink-soft" : "text-danger"}`}>
              {results.conv === "ok" ? t("inviteConversationOk") : t("inviteConversationFailed")}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
