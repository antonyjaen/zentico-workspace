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

export type ToolView = { name: string; write: boolean };

const GROUP_ORDER = ["account", "mail", "calendar", "contacts", "drive", "chat", "meetings"] as const;
const groupOf = (tool: string) => {
  const prefix = tool.split("_")[0];
  if (prefix === "docs" || prefix === "drive" || prefix === "whiteboard") return "drive";
  if (prefix === "directory") return "contacts";
  if (prefix === "meet") return "meetings";
  return (GROUP_ORDER as readonly string[]).includes(prefix) ? prefix : "account";
};

/** Everything a token of `scope` can do, grouped by app, plus what it never has access to. */
function Capabilities({ scope, tools, c }: { scope: "read" | "write"; tools: ToolView[]; c: ReturnType<typeof copyFor> }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {GROUP_ORDER.map((g) => {
          const all = tools.filter((t) => groupOf(t.name) === g);
          if (!all.length) return null;
          const shown = all.filter((t) => scope === "write" || !t.write);
          const missing = all.filter((t) => scope === "read" && t.write);
          return (
            <div key={g}>
              <p className="mb-1.5 text-[13px] font-semibold text-ink">{c.groups[g] ?? g}</p>
              <ul className="space-y-1.5">
                {shown.map((t) => (
                  <li key={t.name} className="text-[12.5px] leading-snug">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-[12px] text-ink">{t.name}</code>
                      {t.write && (
                        <span className="rounded border border-amber/50 px-1 text-[10.5px] leading-4 font-medium text-amber uppercase">
                          {c.writeBadge}
                        </span>
                      )}
                    </span>
                    <span className="block text-ink-mute">{c.tools[t.name] ?? ""}</span>
                  </li>
                ))}
              </ul>
              {missing.length > 0 && (
                <p className="mt-1.5 text-[12px] text-ink-mute">
                  {c.capsNotIncluded} <span className="font-mono">{missing.map((t) => t.name).join(", ")}</span>
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="rounded-md border border-line bg-sheet-muted p-3">
        <p className="text-[13px] font-semibold text-ink">{c.neverTitle}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-soft">
          {c.neverList.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

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
  appUrl,
  tools,
  bridge,
  tokens,
  audit,
  now,
}: {
  locale: string;
  endpoint: string;
  appUrl: string;
  tools: ToolView[];
  bridge: { connected: boolean; lastSeen: number | null };
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

  const [capsScope, setCapsScope] = useState<"read" | "write">("read");
  const bridgeCmd = `node zentico-bridge.mjs --url ${appUrl} --token ${token} --cwd .`;
  const hasWrite = tokens.some((t) => t.scope === "write" && !t.needsReauth && (t.expires == null || t.expires > now));

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
                      {t.lastUsed ? <When ms={t.lastUsed} fmt={dateTime} /> : c.neverUsed} ·{" "}
                      {t.expires ? (
                        <>
                          {c.expires} <When ms={t.expires} fmt={date} />
                        </>
                      ) : (
                        c.neverExpires
                      )}
                    </p>
                    {t.needsReauth && <p className="mt-1 text-[12.5px] text-amber">{c.reauth}</p>}
                  </div>
                  <button type="button" className={`${secondaryBtn} h-8 text-[13px]`} onClick={() => revoke(t)} disabled={pending}>
                    {c.revoke}
                  </button>
                  <details className="w-full">
                    <summary className="cursor-pointer text-[12.5px] text-ink-soft select-none hover:text-ink">{c.showAccess}</summary>
                    <div className="mt-3">
                      <Capabilities scope={t.scope} tools={tools} c={c} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="caps-title" className="space-y-4">
        <div>
          <h3 id="caps-title" className="text-[16px] font-semibold text-ink">{c.capsTitle}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">{c.capsIntro}</p>
        </div>
        <div role="radiogroup" aria-label={c.capsFor} className="inline-flex rounded-md border border-line p-0.5 text-[13px]">
          {(["read", "write"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={capsScope === s}
              onClick={() => setCapsScope(s)}
              className={`rounded px-3 py-1 transition-colors ${capsScope === s ? "bg-primary-soft font-medium text-ink" : "text-ink-soft hover:bg-hover"}`}
            >
              {s === "write" ? c.scopeWrite : c.scopeRead}
            </button>
          ))}
        </div>
        <Capabilities scope={capsScope} tools={tools} c={c} />
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

      <section id="bridge" aria-labelledby="bridge-title" className="scroll-mt-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="bridge-title" className="text-[16px] font-semibold text-ink">{c.bridgeTitle}</h3>
          <span role="status" className={`text-[12.5px] ${bridge.connected ? "text-signal" : "text-ink-mute"}`}>
            {bridge.connected ? (
              c.bridgeConnected
            ) : bridge.lastSeen ? (
              <>
                {c.bridgeLastSeen} <When ms={bridge.lastSeen} fmt={dateTime} />
              </>
            ) : (
              c.bridgeNever
            )}
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-mute">{c.bridgeIntro}</p>
        {!hasWrite && <p className="text-[13px] text-amber">{c.bridgeNeedsWrite}</p>}
        <ol className="list-decimal space-y-2 pl-5 text-[13px] text-ink-soft">
          {c.bridgeSteps.map((step, i) => (
            <li key={i}>
              {step}
              {i === 2 && (
                <div className="mt-2 space-y-1.5">
                  <Snippet code={bridgeCmd} copyLabel={c.copy} copiedLabel={c.copied} />
                  <p className="text-[12px] text-ink-mute">{c.bridgeTokenHint}</p>
                </div>
              )}
            </li>
          ))}
        </ol>
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
