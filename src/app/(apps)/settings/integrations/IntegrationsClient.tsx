"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTokenAction, revokeTokenAction } from "./actions";
import { copyFor } from "./copy";

export type TokenView = {
  id: string;
  name: string;
  scope: "read" | "write";
  prefix: string;
  created: number;
  lastUsed: number | null;
  expires: number | null;
  needsReauth: boolean;
};

export type AuditView = { id: number; tokenName: string; tool: string; at: number; ok: boolean; error: string | null };

const inputCls =
  "h-9 w-full rounded-md border border-line-strong bg-sheet px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-mute focus:border-ink disabled:opacity-60";
const primaryBtn =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";
const secondaryBtn =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line-strong px-3 text-[14px] text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60";
const labelCls = "mb-1.5 block text-[13px] font-medium text-ink-soft";
const EXPIRY_OPTIONS = [0, 7, 30, 90, 365];

function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${secondaryBtn} h-8 shrink-0 px-2.5 text-[13px]`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked: the text stays selectable.
        }
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? done : label}
    </button>
  );
}

/** Dates render in the browser's time zone; the server's may differ, so skip the hydration check. */
const When = ({ ms, fmt }: { ms: number; fmt: Intl.DateTimeFormat }) => (
  <time dateTime={new Date(ms).toISOString()} suppressHydrationWarning>
    {fmt.format(ms)}
  </time>
);

function Snippet({ code, copyLabel, copiedLabel }: { code: string; copyLabel: string; copiedLabel: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-sheet-muted p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-1 py-1 font-mono text-[12.5px] leading-relaxed text-ink">{code}</pre>
      <CopyButton text={code} label={copyLabel} done={copiedLabel} />
    </div>
  );
}

export function IntegrationsClient({
  locale,
  endpoint,
  tokens,
  audit,
  now,
}: {
  locale: string;
  endpoint: string;
  tokens: TokenView[];
  audit: AuditView[];
  now: number;
}) {
  const c = copyFor(locale);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [expiry, setExpiry] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });

  const token = created ?? c.tokenPlaceholder;
  const claudeCode = `claude mcp add --transport http zentico ${endpoint} --header "Authorization: Bearer ${token}"`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        zentico: {
          command: "npx",
          args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${ZENTICO_AUTH}"],
          env: { ZENTICO_AUTH: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await createTokenAction({ name, scope, expiresInDays: expiry || null });
      if (!r.ok) return setError(c.errors[r.error]);
      setCreated(r.token);
      setName("");
      router.refresh();
    });
  };

  const revoke = (t: TokenView) => {
    if (!window.confirm(c.revokeConfirm(t.name))) return;
    startTransition(async () => {
      await revokeTokenAction(t.id);
      router.refresh();
    });
  };

  return (
    <div className="rise mx-auto w-full max-w-3xl space-y-10 px-5 py-8 md:px-8">
      <header>
        <h2 className="text-[20px] font-semibold tracking-tight text-ink">{c.title}</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-mute">{c.intro}</p>
      </header>

      <section aria-labelledby="tokens-title" className="space-y-4">
        <div>
          <h3 id="tokens-title" className="text-[16px] font-semibold text-ink">{c.tokensTitle}</h3>
          <p className="mt-1 text-[13px] text-ink-mute">{c.tokensHint}</p>
        </div>

        {created && (
          <div role="status" className="space-y-2 rounded-lg border border-signal/40 bg-signal/5 p-4">
            <p className="text-[14px] font-medium text-ink">{c.newToken}</p>
            <p className="text-[13px] text-ink-soft">{c.newTokenHint}</p>
            <Snippet code={created} copyLabel={c.copy} copiedLabel={c.copied} />
            <button type="button" className={`${secondaryBtn} h-8 text-[13px]`} onClick={() => setCreated(null)}>
              {c.done}
            </button>
          </div>
        )}

        <form onSubmit={create} className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <label className="block">
            <span className={labelCls}>{c.name}</span>
            <input
              className={inputCls}
              value={name}
              maxLength={80}
              required
              placeholder={c.namePlaceholder}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </label>
          <label className="block">
            <span className={labelCls}>{c.scope}</span>
            <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value === "write" ? "write" : "read")} disabled={pending}>
              <option value="read">{c.scopeRead}</option>
              <option value="write">{c.scopeWrite}</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>{c.expiry}</span>
            <select className={inputCls} value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} disabled={pending}>
              {EXPIRY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? c.never : d === 365 ? c.year : c.days(d)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={primaryBtn} disabled={pending || !name.trim()}>
            <KeyRound size={15} aria-hidden />
            {pending ? c.creating : c.create}
          </button>
          {error && (
            <p role="alert" className="text-[13px] text-danger sm:col-span-4">
              {error}
            </p>
          )}
        </form>

        {tokens.length === 0 ? (
          <p className="text-[13px] text-ink-mute">{c.noTokens}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {tokens.map((t) => {
              const expired = t.expires != null && t.expires <= now;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                      <span className="truncate">{t.name}</span>
                      <span className="rounded border border-line px-1.5 py-0.5 text-[11.5px] font-normal text-ink-mute">
                        {t.scope === "write" ? c.scopeWrite : c.scopeRead}
                      </span>
                      {expired && <span className="text-[12px] font-normal text-danger">{c.expired}</span>}
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-ink-mute">
                      <span className="font-mono">{t.prefix}…</span> · {c.created} <When ms={t.created} fmt={date} /> · {c.lastUsed}{" "}
                      {t.lastUsed ? <When ms={t.lastUsed} fmt={dateTime} /> : c.neverUsed} · {c.expires}{" "}
                      {t.expires ? <When ms={t.expires} fmt={date} /> : c.never}
                    </p>
                    {t.needsReauth && <p className="mt-1 text-[12.5px] text-amber">{c.reauth}</p>}
                  </div>
                  <button type="button" className={`${secondaryBtn} h-8 text-[13px]`} onClick={() => revoke(t)} disabled={pending}>
                    {c.revoke}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="connect-title" className="space-y-5">
        <h3 id="connect-title" className="text-[16px] font-semibold text-ink">{c.connectTitle}</h3>
        <div className="space-y-2">
          <p className="text-[14px] font-medium text-ink">{c.claudeCode}</p>
          <p className="text-[13px] text-ink-mute">{c.claudeCodeHint}</p>
          <Snippet code={claudeCode} copyLabel={c.copy} copiedLabel={c.copied} />
        </div>
        <div className="space-y-2">
          <p className="text-[14px] font-medium text-ink">{c.claudeDesktop}</p>
          <p className="text-[13px] text-ink-mute">{c.claudeDesktopHint}</p>
          <Snippet code={desktop} copyLabel={c.copy} copiedLabel={c.copied} />
        </div>
        <div className="space-y-1">
          <p className="text-[14px] font-medium text-ink">{c.claudeAi}</p>
          <p className="text-[13px] leading-relaxed text-ink-mute">{c.claudeAiHint}</p>
        </div>
      </section>

      <section aria-labelledby="activity-title" className="space-y-3">
        <h3 id="activity-title" className="text-[16px] font-semibold text-ink">{c.activityTitle}</h3>
        {audit.length === 0 ? (
          <p className="text-[13px] text-ink-mute">{c.noActivity}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line text-[13px]">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2">
                <span className="w-32 shrink-0 text-ink-mute">
                  <When ms={a.at} fmt={dateTime} />
                </span>
                <span className="font-mono text-ink">{a.tool}</span>
                <span className="text-ink-mute">{a.tokenName}</span>
                <span className={`ml-auto ${a.ok ? "text-signal" : "text-danger"}`} title={a.error ?? undefined}>
                  {a.ok ? c.ok : c.failed}
                </span>
                {!a.ok && a.error && <span className="w-full truncate text-[12px] text-ink-mute">{a.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
