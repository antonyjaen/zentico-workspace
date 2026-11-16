"use client";

import { Check, ChevronRight, Copy, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createTokenAction, reauthorizeTokenAction, revokeTokenAction } from "./actions";
import { copyFor, type Copy as CopyText } from "./copy";
import type { ClaudeStatus, TokenView } from "./status";

export type AuditView = { id: number; tokenName: string; tool: string; at: number; ok: boolean; error: string | null };

export type ToolView = { name: string; write: boolean };

/** A token used this recently counts as "connected". */
const RECENT_MS = 10 * 60_000;
const POLL_MS = 10_000;
const STATUS_URL = "/api/integrations/status";

const GROUP_ORDER = ["account", "mail", "calendar", "contacts", "drive", "chat", "meetings"] as const;
const groupOf = (tool: string) => {
  const prefix = tool.split("_")[0];
  if (prefix === "docs" || prefix === "drive" || prefix === "whiteboard") return "drive";
  if (prefix === "directory") return "contacts";
  if (prefix === "meet") return "meetings";
  return (GROUP_ORDER as readonly string[]).includes(prefix) ? prefix : "account";
};

const primaryBtn =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";
const secondaryBtn =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line-strong px-3 text-[14px] text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60";
const smallBtn = `${secondaryBtn} h-8 text-[13px]`;
const EXPIRY_OPTIONS = [0, 30, 90, 365];

// Creating a token's Stalwart API key may need a one-off authorization on the mail server; the
// pending request survives that round trip here and is retried on return (?mcp=ok).
const PENDING_KEY = "zw-mcp-pending";
type Pending = { op: "create"; name: string; scope: "read" | "write"; expiresInDays: number | null } | { op: "reconnect"; id: string };

function authorizeAndRetry(pending: Pending) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage blocked: the user repeats the action after authorizing.
  }
  window.location.assign("/api/auth/login?mcp=1");
}

function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    const p = raw ? (JSON.parse(raw) as Pending) : null;
    if (p?.op === "create" && typeof p.name === "string") return p;
    if (p?.op === "reconnect" && typeof p.id === "string") return p;
  } catch {
    // Ignore malformed state.
  }
  return null;
}

/** "2 minutes ago" / "hace 2 minutos" relative to `now` (the server's clock, so it hydrates cleanly). */
function ago(ms: number, now: number, rtf: Intl.RelativeTimeFormat): string {
  const sec = Math.round((ms - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86_400), "day");
}

function CopyButton({ text, label, done, primary = false }: { text: string; label: string; done: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={primary ? primaryBtn : smallBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard blocked: the text stays selectable.
        }
      }}
    >
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}

/** Dates render in the browser's time zone; the server's may differ, so skip the hydration check. */
const When = ({ ms, fmt }: { ms: number; fmt: Intl.DateTimeFormat }) => (
  <time dateTime={new Date(ms).toISOString()} suppressHydrationWarning>
    {fmt.format(ms)}
  </time>
);

function Snippet({ code, c }: { code: string; c: CopyText }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-sheet-muted p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-1 py-1 font-mono text-[12px] leading-relaxed text-ink">{code}</pre>
      <CopyButton text={code} label={c.copy} done={c.copied} />
    </div>
  );
}

type Tone = "on" | "idle" | "off";
const DOT: Record<Tone, string> = { on: "bg-signal", idle: "bg-amber", off: "bg-line-strong" };
const Dot = ({ tone, big = false }: { tone: Tone; big?: boolean }) => (
  <span aria-hidden className={`inline-block shrink-0 rounded-full ${big ? "h-3 w-3" : "h-2 w-2"} ${DOT[tone]}`} />
);

/** A collapsible section with a chevron that turns when open. */
function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-lg border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[14px] font-medium text-ink select-none hover:bg-hover [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-mute transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="border-t border-line px-4 py-4">{children}</div>
    </details>
  );
}

function Progress({ done, waiting, finished }: { done: boolean; waiting: string; finished: string }) {
  return (
    <p className={`flex items-center gap-2 text-[13px] ${done ? "text-signal" : "text-ink-soft"}`}>
      {done ? <Check size={15} aria-hidden /> : <Loader2 size={15} aria-hidden className="animate-spin text-ink-mute" />}
      {done ? finished : waiting}
    </p>
  );
}

function Capabilities({ tools, c }: { tools: ToolView[]; c: CopyText }) {
  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-ink-mute">{c.capsIntro}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        {GROUP_ORDER.map((g) => {
          const all = tools.filter((t) => groupOf(t.name) === g);
          if (!all.length) return null;
          return (
            <div key={g}>
              <p className="mb-1.5 text-[13px] font-semibold text-ink">{c.groups[g] ?? g}</p>
              <ul className="space-y-1">
                {all.map((t) => (
                  <li key={t.name} title={t.name} className="text-[13px] leading-snug text-ink-soft">
                    {c.tools[t.name] ?? t.name.replace(/_/g, " ")}
                    {t.write && (
                      <span className="ml-1.5 rounded border border-amber/50 px-1 align-[1px] text-[10.5px] leading-4 font-medium text-amber">
                        {c.changesBadge}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <div>
        <p className="mb-1 text-[13px] font-semibold text-ink">{c.bridgeCapsTitle}</p>
        <p className="text-[13px] leading-relaxed text-ink-soft">{c.bridgeCaps}</p>
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

export function IntegrationsClient({
  locale,
  endpoint,
  appUrl,
  tools,
  initial,
  audit,
}: {
  locale: string;
  endpoint: string;
  appUrl: string;
  tools: ToolView[];
  initial: ClaudeStatus;
  audit: AuditView[];
}) {
  const c = copyFor(locale);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState(initial);
  const [expiry, setExpiry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });

  // A server re-render (after creating, reconnecting or revoking) brings fresher data.
  useEffect(() => setStatus((s) => (initial.now >= s.now ? initial : s)), [initial]);

  // Live status while the page is visible: a plain GET, never a server action.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(STATUS_URL, { cache: "no-store" });
        if (!r.ok || !r.headers.get("content-type")?.includes("application/json")) return;
        const s = (await r.json()) as ClaudeStatus;
        if (alive && Array.isArray(s?.tokens)) setStatus((prev) => (s.now >= prev.now ? s : prev));
      } catch {
        // Offline or signed out: keep the last known status.
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const { tokens, bridge, now } = status;
  const isExpired = (t: TokenView) => t.expires != null && t.expires <= now;
  const usable = tokens.filter((t) => !isExpired(t));
  const recent = usable
    .filter((t) => t.lastUsed != null && now - t.lastUsed < RECENT_MS)
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))[0];
  const lastUse = Math.max(0, ...usable.map((t) => t.lastUsed ?? 0)) || null;
  const tone: Tone = recent || bridge.connected ? "on" : usable.length ? "idle" : "off";
  const attention = usable.some((t) => t.needsReauth || t.legacy);

  const headline = { on: c.statusConnected, idle: c.statusIdle, off: c.statusOff }[tone];
  const hint = { on: c.statusConnectedHint, idle: c.statusIdleHint, off: c.statusOffHint }[tone];
  const mcpTone: Tone = recent ? "on" : usable.length ? "idle" : "off";
  const mcpText = recent
    ? c.mcpActive(recent.name, ago(recent.lastUsed!, now, rtf))
    : !usable.length
      ? c.mcpNone
      : lastUse
        ? c.mcpLast(ago(lastUse, now, rtf))
        : c.mcpNever;
  const bridgeText = bridge.connected
    ? c.bridgeActive(bridge.host)
    : bridge.lastSeen
      ? c.bridgeLast(ago(bridge.lastSeen, now, rtf))
      : c.bridgeNever;

  const newRow = created ? tokens.find((t) => t.id === created.id) : undefined;
  const joined = newRow?.lastUsed != null;

  const token = created?.token ?? c.tokenPlaceholder;
  const prompt = created ? c.prompt({ appUrl, endpoint, token: created.token }) : "";
  const manualCode = `claude mcp add --transport http zentico ${endpoint} --header "Authorization: Bearer ${token}" --scope user`;
  const manualDesktop = JSON.stringify(
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
  const manualGeneric = `URL: ${endpoint}\nAuthorization: Bearer ${token}`;
  const manualBridge = `curl -fsSL ${appUrl}/bridge.mjs -o zentico-bridge.mjs\nZENTICO_TOKEN=${token} node zentico-bridge.mjs --url ${appUrl}`;

  const run = (p: Pending) => {
    setError(null);
    startTransition(async () => {
      if (p.op === "create") {
        const r = await createTokenAction({ name: p.name, scope: p.scope, expiresInDays: p.expiresInDays });
        if (!r.ok) return r.error === "authorize" ? authorizeAndRetry(p) : setError(c.errors[r.error]);
        setCreated({ id: r.id, token: r.token });
      } else {
        const r = await reauthorizeTokenAction(p.id);
        if (!r.ok && r.error === "authorize") return authorizeAndRetry(p);
        if (!r.ok) setError(c.errors[r.error ?? "failed"]);
      }
      router.refresh();
    });
  };

  const connect = () => {
    const today = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(Date.now());
    run({ op: "create", name: c.autoName(today), scope: "write", expiresInDays: expiry || null });
  };

  // Back from the mail server's authorization: retry the pending request (or report why not).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("mcp");
    const failure = params.get("mcp_error");
    if (outcome == null && failure == null) return;
    window.history.replaceState(null, "", window.location.pathname);
    const p = takePending();
    if (failure != null) return setError(failure === "invalid_scope" ? c.errors.not_allowed : c.errors.authorize_failed);
    if (outcome === "ok" && p) run(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  const revoke = (t: TokenView) => {
    if (!window.confirm(c.revokeConfirm(t.name))) return;
    startTransition(async () => {
      await revokeTokenAction(t.id);
      if (created?.id === t.id) setCreated(null);
      router.refresh();
    });
  };

  return (
    <div className="rise mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
      <header>
        <h2 className="text-[20px] font-semibold tracking-tight text-ink">{c.title}</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-mute">{c.intro}</p>
      </header>

      {/* Status + connect */}
      <section id="bridge" aria-labelledby="claude-title" className="scroll-mt-4 rounded-xl border border-line bg-sheet">
        <div className="space-y-4 p-4 md:p-5">
          <div className="flex items-start gap-3">
            <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sheet-muted text-ink">
              <Sparkles size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id="claude-title" className="text-[16px] font-semibold text-ink">
                Claude
              </h3>
              <p role="status" className="mt-0.5 flex items-center gap-2 text-[14px] font-medium text-ink">
                <Dot tone={tone} big />
                {headline}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">{hint}</p>
              {attention && <p className="mt-1 text-[13px] text-amber">{c.needsAttention}</p>}
            </div>
          </div>

          <ul className="space-y-2 rounded-lg bg-sheet-muted px-3 py-2.5 text-[13px]">
            <li className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-ink-soft">
                <Dot tone={mcpTone} />
                {c.mcpLabel}
              </span>
              <span className="pl-4 text-ink-mute sm:pl-0 sm:text-right">{mcpText}</span>
            </li>
            <li className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-ink-soft">
                <Dot tone={bridge.connected ? "on" : "off"} />
                {c.bridgeLabel}
              </span>
              <span className="pl-4 text-ink-mute sm:pl-0 sm:text-right">{bridgeText}</span>
            </li>
          </ul>

          {created ? (
            <div className="space-y-3 border-t border-line pt-4">
              <div>
                <p className="text-[15px] font-semibold text-ink">{c.stepTitle}</p>
                <p className="mt-0.5 text-[13px] text-ink-mute">{c.stepHint}</p>
              </div>
              <pre className="max-h-72 overflow-auto rounded-md border border-line bg-sheet-muted p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-ink">
                {prompt}
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton text={prompt} label={c.copyPrompt} done={c.copied} primary />
                <CopyButton text={created.token} label={c.copyToken} done={c.copied} />
              </div>
              <p className="text-[12.5px] text-amber">{c.tokenOnce}</p>
              <div className="space-y-1.5 pt-1">
                <Progress done={joined} waiting={c.waiting} finished={c.joined} />
                <Progress done={bridge.connected} waiting={c.waitingBridge} finished={c.bridgeUp(bridge.host)} />
              </div>
              <button type="button" className={smallBtn} onClick={() => setCreated(null)}>
                {c.done}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
              <button type="button" className={primaryBtn} onClick={connect} disabled={pending}>
                {pending ? <Loader2 size={15} aria-hidden className="animate-spin" /> : <Sparkles size={15} aria-hidden />}
                {pending ? c.connecting : usable.length ? c.connectAnother : c.connect}
              </button>
              <label className="flex items-center gap-2 text-[13px] text-ink-mute">
                {c.expiryLabel}
                <select
                  className="h-8 rounded-md border border-line-strong bg-sheet px-2 text-[13px] text-ink outline-none focus:border-ink"
                  value={expiry}
                  onChange={(e) => setExpiry(Number(e.target.value))}
                  disabled={pending}
                >
                  {EXPIRY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d === 0 ? c.never : d === 365 ? c.year : c.days(d)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      </section>

      {/* Connections */}
      <section aria-labelledby="tokens-title" className="space-y-3">
        <div>
          <h3 id="tokens-title" className="text-[16px] font-semibold text-ink">
            {c.tokensTitle}
          </h3>
          <p className="mt-0.5 text-[13px] text-ink-mute">{c.tokensHint}</p>
        </div>
        {tokens.length === 0 ? (
          <p className="text-[13px] text-ink-mute">{c.noTokens}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {tokens.map((t) => {
              const expired = isExpired(t);
              const live = !expired && t.lastUsed != null && now - t.lastUsed < RECENT_MS;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
                      <Dot tone={live ? "on" : expired ? "off" : "idle"} />
                      <span className="truncate">{t.name}</span>
                    </p>
                    <p className="mt-0.5 pl-4 text-[12.5px] text-ink-mute">
                      {t.scope === "write" ? c.scopeWrite : c.scopeRead} · {c.lastActivity}{" "}
                      {t.lastUsed ? ago(t.lastUsed, now, rtf) : c.neverUsed} ·{" "}
                      {expired ? (
                        <span className="text-danger">{c.expired}</span>
                      ) : t.expires ? (
                        <>
                          {c.expires} <When ms={t.expires} fmt={date} />
                        </>
                      ) : (
                        c.neverExpires
                      )}
                    </p>
                    {!expired && (t.needsReauth || t.legacy) && (
                      <p className="mt-1 pl-4 text-[12.5px] text-amber">{t.needsReauth ? c.reauth : c.legacy}</p>
                    )}
                  </div>
                  <div className="flex gap-2 pl-4 sm:pl-0">
                    {!expired && (t.needsReauth || t.legacy) && (
                      <button type="button" className={smallBtn} onClick={() => run({ op: "reconnect", id: t.id })} disabled={pending}>
                        {c.reconnect}
                      </button>
                    )}
                    <button type="button" className={smallBtn} onClick={() => revoke(t)} disabled={pending}>
                      {c.revoke}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="space-y-3">
        <Fold title={c.capsTitle}>
          <Capabilities tools={tools} c={c} />
        </Fold>

        <Fold title={c.manualTitle}>
          <div className="space-y-5">
            <p className="text-[13px] text-ink-mute">{c.manualHint}</p>
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold text-ink">{c.manualClaudeCode}</p>
              <Snippet code={manualCode} c={c} />
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold text-ink">{c.manualDesktop}</p>
              <p className="text-[12.5px] text-ink-mute">{c.manualDesktopHint}</p>
              <Snippet code={manualDesktop} c={c} />
              <p className="text-[12.5px] leading-relaxed text-ink-mute">{c.manualClaudeAi}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold text-ink">{c.manualGeneric}</p>
              <p className="text-[12.5px] text-ink-mute">{c.manualGenericHint}</p>
              <Snippet code={manualGeneric} c={c} />
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold text-ink">{c.manualBridge}</p>
              <p className="text-[12.5px] text-ink-mute">{c.manualBridgeHint}</p>
              <Snippet code={manualBridge} c={c} />
            </div>
          </div>
        </Fold>

        <Fold title={c.activityTitle}>
          {audit.length === 0 ? (
            <p className="text-[13px] text-ink-mute">{c.noActivity}</p>
          ) : (
            <ul className="-my-1 divide-y divide-line text-[13px]">
              {audit.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                  <span className="w-32 shrink-0 text-ink-mute">
                    <When ms={a.at} fmt={dateTime} />
                  </span>
                  <span className="text-ink" title={a.tool}>
                    {c.tools[a.tool] ?? a.tool}
                  </span>
                  <span className="text-ink-mute">{a.tokenName}</span>
                  <span className={`ml-auto ${a.ok ? "text-signal" : "text-danger"}`} title={a.error ?? undefined}>
                    {a.ok ? c.ok : c.failed}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Fold>
      </div>
    </div>
  );
}
