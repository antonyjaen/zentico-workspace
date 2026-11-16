"use client";

// Settings → Apps & bots: my HTTP apps (create, edit, secrets shown once, delivery log, DM),
// my Claude, and a short developer guide with curl examples.
import { Activity, Bot, KeyRound, MessageSquare, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { openAppDm } from "@/app/(apps)/chat/app-actions";
import { CopyField } from "@/app/(apps)/chat/AppsPanel";
import { NAME_MAX, type BotCommand } from "@/app/(apps)/chat/shared";
import { Avatar, BTN, BTN_PRIMARY, FIELD, Label, useErrorText } from "@/app/(apps)/chat/ui";
import type { Delivery } from "@/lib/chat/bots";
import { createApp, deleteApp, getDeliveries, rotateAppSecret, rotateAppToken, updateApp, type AppForm } from "./actions";
import { ApiGuide } from "./ApiGuide";

export type AppView = {
  id: string;
  userId: number;
  name: string;
  handle: string;
  description: string;
  color: number | null;
  avatar: string | null;
  endpointUrl: string;
  shared: boolean;
  commands: BotCommand[];
  tokenPrefix: string | null;
  created: number;
};

type Secrets = { appId: string; signingSecret?: string; token?: string };

export function AppsSettings({
  apps,
  appUrl,
  me,
  bridgeConnected,
  connectedApps,
}: {
  apps: AppView[];
  appUrl: string;
  me: { id: number; name: string; email: string };
  bridgeConnected: boolean;
  /** Settings → Connected apps (rendered by the page). */
  connectedApps?: React.ReactNode;
}) {
  const t = useTranslations("apps.settings");
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-6 md:px-6">
      <p className="text-[13.5px] leading-relaxed text-ink-soft">{t("intro")}</p>

      {/* My Claude */}
      <section className="rounded-xl border border-line p-4">
        <div className="flex items-start gap-3">
          <Avatar name="Claude" email="" bot={{ id: "", kind: "claude", description: "", color: 25, avatar: null, ownerId: me.id, ownerName: me.name }} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14.5px] font-semibold text-ink">{t("claudeTitle")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{t("claudeBody")}</p>
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-mute">
              <span className={`inline-block h-2 w-2 rounded-full ${bridgeConnected ? "bg-[var(--color-app-meet)]" : "bg-ink-mute"}`} aria-hidden />
              {bridgeConnected ? t("bridgeOn") : t("bridgeOff")}{" "}
              <Link href="/settings/integrations#bridge" className="text-accent hover:underline">
                {t("bridgeSetup")}
              </Link>
            </p>
          </div>
        </div>
      </section>

      {connectedApps}

      {/* My apps */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Bot size={17} className="text-ink-mute" aria-hidden />
          <h2 className="flex-1 text-[14.5px] font-semibold text-ink">{t("myApps")}</h2>
          {editing !== "new" && (
            <button type="button" onClick={() => setEditing("new")} className={BTN_PRIMARY}>
              <Plus size={14} aria-hidden />
              {t("newApp")}
            </button>
          )}
        </div>

        {editing === "new" && (
          <AppEditor
            onCancel={() => setEditing(null)}
            onSaved={(r) => {
              setEditing(null);
              if (r) setSecrets(r);
              router.refresh();
            }}
          />
        )}

        {apps.length === 0 && editing !== "new" ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-ink-mute">{t("noApps")}</p>
        ) : (
          <ul className="space-y-3">
            {apps.map((a) =>
              editing === a.id ? (
                <li key={a.id}>
                  <AppEditor
                    app={a}
                    onCancel={() => setEditing(null)}
                    onSaved={() => {
                      setEditing(null);
                      router.refresh();
                    }}
                  />
                </li>
              ) : (
                <AppCard
                  key={a.id}
                  app={a}
                  secrets={secrets?.appId === a.id ? secrets : null}
                  onSecrets={setSecrets}
                  onEdit={() => setEditing(a.id)}
                  onDeleted={() => router.refresh()}
                />
              ),
            )}
          </ul>
        )}
      </section>

      <ApiGuide appUrl={appUrl} />
    </div>
  );
}

function AppCard({
  app,
  secrets,
  onSecrets,
  onEdit,
  onDeleted,
}: {
  app: AppView;
  secrets: Secrets | null;
  onSecrets: (s: Secrets | null) => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("apps.settings");
  const errorText = useErrorText();
  const router = useRouter();
  const [confirm, setConfirm] = useState<"delete" | "secret" | "token" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<Delivery[] | null>(null);
  const [showLog, setShowLog] = useState(false);

  const run = async <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<{ value: T } | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) {
        setError(errorText(r.error));
        return null;
      }
      return { value: r.data };
    } finally {
      setBusy(false);
    }
  };

  const loadLog = async () => {
    const r = await run(() => getDeliveries(app.id));
    if (r) setLog(r.value);
  };

  const bot = { id: app.id, kind: "http" as const, description: app.description, color: app.color, avatar: app.avatar, ownerId: 0, ownerName: "" };

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <Avatar name={app.name} email="" bot={bot} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[14px] font-semibold text-ink">{app.name}</h3>
            <span className="rounded border border-line px-1.5 py-px text-[10.5px] text-ink-mute">{app.shared ? t("shared") : t("private")}</span>
          </div>
          <p className="text-[12.5px] text-ink-mute">@{app.handle}</p>
          {app.description && <p className="mt-1 text-[13px] text-ink-soft">{app.description}</p>}
          <p className="mt-1 truncate font-mono text-[11.5px] text-ink-mute" title={app.endpointUrl}>
            POST {app.endpointUrl}
          </p>
          {app.commands.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              {app.commands.map((c) => (
                <span key={c.name} className="rounded bg-sheet-muted px-1.5 py-px font-mono text-[11.5px] text-ink-soft" title={c.description}>
                  /{c.name}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const r = await run(() => openAppDm(app.userId));
            if (r) router.push(`/chat?c=${r.value}`);
          }}
          className={BTN}
        >
          <MessageSquare size={14} aria-hidden />
          {t("message")}
        </button>
        <button type="button" onClick={onEdit} className={BTN}>
          <Pencil size={14} aria-hidden />
          {t("edit")}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowLog((v) => !v);
            if (!showLog) void loadLog();
          }}
          className={BTN}
          aria-expanded={showLog}
        >
          <Activity size={14} aria-hidden />
          {t("deliveries")}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirm("secret")} className={BTN}>
          <KeyRound size={14} aria-hidden />
          {t("rotateSecret")}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirm("token")} className={BTN}>
          <KeyRound size={14} aria-hidden />
          {t("rotateToken")}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirm("delete")} className={`${BTN} hover:text-danger`}>
          <Trash2 size={14} aria-hidden />
          {t("delete")}
        </button>
      </div>

      {confirm && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-sheet-muted px-3 py-2">
          <span className="flex-1 text-[12.5px] text-ink-soft">
            {confirm === "delete" ? t("confirmDelete") : confirm === "secret" ? t("confirmRotateSecret") : t("confirmRotateToken")}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const what = confirm;
              setConfirm(null);
              if (what === "delete") {
                if (await run(() => deleteApp(app.id))) onDeleted();
              } else if (what === "secret") {
                const r = await run(() => rotateAppSecret(app.id));
                if (r) onSecrets({ appId: app.id, signingSecret: r.value });
              } else {
                const r = await run(() => rotateAppToken(app.id));
                if (r) onSecrets({ appId: app.id, token: r.value });
              }
            }}
            className={`h-8 rounded-md px-3 text-[13px] font-medium hover:bg-hover ${confirm === "delete" ? "text-danger" : "text-ink"}`}
          >
            {confirm === "delete" ? t("delete") : t("rotate")}
          </button>
          <button type="button" onClick={() => setConfirm(null)} className={BTN}>
            {t("cancel")}
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}

      {secrets && (
        <div className="mt-3 space-y-2 rounded-lg border border-amber/40 bg-amber/[0.06] p-3">
          <p className="text-[12.5px] font-medium text-ink">{t("copySecretsNow")}</p>
          {secrets.signingSecret && (
            <div>
              <Label>{t("signingSecret")}</Label>
              <CopyField value={secrets.signingSecret} />
            </div>
          )}
          {secrets.token && (
            <div>
              <Label>{t("apiToken")}</Label>
              <CopyField value={secrets.token} />
            </div>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={() => onSecrets(null)} className={BTN}>
              {t("done")}
            </button>
          </div>
        </div>
      )}

      {showLog && <DeliveryLog log={log} busy={busy} onRefresh={loadLog} />}
    </li>
  );
}

function DeliveryLog({ log, busy, onRefresh }: { log: Delivery[] | null; busy: boolean; onRefresh: () => void }) {
  const t = useTranslations("apps.settings");
  const locale = useLocale();
  return (
    <div className="mt-3 rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="flex-1 text-[12.5px] font-medium text-ink-soft">{t("lastDeliveries")}</p>
        <button type="button" disabled={busy} onClick={onRefresh} className="icon-btn h-7 w-7" aria-label={t("refresh")} title={t("refresh")}>
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      {!log ? null : log.length === 0 ? (
        <p className="px-3 py-3 text-[12.5px] text-ink-mute">{t("noDeliveries")}</p>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-ink-mute">
              <tr>
                <th className="px-3 py-1.5 font-medium">{t("when")}</th>
                <th className="px-3 py-1.5 font-medium">{t("event")}</th>
                <th className="px-3 py-1.5 font-medium">{t("status")}</th>
                <th className="px-3 py-1.5 font-medium">{t("latency")}</th>
                <th className="px-3 py-1.5 font-medium">{t("error")}</th>
              </tr>
            </thead>
            <tbody>
              {log.map((d) => {
                const ok = d.status !== null && d.status >= 200 && d.status < 300 && !d.error;
                return (
                  <tr key={d.id} className="border-t border-line">
                    <td className="px-3 py-1.5 whitespace-nowrap text-ink-soft tabular-nums">{new Date(d.at).toLocaleString(locale)}</td>
                    <td className="px-3 py-1.5 font-mono text-ink-soft">{d.event}</td>
                    <td className={`px-3 py-1.5 tabular-nums ${ok ? "text-ink" : "text-danger"}`}>{d.status ?? "—"}</td>
                    <td className="px-3 py-1.5 text-ink-soft tabular-nums">{d.latencyMs != null ? `${d.latencyMs} ms` : "—"}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5 text-ink-mute" title={d.error ?? ""}>
                      {d.error ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AppEditor({
  app,
  onCancel,
  onSaved,
}: {
  app?: AppView;
  onCancel: () => void;
  onSaved: (secrets: Secrets | null) => void;
}) {
  const t = useTranslations("apps.settings");
  const errorText = useErrorText();
  const [name, setName] = useState(app?.name ?? "");
  const [description, setDescription] = useState(app?.description ?? "");
  const [avatar, setAvatar] = useState(app?.avatar ?? "");
  const [color, setColor] = useState<number | null>(app?.color ?? null);
  const [endpointUrl, setEndpointUrl] = useState(app?.endpointUrl ?? "https://");
  const [shared, setShared] = useState(app?.shared ?? false);
  const [commands, setCommands] = useState<BotCommand[]>(app?.commands ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = { id: "", kind: "http" as const, description, color, avatar: avatar.trim() || null, ownerId: 0, ownerName: "" };

  const save = async () => {
    const form: AppForm = {
      name,
      description,
      avatar: avatar.trim() || null,
      color,
      endpointUrl: endpointUrl.trim(),
      shared,
      commands: commands.filter((c) => c.name.trim()),
    };
    setBusy(true);
    setError(null);
    try {
      if (app) {
        const r = await updateApp(app.id, form);
        if (!r.ok) return setError(errorText(r.error));
        onSaved(null);
      } else {
        const r = await createApp(form);
        if (!r.ok) return setError(errorText(r.error));
        onSaved({ appId: r.data.id, signingSecret: r.data.signingSecret, token: r.data.token });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-3 space-y-4 rounded-xl border border-line-strong p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-3">
        <Avatar name={name || "App"} email="" bot={preview} size={40} />
        <h3 className="text-[14px] font-semibold text-ink">{app ? t("editApp") : t("newApp")}</h3>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="app-name">{t("name")}</Label>
          <input id="app-name" required autoFocus maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
        </div>
        <div className="flex gap-3">
          <div>
            <Label htmlFor="app-emoji">{t("emoji")}</Label>
            <input id="app-emoji" maxLength={16} value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="🤖" className={`${FIELD} w-20`} />
          </div>
          <div className="min-w-0 flex-1">
            <Label htmlFor="app-color">{t("color")}</Label>
            <input
              id="app-color"
              type="range"
              min={0}
              max={359}
              value={color ?? 210}
              onChange={(e) => setColor(Number(e.target.value))}
              className="h-9 w-full"
              aria-valuetext={String(color ?? "auto")}
            />
          </div>
        </div>
      </div>
      <div>
        <Label htmlFor="app-desc">{t("description")}</Label>
        <input id="app-desc" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD} placeholder={t("descriptionPlaceholder")} />
      </div>
      <div>
        <Label htmlFor="app-url">{t("endpoint")}</Label>
        <input id="app-url" required type="url" maxLength={2000} value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} className={`${FIELD} font-mono text-[13px]`} />
        <p className="mt-1 text-[12px] text-ink-mute">{t("endpointHint")}</p>
      </div>
      <label className="flex items-start gap-2.5 text-[13px] text-ink">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="mt-0.5" />
        <span>
          {t("sharedLabel")}
          <span className="block text-[12px] text-ink-mute">{t("sharedHint")}</span>
        </span>
      </label>

      <div>
        <Label>{t("commands")}</Label>
        <p className="mb-2 text-[12px] text-ink-mute">{t("commandsHint")}</p>
        <ul className="space-y-1.5">
          {commands.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="text-ink-mute">/</span>
              <input
                value={c.name}
                maxLength={32}
                onChange={(e) => setCommands((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase() } : x)))}
                className={`${FIELD} w-36 font-mono text-[13px]`}
                aria-label={t("commandName")}
                placeholder="deploy"
              />
              <input
                value={c.description}
                maxLength={100}
                onChange={(e) => setCommands((list) => list.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                className={FIELD}
                aria-label={t("commandDescription")}
                placeholder={t("commandDescription")}
              />
              <button type="button" onClick={() => setCommands((list) => list.filter((_, j) => j !== i))} className="icon-btn h-8 w-8 shrink-0" aria-label={t("removeCommand")}>
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        {commands.length < 20 && (
          <button type="button" onClick={() => setCommands((list) => [...list, { name: "", description: "" }])} className="mt-2 text-[12.5px] font-medium text-accent hover:underline">
            {t("addCommand")}
          </button>
        )}
      </div>

      {error && <p className="text-[12.5px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>
          {t("cancel")}
        </button>
        <button type="submit" disabled={busy || !name.trim()} className={BTN_PRIMARY}>
          {app ? t("save") : t("create")}
        </button>
      </div>
    </form>
  );
}
