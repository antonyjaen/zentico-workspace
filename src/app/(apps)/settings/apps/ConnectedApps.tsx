"use client";

// Settings → Apps & bots → Connected apps: the third-party services each person connects with
// OAuth (GitHub, Google, Jira, Notion, Slack). Connecting goes through /api/connect/<id>/start;
// tokens stay on the server. Providers the admin hasn't configured show the callback URL to register.
import { AlertTriangle, CheckCircle2, Link2, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CopyField } from "@/app/(apps)/chat/AppsPanel";
import { ProviderIcon, type ProviderIconId } from "@/app/(apps)/chat/ProviderIcon";
import { BTN, BTN_PRIMARY } from "@/app/(apps)/chat/ui";
import { disconnectApp } from "./actions";

export type ConnectedAppView = {
  id: ProviderIconId;
  name: string;
  configured: boolean;
  callbackUrl: string;
  envPrefix: string;
  scopes: string[];
  revocable: boolean;
  manageUrl: string | null;
  connection: {
    accountName: string;
    accountLogin: string;
    avatarUrl: string | null;
    detail: string | null;
    status: "ok" | "reauth";
    lastUsed: number | null;
  } | null;
};

export function ConnectedApps({ apps, result }: { apps: ConnectedAppView[]; result: { connected?: string; error?: string; provider?: string } }) {
  const t = useTranslations("apps.connect");
  const router = useRouter();
  const [banner, setBanner] = useState(result);

  // Drop ?connected= / ?connectError= from the URL once shown.
  useEffect(() => {
    if (result.connected || result.error) router.replace("/settings/apps#connected-apps", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = (id?: string) => apps.find((a) => a.id === id)?.name ?? "";
  const errorKey = (code: string) =>
    ["denied", "state", "notConfigured", "exchangeFailed", "accountFailed", "noSite", "timeout", "unreachable", "providerError"].includes(code) ? code : "failed";

  return (
    <section id="connected-apps" className="scroll-mt-4">
      <div className="mb-1 flex items-center gap-2">
        <Link2 size={17} className="text-ink-mute" aria-hidden />
        <h2 className="flex-1 text-[14.5px] font-semibold text-ink">{t("title")}</h2>
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">{t("intro")}</p>

      {banner.connected && (
        <p role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13px] text-ink">
          <CheckCircle2 size={15} className="text-[var(--color-app-meet)]" aria-hidden />
          {t("connectedOk", { name: nameOf(banner.connected) })}
        </p>
      )}
      {banner.error && (
        <p role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13px] text-danger">
          <AlertTriangle size={15} aria-hidden />
          {t(`errors.${errorKey(banner.error)}`, { name: nameOf(banner.provider) || "—" })}
        </p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {apps.map((a) => (
          <AppCard key={a.id} app={a} onChanged={() => setBanner({})} />
        ))}
      </ul>
    </section>
  );
}

function AppCard({ app, onChanged }: { app: ConnectedAppView; onChanged: () => void }) {
  const t = useTranslations("apps.connect");
  const locale = useLocale();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notRevoked, setNotRevoked] = useState(false);
  const c = app.connection;
  const date = (ms: number) => new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <li className="flex flex-col rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[28%] border border-line text-ink">
          <ProviderIcon id={app.id} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{app.name}</h3>
            {c?.status === "ok" && <span className="rounded border border-line px-1.5 py-px text-[10.5px] text-ink-mute">{t("connected")}</span>}
            {c?.status === "reauth" && <span className="rounded border border-danger/40 px-1.5 py-px text-[10.5px] text-danger">{t("needsReconnect")}</span>}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">{t(`about.${app.id}`)}</p>
        </div>
      </div>

      {c && (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg bg-sheet-muted px-2.5 py-2">
          {c.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.avatarUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" className="h-7 w-7 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-hover text-[12px] font-semibold text-ink-soft">
              {(c.accountName || c.accountLogin || "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">{c.accountName || c.accountLogin}</span>
            <span className="block truncate text-[11.5px] text-ink-mute">
              {[c.accountLogin !== c.accountName ? c.accountLogin : "", c.detail].filter(Boolean).join(" · ")}
            </span>
          </span>
        </div>
      )}

      {app.configured && (
        <dl className="mt-2.5 space-y-1 text-[11.5px] text-ink-mute">
          {app.scopes.length > 0 && (
            <div className="flex gap-1.5">
              <dt className="shrink-0">{t("scopes")}</dt>
              <dd className="min-w-0 font-mono break-words">{app.scopes.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ")}</dd>
            </div>
          )}
          {c && (
            <div className="flex gap-1.5">
              <dt className="shrink-0">{t("lastUsed")}</dt>
              <dd>{c.lastUsed ? date(c.lastUsed) : t("never")}</dd>
            </div>
          )}
        </dl>
      )}

      {!app.configured ? (
        <div className="mt-3 space-y-1.5 rounded-lg border border-dashed border-line p-2.5">
          <p className="text-[12.5px] font-medium text-ink-soft">{t("notConfigured")}</p>
          <p className="text-[11.5px] leading-relaxed text-ink-mute">{t("notConfiguredHint", { prefix: app.envPrefix })}</p>
          <CopyField value={app.callbackUrl} />
        </div>
      ) : (
        <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
          {(!c || c.status === "reauth") && (
            <a href={`/api/connect/${app.id}/start`} className={BTN_PRIMARY}>
              {c ? t("reconnect") : t("connect")}
            </a>
          )}
          {c && !confirm && (
            <button type="button" disabled={busy} onClick={() => setConfirm(true)} className={`${BTN} hover:text-danger`}>
              <Unplug size={14} aria-hidden />
              {t("disconnect")}
            </button>
          )}
        </div>
      )}

      {confirm && c && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-sheet-muted px-3 py-2">
          <span className="flex-1 text-[12.5px] text-ink-soft">{t("confirmDisconnect", { name: app.name })}</span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const r = await disconnectApp(app.id);
              setBusy(false);
              setConfirm(false);
              if (!r.ok) return setError(t("errors.failed", { name: app.name }));
              setNotRevoked(!r.data.revoked);
              onChanged();
              router.refresh();
            }}
            className="h-7 rounded px-2 text-[12px] font-medium text-danger hover:bg-hover"
          >
            {t("disconnect")}
          </button>
          <button type="button" onClick={() => setConfirm(false)} className="h-7 rounded px-2 text-[12px] text-ink-soft hover:bg-hover">
            {t("cancel")}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {notRevoked && !c && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-mute">
          {app.manageUrl ? (
            <>
              {t("revokeYourself", { name: app.name })}{" "}
              <a href={app.manageUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                {t("manageAt", { name: app.name })}
              </a>
            </>
          ) : (
            t("revokeYourself", { name: app.name })
          )}
        </p>
      )}
    </li>
  );
}
