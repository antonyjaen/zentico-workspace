"use client";

// Apps & webhooks of a conversation: the apps in it (add / remove), and its incoming webhooks
// (create, show the secret URL once, regenerate, delete). Any member who can post may manage them.
import { Check, Copy, Plus, RefreshCw, Trash2, Webhook, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { addApps, createWebhook, deleteWebhook, listWebhooks, regenerateWebhook, removeApp, type WebhookView } from "./app-actions";
import { PanelHeader } from "./Panels";
import { NAME_MAX, type ConversationDetail } from "./shared";
import { AppBadge, Avatar, BTN, BTN_PRIMARY, FIELD, Label, useApps, useErrorText, useUserName } from "./ui";

export function AppsPanel({
  conversation,
  onClose,
  onChanged,
}: {
  conversation: ConversationDetail;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("apps");
  const errorText = useErrorText();
  const userName = useUserName();
  const usable = useApps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inConversation = conversation.members.filter((m) => m.bot);
  const available = usable?.filter((u) => !conversation.members.some((m) => m.id === u.id)) ?? null;

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(errorText(r.error ?? "failed"));
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelHeader title={t("panelTitle")} sub={conversation.kind === "channel" ? `#${conversation.name}` : conversation.name} onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}

        <section>
          <h4 className="mb-1.5 px-1 text-[12px] font-medium text-ink-soft">{t("inThisConversation")}</h4>
          {inConversation.length === 0 ? (
            <p className="px-1 text-[12.5px] text-ink-mute">{t("noAppsHere")}</p>
          ) : (
            <ul className="space-y-0.5">
              {inConversation.map((u) => (
                <li key={u.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                  <Avatar name={u.name} email={u.email} bot={u.bot} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] text-ink">{userName(u)}</span>
                      {u.bot && <AppBadge bot={u.bot} />}
                    </span>
                    <span className="block truncate text-[12px] text-ink-mute">@{u.email.split("@")[0]}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (await run(() => removeApp(conversation.id, u.id))) await onChanged();
                    }}
                    className="icon-btn h-7 w-7 hover:text-danger"
                    aria-label={t("remove", { name: userName(u) })}
                    title={t("remove", { name: userName(u) })}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 className="mb-1.5 px-1 text-[12px] font-medium text-ink-soft">{t("addApp")}</h4>
          {available === null ? (
            <p className="px-1 text-[12.5px] text-ink-mute">{t("loading")}</p>
          ) : available.length === 0 ? (
            <p className="px-1 text-[12.5px] text-ink-mute">{t("noMoreApps")}</p>
          ) : (
            <ul className="space-y-0.5">
              {available.map((u) => (
                <li key={u.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                  <Avatar name={u.name} email={u.email} bot={u.bot} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-ink">{userName(u)}</span>
                    <span className="block truncate text-[12px] text-ink-mute">
                      {u.bot?.kind === "claude"
                        ? t("claudeOnlyYou")
                        : u.bot?.kind === "builtin" && u.bot.app === "github"
                          ? t("builtinGithub")
                          : u.bot?.description || `@${u.email.split("@")[0]}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (await run(() => addApps(conversation.id, [u.id]))) await onChanged();
                    }}
                    className={BTN}
                  >
                    <Plus size={14} aria-hidden />
                    {t("add")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 px-1 text-[12px] text-ink-mute">
            {t.rich("manageAppsHint", {
              link: (chunks) => (
                <Link href="/settings/apps" className="text-accent hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </section>

        <Webhooks conversationId={conversation.id} />
      </div>
    </>
  );
}

function Webhooks({ conversationId }: { conversationId: string }) {
  const t = useTranslations("apps");
  const errorText = useErrorText();
  const [list, setList] = useState<WebhookView[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [secretUrl, setSecretUrl] = useState<{ id: string; url: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: "regenerate" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const r = await listWebhooks(conversationId);
    if (r.ok) setList(r.data);
    else setError(errorText(r.error));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const run = async <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) {
        setError(errorText(r.error));
        return null;
      }
      return r.data;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <Webhook size={14} className="text-ink-mute" aria-hidden />
        <h4 className="flex-1 text-[12px] font-medium text-ink-soft">{t("webhooks")}</h4>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} className="text-[12.5px] font-medium text-accent hover:underline">
            {t("newWebhook")}
          </button>
        )}
      </div>
      <p className="mb-2 px-1 text-[12px] leading-relaxed text-ink-mute">{t("webhooksHint")}</p>
      {error && <p className="mb-2 px-1 text-[12.5px] text-danger">{error}</p>}

      {creating && (
        <form
          className="mb-2 space-y-2.5 rounded-lg border border-line p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => createWebhook(conversationId, { name, avatar: emoji.trim() || null, color: null }));
            if (r) {
              setSecretUrl(r);
              setCreating(false);
              setName("");
              setEmoji("");
              await load();
            }
          }}
        >
          <div>
            <Label htmlFor="hook-name">{t("webhookName")}</Label>
            <input id="hook-name" autoFocus required value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder={t("webhookNamePlaceholder")} />
          </div>
          <div>
            <Label htmlFor="hook-emoji">{t("avatarEmoji")}</Label>
            <input id="hook-emoji" value={emoji} maxLength={16} onChange={(e) => setEmoji(e.target.value)} className={`${FIELD} w-24`} placeholder="🔔" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreating(false)} className={BTN}>
              {t("cancel")}
            </button>
            <button type="submit" disabled={busy || !name.trim()} className={BTN_PRIMARY}>
              {t("create")}
            </button>
          </div>
        </form>
      )}

      {secretUrl && <SecretUrl url={secretUrl.url} onDone={() => setSecretUrl(null)} />}

      {list === null ? null : list.length === 0 ? (
        !creating && <p className="px-1 text-[12.5px] text-ink-mute">{t("noWebhooks")}</p>
      ) : (
        <ul className="space-y-0.5">
          {list.map((h) => (
            <li key={h.id} className="rounded-md px-2 py-1.5">
              <div className="flex items-center gap-2.5">
                <Avatar name={h.name} email="" bot={{ id: h.id, kind: "webhook", description: "", color: h.color, avatar: h.avatar, ownerId: 0, ownerName: h.createdBy }} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink">{h.name}</span>
                  <span className="block truncate text-[12px] text-ink-mute">{t("createdBy", { name: h.createdBy })}</span>
                </span>
                <button type="button" disabled={busy} onClick={() => setConfirm({ id: h.id, action: "regenerate" })} className="icon-btn h-7 w-7" aria-label={t("regenerate")} title={t("regenerate")}>
                  <RefreshCw size={14} aria-hidden />
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirm({ id: h.id, action: "delete" })} className="icon-btn h-7 w-7 hover:text-danger" aria-label={t("delete")} title={t("delete")}>
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
              {confirm?.id === h.id && (
                <div className="mt-1.5 flex items-center gap-2 rounded-md bg-sheet-muted px-2 py-1.5">
                  <span className="flex-1 text-[12px] text-ink-soft">{confirm.action === "delete" ? t("confirmDeleteWebhook") : t("confirmRegenerate")}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const action = confirm.action;
                      setConfirm(null);
                      if (action === "delete") {
                        if ((await run(() => deleteWebhook(conversationId, h.id))) !== null) await load();
                      } else {
                        const url = await run(() => regenerateWebhook(conversationId, h.id));
                        if (url) setSecretUrl({ id: h.id, url });
                      }
                    }}
                    className={`h-7 rounded px-2 text-[12px] font-medium hover:bg-hover ${confirm.action === "delete" ? "text-danger" : "text-ink"}`}
                  >
                    {confirm.action === "delete" ? t("delete") : t("regenerate")}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)} className="h-7 rounded px-2 text-[12px] text-ink-soft hover:bg-hover">
                    {t("cancel")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The webhook URL with its key, shown once, with a copy button and a curl example. */
function SecretUrl({ url, onDone }: { url: string; onDone: () => void }) {
  const t = useTranslations("apps");
  return (
    <div className="mb-2 space-y-2 rounded-lg border border-amber/40 bg-amber/[0.06] p-3">
      <p className="text-[12.5px] font-medium text-ink">{t("copyNow")}</p>
      <CopyField value={url} />
      <p className="text-[12px] text-ink-mute">{t("curlExample")}</p>
      <pre className="overflow-x-auto rounded-md border border-line bg-sheet-muted px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre">
        {`curl -X POST -H 'Content-Type: application/json' \\\n  -d '{"text": "Hola 👋"}' \\\n  '${url}'`}
      </pre>
      <div className="flex justify-end">
        <button type="button" onClick={onDone} className={BTN}>
          <Check size={14} aria-hidden />
          {t("done")}
        </button>
      </div>
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const t = useTranslations("apps");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <input readOnly value={value} onFocus={(e) => e.target.select()} className={`${FIELD} font-mono text-[12px]`} aria-label={t("secret")} />
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // the field stays selectable
          }
        }}
        className="icon-btn h-9 w-9 shrink-0"
        aria-label={t("copy")}
        title={copied ? t("copied") : t("copy")}
      >
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      </button>
    </div>
  );
}
