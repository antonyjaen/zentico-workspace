"use client";

import { Check, Copy, KeyRound, ShieldCheck, ShieldAlert, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  confirmEnrollAction,
  createAppPasswordAction,
  deleteAppPasswordAction,
  disableAction,
  type Enrollment,
  type SecurityError,
  setRequire2faAction,
  setSessionLifetimeAction,
  startEnrollAction,
} from "@/app/(apps)/settings/security/actions";

const inputClass =
  "h-9 w-full rounded-lg border border-line-strong bg-sheet px-3 text-[14px] text-ink placeholder:text-ink-mute focus:border-ink focus:outline-none";
const primaryBtn =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13.5px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:opacity-60";
const secondaryBtn =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink disabled:opacity-60";

function SectionTitle({ id, children, badge }: { id: string; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h2 id={id} className="text-[13px] font-medium tracking-wide text-ink-mute uppercase">
        {children}
      </h2>
      {badge}
    </div>
  );
}

function Badge({ tone, children }: { tone: "on" | "off" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "on"
      ? "border-signal/40 bg-signal/10 text-signal"
      : tone === "off"
        ? "border-amber/40 bg-amber/10 text-amber"
        : "border-line bg-sheet-muted text-ink-mute";
  return <span className={`rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium ${cls}`}>{children}</span>;
}

function ErrorText({ error, email }: { error: SecurityError | string | null; email?: string }) {
  const t = useTranslations("security.errors");
  if (!error) return null;
  const known = t.has(error) ? error : "failed";
  return (
    <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
      {t(known, { email: email ?? "" })}
    </p>
  );
}

function CopyButton({ value }: { value: string }) {
  const t = useTranslations("security.twoFactor");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={secondaryBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard blocked: the value stays selectable on screen.
        }
      }}
    >
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      {copied ? t("copied") : t("copy")}
    </button>
  );
}

/** Link that starts the short-lived security grant (full navigation through the provider). */
export function VerifyLink({ mode, returnTo, label }: { mode: "check" | "manage"; returnTo: string; label: string }) {
  return (
    <a href={`/api/auth/login?security=${mode}&returnTo=${encodeURIComponent(returnTo)}`} className={primaryBtn}>
      {label}
    </a>
  );
}

/* ------------------------------------------------------------- two-step verification */

export function TwoFactorCard({
  enabled,
  hasGrant,
  required,
  mode,
  email,
  returnTo,
}: {
  /** Fresh status from Stalwart, or null without a security grant. */
  enabled: boolean | null;
  hasGrant: boolean;
  required: boolean;
  /** `setup`: the page shown while the policy holds the account back. */
  mode: "settings" | "setup";
  email: string;
  returnTo: string;
}) {
  const t = useTranslations("security.twoFactor");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<SecurityError | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);

  const reset = () => {
    setCode("");
    setPassword("");
    setError(null);
  };

  const begin = () =>
    start(async () => {
      reset();
      const r = await startEnrollAction();
      if (r.ok) setEnrollment({ secret: r.secret, qr: r.qr });
      else setError(r.error);
    });

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await confirmEnrollAction({ code, password });
      if (!r.ok) {
        setError(r.error);
        if (r.error === "expired") setEnrollment(null);
        return;
      }
      reset();
      setEnrollment(null);
      setJustEnabled(true);
      if (mode === "setup") window.location.assign("/mail");
      else router.refresh();
    });
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await disableAction({ code, password });
      if (!r.ok) return setError(r.error);
      reset();
      setDisabling(false);
      setJustEnabled(false);
      router.refresh();
    });
  };

  const on = justEnabled || enabled === true;
  const badge = !hasGrant ? null : on ? <Badge tone="on">{t("on")}</Badge> : <Badge tone="off">{t("off")}</Badge>;

  const codeInput = (
    <label className="block">
      <span className="mb-1 block text-[12.5px] text-ink-soft">{t("code")}</span>
      <input
        className={`${inputClass} font-mono tracking-[0.3em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
      />
    </label>
  );
  const passwordInput = (
    <label className="block">
      <span className="mb-1 block text-[12.5px] text-ink-soft">{t("password")}</span>
      <input
        className={inputClass}
        type="password"
        autoComplete="current-password"
        required
        maxLength={256}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <span className="mt-1 block text-[12px] text-ink-mute">{t("passwordHint")}</span>
    </label>
  );

  return (
    <section aria-labelledby="sec-2fa">
      <SectionTitle id="sec-2fa" badge={badge}>
        {t("title")}
      </SectionTitle>
      <div className="mt-3 rounded-xl border border-line p-5">
        <div className="flex items-start gap-3">
          {on ? (
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-signal" aria-hidden />
          ) : (
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber" aria-hidden />
          )}
          <p className="text-[14px] leading-relaxed text-ink-soft">{on ? t("onBody") : t("offBody")}</p>
        </div>

        {!hasGrant && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-[13.5px] text-ink">{t("verifyTitle")}</p>
            <p className="mt-1 text-[12.5px] text-ink-mute">{t("verifyBody")}</p>
            <div className="mt-3">
              <VerifyLink mode={mode === "setup" ? "check" : "manage"} returnTo={returnTo} label={t("verify")} />
            </div>
          </div>
        )}

        {hasGrant && !on && !enrollment && (
          <div className="mt-4">
            <button type="button" className={primaryBtn} disabled={pending} onClick={begin}>
              {t("setup")}
            </button>
          </div>
        )}

        {hasGrant && !on && enrollment && (
          <form onSubmit={confirm} className="mt-5 space-y-5 border-t border-line pt-5">
            <div>
              <p className="text-[13.5px] font-medium text-ink">1. {t("step1")}</p>
              <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
                <svg
                  viewBox={`0 0 ${enrollment.qr.size} ${enrollment.qr.size}`}
                  className="h-44 w-44 shrink-0 rounded-lg border border-line"
                  role="img"
                  aria-label={t("qrLabel")}
                  shapeRendering="crispEdges"
                >
                  {/* Always dark on white, whatever the theme: scanners need the contrast. */}
                  <rect width="100%" height="100%" fill="#fff" />
                  <path d={enrollment.qr.path} fill="#000" />
                </svg>
                <div className="min-w-0">
                  <p className="text-[12.5px] text-ink-mute">{t("manual")}</p>
                  <p className="mt-1.5 font-mono text-[14px] tracking-wider break-all text-ink select-all">
                    {enrollment.secret.match(/.{1,4}/g)?.join(" ")}
                  </p>
                  <div className="mt-2">
                    <CopyButton value={enrollment.secret} />
                  </div>
                </div>
              </div>
            </div>
            <div>
              <p className="text-[13.5px] font-medium text-ink">2. {t("step2")}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {codeInput}
                {passwordInput}
              </div>
            </div>
            <p className="rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft">
              {t("mailApps")}
            </p>
            <div className="flex gap-2">
              <button type="submit" className={primaryBtn} disabled={pending}>
                {t("enable")}
              </button>
              <button type="button" className={secondaryBtn} disabled={pending} onClick={() => (setEnrollment(null), reset())}>
                {t("cancel")}
              </button>
            </div>
          </form>
        )}

        {hasGrant && on && (
          <div className="mt-4 space-y-3">
            {justEnabled && <p className="text-[13.5px] text-signal">{t("enabledNow")}</p>}
            <p className="text-[12.5px] leading-relaxed text-ink-mute">{t("lostDevice")}</p>
            {mode === "settings" &&
              (required ? (
                <p className="text-[12.5px] text-ink-mute">{t("requiredByAdmin")}</p>
              ) : !disabling ? (
                <button type="button" className={secondaryBtn} onClick={() => (setDisabling(true), reset())}>
                  {t("disable")}
                </button>
              ) : (
                <form onSubmit={disable} className="space-y-3 border-t border-line pt-4">
                  <p className="text-[13.5px] text-ink">{t("disableBody")}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {codeInput}
                    {passwordInput}
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className={primaryBtn} disabled={pending}>
                      {t("disable")}
                    </button>
                    <button type="button" className={secondaryBtn} disabled={pending} onClick={() => setDisabling(false)}>
                      {t("cancel")}
                    </button>
                  </div>
                </form>
              ))}
          </div>
        )}

        <ErrorText error={error} email={email} />
        {error === "reauth" && (
          <div className="mt-3">
            <VerifyLink mode={mode === "setup" ? "check" : "manage"} returnTo={returnTo} label={t("verify")} />
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- app passwords */

export type AppPasswordView = { id: string; description: string; createdAt: string | null };

export function AppPasswordsCard({ items, canManage }: { items: AppPasswordView[] | null; canManage: boolean }) {
  const t = useTranslations("security.appPasswords");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<SecurityError | null>(null);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await createAppPasswordAction(name);
      if (!r.ok) return setError(r.error);
      setName("");
      setSecret(r.secret);
      router.refresh();
    });
  };
  const remove = (item: AppPasswordView) => {
    if (!window.confirm(t("deleteConfirm", { name: item.description }))) return;
    start(async () => {
      setError(null);
      const r = await deleteAppPasswordAction(item.id);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  };
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso)) : "");

  return (
    <section aria-labelledby="sec-app" className="mt-8">
      <SectionTitle id="sec-app">{t("title")}</SectionTitle>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">{t("body")}</p>
      <div className="mt-3 rounded-xl border border-line p-5">
        {!canManage || !items ? (
          <div>
            <p className="text-[13px] text-ink-soft">{t("verifyBody")}</p>
            <div className="mt-3">
              <VerifyLink mode="manage" returnTo="/settings/security" label={t("verify")} />
            </div>
          </div>
        ) : (
          <>
            {secret && (
              <div className="mb-4 rounded-lg border border-signal/40 bg-signal/10 p-4">
                <p className="text-[13.5px] font-medium text-ink">{t("newTitle")}</p>
                <p className="mt-1 text-[12.5px] text-ink-soft">{t("newBody")}</p>
                <p className="mt-2 font-mono text-[14px] break-all text-ink select-all">{secret}</p>
                <div className="mt-2 flex gap-2">
                  <CopyButton value={secret} />
                  <button type="button" className={secondaryBtn} onClick={() => setSecret(null)}>
                    {t("done")}
                  </button>
                </div>
              </div>
            )}
            {items.length === 0 ? (
              <p className="text-[13px] text-ink-mute">{t("empty")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 py-2.5">
                    <KeyRound size={16} className="shrink-0 text-ink-mute" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] text-ink">{item.description}</p>
                      {item.createdAt && <p className="text-[12px] text-ink-mute">{t("created", { date: date(item.createdAt) })}</p>}
                    </div>
                    <button
                      type="button"
                      className="icon-btn h-8 w-8"
                      aria-label={t("delete")}
                      title={t("delete")}
                      disabled={pending}
                      onClick={() => remove(item)}
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={create} className="mt-4 flex gap-2 border-t border-line pt-4">
              <input
                className={inputClass}
                placeholder={t("name")}
                aria-label={t("name")}
                maxLength={60}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className={primaryBtn} disabled={pending || !name.trim()}>
                {t("create")}
              </button>
            </form>
          </>
        )}
        <ErrorText error={error} />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- workspace policy */

export type PolicyView = {
  required: boolean;
  enforceAfter: number;
  sessionHours: number;
  members: { email: string; enabled: boolean; checked: number }[];
};

const SESSION_PRESETS = [0, 8, 24, 168, 720] as const;

export function PolicyCard({ policy }: { policy: PolicyView }) {
  const t = useTranslations("security.policy");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [grace, setGrace] = useState(7);
  const isPreset = (SESSION_PRESETS as readonly number[]).includes(policy.sessionHours);
  const [preset, setPreset] = useState<string>(isPreset ? String(policy.sessionHours) : "custom");
  const [customDays, setCustomDays] = useState(isPreset ? "14" : String(Math.max(1, Math.round(policy.sessionHours / 24))));
  const [status, setStatus] = useState<"saved" | SecurityError | null>(null);
  const fmt = (ms: number, withTime = false) =>
    new Intl.DateTimeFormat(locale, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(ms);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: SecurityError }>) =>
    start(async () => {
      const r = await fn();
      setStatus(r.ok ? "saved" : r.error);
      if (r.ok) router.refresh();
    });

  const toggle = () => run(() => setRequire2faAction({ required: !policy.required, graceDays: grace }));
  const saveSession = (e: React.FormEvent) => {
    e.preventDefault();
    const hours = preset === "custom" ? Math.round(Number(customDays) * 24) : Number(preset);
    run(() => setSessionLifetimeAction(hours));
  };
  const presetLabel: Record<number, string> = { 0: t("sessionNone"), 8: t("h8"), 24: t("d1"), 168: t("d7"), 720: t("d30") };
  const enrolled = policy.members.filter((m) => m.enabled).length;

  return (
    <section aria-labelledby="sec-policy" className="mt-8">
      <SectionTitle id="sec-policy" badge={<Badge tone="muted">{t("admin")}</Badge>}>
        {t("title")}
      </SectionTitle>
      <div className="mt-3 divide-y divide-line rounded-xl border border-line px-5">
        <div className="py-4">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p id="pol-require-label" className="text-[14px] text-ink">
                {t("require")}
              </p>
              <p id="pol-require-hint" className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">
                {t("requireHint")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={policy.required}
              aria-labelledby="pol-require-label"
              aria-describedby="pol-require-hint"
              disabled={pending}
              onClick={toggle}
              className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors disabled:opacity-50 aria-checked:bg-primary"
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-sheet shadow-sm transition-transform duration-150 ${policy.required ? "translate-x-4" : ""}`}
              />
            </button>
          </div>
          {policy.required ? (
            <p className="mt-2 text-[12.5px] text-ink-soft">{t("enforcedFrom", { date: fmt(policy.enforceAfter, true) })}</p>
          ) : (
            <label className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-soft">
              {t("grace")}
              <select
                className="h-8 rounded-md border border-line-strong bg-sheet px-2 text-[13px] text-ink"
                value={grace}
                onChange={(e) => setGrace(Number(e.target.value))}
              >
                <option value={0}>{t("graceNone")}</option>
                <option value={7}>{t("grace7")}</option>
              </select>
            </label>
          )}
        </div>

        <form onSubmit={saveSession} className="py-4">
          <p id="pol-session-label" className="text-[14px] text-ink">
            {t("session")}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">{t("sessionHint")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-labelledby="pol-session-label"
              className="h-8 rounded-md border border-line-strong bg-sheet px-2 text-[13px] text-ink"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
            >
              {SESSION_PRESETS.map((h) => (
                <option key={h} value={h}>
                  {presetLabel[h]}
                </option>
              ))}
              <option value="custom">{t("custom")}</option>
            </select>
            {preset === "custom" && (
              <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
                <input
                  type="number"
                  min={1}
                  max={365}
                  required
                  className="h-8 w-20 rounded-md border border-line-strong bg-sheet px-2 text-[13px] text-ink"
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                />
                {t("days")}
              </label>
            )}
            <button type="submit" className={secondaryBtn} disabled={pending}>
              {t("save")}
            </button>
          </div>
        </form>

        <div className="py-4">
          <p className="text-[14px] text-ink">{t("members", { enrolled, total: policy.members.length })}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-mute">{t("membersHint")}</p>
          {policy.members.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-mute">{t("none")}</p>
          ) : (
            <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto">
              {policy.members.map((m) => (
                <li key={m.email} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{m.email}</span>
                  <span className="hidden text-[12px] text-ink-mute sm:inline">{t("checked", { date: fmt(m.checked) })}</span>
                  <Badge tone={m.enabled ? "on" : "off"}>{m.enabled ? t("statusOn") : t("statusOff")}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-2 h-5" aria-live="polite">
        {status === "saved" && <span className="font-mono text-[12px] tracking-[0.15em] text-signal uppercase">{t("saved")}</span>}
      </div>
      {status && status !== "saved" && <ErrorText error={status} />}
    </section>
  );
}
