"use client";

import { Check, ChevronRight, Copy, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createTokenAction, reauthorizeTokenAction, revokeTokenAction } from "./actions";
import { bridgeCommands, copyFor, isCli, mcpSnippet, SETUP_AGENTS, TOKEN_ENV, type BridgeAgent, type Copy as CopyText, type SetupAgent } from "./copy";
import type { ClaudeStatus, TokenView } from "./status";

export type AuditView = { id: number; tokenName: string; tool: string; at: number; ok: boolean; error: string | null };

export type ToolView = { name: string; write: boolean };

/**
 * An MCP-only client (no bridge ever seen) counts as connected while its token was used this recently.
 * With a bridge, "connected" means the bridge is connected right now: that is what meetings, chat
 * and the dashboard need.
 */
const RECENT_MS = 10 * 60_000;
const POLL_MS = 10_000;
const STATUS_URL = "/api/integrations/status";

const GROUP_ORDER = ["account", "mail", "calendar", "contacts", "drive", "chat", "meetings"] as const;
const groupOf = (tool: string) => {
  const prefix = tool.split("_")[0];
  if (prefix === "docs" || prefix === "drive" || prefix === "whiteboard") return "drive";
  if (prefix === "directory") return "contacts";
  if (prefix === "meet" || prefix === "meeting") return "meetings";
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
type Pending =
  | { op: "create"; name: string; scope: "read" | "write"; expiresInDays: number | null; agent?: SetupAgent }
  | { op: "reconnect"; id: string };

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

type Family = ClaudeStatus["bridge"]["family"];

/** The tab to start on: the agent the bridge last reported, else none (the user picks). */
function initialAgent(family: Family): SetupAgent | null {
  if (family === "openai" || family === "anthropic") return "api";
  return family && (SETUP_AGENTS as readonly string[]).includes(family) ? (family as SetupAgent) : null;
}

/** What the "start the bridge" command runs: the bridge's last agent, else the one picked on this page. */
function bridgeAgentOf(family: Family, picked: SetupAgent | null): BridgeAgent | null {
  if (family === "openai" || family === "anthropic") return "api";
  if (family) return family;
  return picked && picked !== "mcp" ? picked : null;
}

/** Short name of a tab for the connection's name ("Codex – 17 Nov 2026"). */
const tokenLabel = (agent: SetupAgent, c: CopyText) => (agent === "mcp" ? "MCP client" : agent === "api" ? "API bridge" : c.tabs[agent]);

function AgentPicker({ value, onChange, c }: { value: SetupAgent | null; onChange: (a: SetupAgent) => void; c: CopyText }) {
  return (
    <div className="space-y-2">
      <p id="agent-pick" className="text-[13px] font-medium text-ink">
        {c.pickAgent}
      </p>
      <div role="radiogroup" aria-labelledby="agent-pick" className="flex flex-wrap gap-1.5">
        {SETUP_AGENTS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={value === a}
            onClick={() => onChange(a)}
            className={`h-8 rounded-md border px-2.5 text-[13px] transition-colors ${
              value === a ? "border-ink bg-ink text-sheet" : "border-line-strong text-ink-soft hover:bg-hover hover:text-ink"
            }`}
          >
            {c.tabs[a]}
          </button>
        ))}
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink-mute">{value ? c.tabHints[value] : c.pickAgentHint}</p>
    </div>
  );
}

/** Config snippets for one tab (with the real token right after connecting, else a placeholder). */
function SetupSnippets({ agent, endpoint, appUrl, token, c }: { agent: SetupAgent; endpoint: string; appUrl: string; token: string; c: CopyText }) {
  const block = (title: string, code: string, hint?: string) => (
    <div key={title} className="space-y-1.5">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      {hint && <p className="text-[12.5px] text-ink-mute">{hint}</p>}
      <Snippet code={code} c={c} />
    </div>
  );
  const bridge = (a: Parameters<typeof bridgeCommands>[0]) => {
    const b = bridgeCommands(a, appUrl, token);
    return block(c.manualBridge, `# macOS / Linux\n${b.unix}\n\n# Windows (PowerShell)\n${b.windows}`, c.manualBridgeHint);
  };
  const env = `# macOS / Linux (add to your shell profile)\nexport ${TOKEN_ENV}="${token}"\n\n# Windows\nsetx ${TOKEN_ENV} "${token}"`;
  if (agent === "mcp") {
    const cursor = mcpSnippet("cursor", endpoint, token);
    const vscode = mcpSnippet("vscode", endpoint, token);
    return (
      <div className="space-y-4">
        {block(`Cursor · ${cursor.file}`, cursor.code)}
        {block(`VS Code · ${vscode.file}`, vscode.code)}
        {block(c.manualGeneric, `URL: ${endpoint}\nAuthorization: Bearer ${token}`, c.manualGenericHint)}
      </div>
    );
  }
  if (agent === "api") return <div className="space-y-4">{bridge("api")}</div>;
  if (agent === "claude") {
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
    return (
      <div className="space-y-4">
        {block(c.manualClaudeCode, mcpSnippet("claude", endpoint, token).code)}
        {bridge("claude")}
        {block(c.manualDesktop, desktop, c.manualDesktopHint)}
      </div>
    );
  }
  const s = mcpSnippet(agent, endpoint, token);
  return (
    <div className="space-y-4">
      {block(TOKEN_ENV, env, c.manualEnv)}
      {block(`${c.tabs[agent]} · ${s.file}`, s.code)}
      {bridge(agent)}
    </div>
  );
}

type Profile = { name: string; customName: string | null; defaultName: string; wakeWords: string[] };

/** The assistant's name and extra wake words (GET/PUT /api/agent/profile). */
function AgentNameCard({ c }: { c: CopyText }) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [wake, setWake] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "nameInvalid" | "wakeInvalid" | "failed">("idle");

  useEffect(() => {
    let alive = true;
    fetch("/api/agent/profile", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Profile>) : null))
      .then((p) => {
        if (!alive || !p) return;
        setProfile(p);
        setName(p.customName ?? "");
        setWake(p.wakeWords.join(", "));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("saving");
    const wakeWords = wake
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    try {
      const r = await fetch("/api/agent/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || null, wakeWords }),
      });
      if (!r.ok) {
        const err = ((await r.json().catch(() => null)) as { error?: string } | null)?.error;
        return setState(err === "invalid_name" ? "nameInvalid" : err === "invalid_wake_words" ? "wakeInvalid" : "failed");
      }
      setProfile((await r.json()) as Profile);
      setState("saved");
      // Messages carry the name ({agent}): re-render them.
      router.refresh();
    } catch {
      setState("failed");
    }
  };

  const field = "h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-[14px] text-ink outline-none focus:border-ink";
  return (
    <section aria-labelledby="agent-name-title" className="rounded-xl border border-line bg-sheet p-4 md:p-5">
      <h3 id="agent-name-title" className="text-[16px] font-semibold text-ink">
        {c.nameTitle}
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">{c.nameHint}</p>
      <form onSubmit={save} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-[13px] text-ink-soft">
          <span>{c.nameLabel}</span>
          <input className={field} value={name} maxLength={24} placeholder={profile?.defaultName ?? ""} onChange={(e) => setName(e.target.value)} disabled={!profile} />
        </label>
        <label className="space-y-1 text-[13px] text-ink-soft">
          <span>{c.wakeLabel}</span>
          <input className={field} value={wake} maxLength={200} onChange={(e) => setWake(e.target.value)} disabled={!profile} aria-describedby="wake-hint" />
          <span id="wake-hint" className="block text-[12px] text-ink-mute">
            {c.wakeHint}
          </span>
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" className={smallBtn} disabled={!profile || state === "saving"}>
            {state === "saving" ? <Loader2 size={14} aria-hidden className="animate-spin" /> : null}
            {c.save}
          </button>
          <span role="status" className={`text-[12.5px] ${state === "saved" ? "text-signal" : "text-danger"}`}>
            {state === "saved" ? c.saved : state === "nameInvalid" ? c.nameInvalid : state === "wakeInvalid" ? c.wakeInvalid : state === "failed" ? c.errors.failed : ""}
          </span>
        </div>
      </form>
    </section>
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
  const [agent, setAgent] = useState<SetupAgent | null>(() => initialAgent(initial.bridge.family));

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
  // What works right now: a connected bridge, or (for MCP-only clients, no bridge ever) a token in use.
  const bridgeSeen = bridge.lastSeen != null || bridge.family != null;
  const tone: Tone = bridge.connected || (!bridgeSeen && recent) ? "on" : usable.length ? "idle" : "off";
  const noBridge = tone === "idle" && bridgeSeen;
  const attention = usable.some((t) => t.needsReauth || t.legacy);

  const headline = { on: c.statusConnected, idle: noBridge ? c.statusTokenNoBridge : c.statusIdle, off: c.statusOff }[tone];
  const hint = {
    on: c.statusConnectedHint,
    idle: noBridge && bridge.lastSeen ? c.statusTokenNoBridgeHint(ago(bridge.lastSeen, now, rtf)) : c.statusIdleHint,
    off: c.statusOffHint,
  }[tone];
  // The exact command to (re)start the bridge, with the real workspace URL and the user's agent.
  const startAgent = tone === "idle" ? bridgeAgentOf(bridge.family, agent) : null;
  const start = startAgent ? bridgeCommands(startAgent, appUrl, c.tokenPlaceholder) : null;
  const mcpTone: Tone = recent ? "on" : usable.length ? "idle" : "off";
  const mcpText = recent
    ? c.mcpActive(recent.name, ago(recent.lastUsed!, now, rtf))
    : !usable.length
      ? c.mcpNone
      : lastUse
        ? c.mcpLast(ago(lastUse, now, rtf))
        : c.mcpNever;
  const bridgeText = bridge.connected
    ? c.bridgeActive(bridge.host, bridge.agent)
    : bridge.lastSeen
      ? c.bridgeLast(ago(bridge.lastSeen, now, rtf))
      : c.bridgeNever;

  const newRow = created ? tokens.find((t) => t.id === created.id) : undefined;
  const joined = newRow?.lastUsed != null;

  const cli = agent != null && isCli(agent);
  const prompt = created && agent && isCli(agent) ? c.prompt(agent, { appUrl, endpoint, token: created.token }) : "";
  const agentLabel = agent && isCli(agent) ? c.tabs[agent] : "";

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
    if (!agent) return;
    const today = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(Date.now());
    run({ op: "create", name: c.autoName(tokenLabel(agent, c), today), scope: "write", expiresInDays: expiry || null, agent });
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
    if (p?.op === "create" && p.agent && (SETUP_AGENTS as readonly string[]).includes(p.agent)) setAgent(p.agent);
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
      <section id="bridge" aria-labelledby="agent-title" className="scroll-mt-4 rounded-xl border border-line bg-sheet">
        <div className="space-y-4 p-4 md:p-5">
          <div className="flex items-start gap-3">
            <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sheet-muted text-ink">
              <Sparkles size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id="agent-title" className="text-[16px] font-semibold text-ink">
                {c.agentTitle}
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
                <Dot tone={bridge.connected ? "on" : bridgeSeen && usable.length ? "idle" : "off"} />
                {c.bridgeLabel}
              </span>
              <span className="pl-4 text-ink-mute sm:pl-0 sm:text-right">{bridgeText}</span>
            </li>
          </ul>

          {start && !created && (
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold text-ink">{c.startBridgeTitle}</p>
              <p className="text-[12.5px] text-ink-mute">{c.startBridgeHint}</p>
              <Snippet code={`# macOS / Linux\n${start.unix}\n\n# Windows (PowerShell)\n${start.windows}`} c={c} />
            </div>
          )}

          {created && agent ? (
            <div className="space-y-3 border-t border-line pt-4">
              <div>
                <p className="text-[15px] font-semibold text-ink">
                  {cli ? c.stepTitle(agentLabel) : agent === "mcp" ? c.stepTitleMcp : c.stepTitleApi}
                </p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-mute">
                  {cli ? c.stepHint(agentLabel) : agent === "mcp" ? c.stepHintMcp : c.stepHintApi}
                </p>
              </div>
              {cli ? (
                <>
                  <pre className="max-h-72 overflow-auto rounded-md border border-line bg-sheet-muted p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-ink">
                    {prompt}
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton text={prompt} label={c.copyPrompt} done={c.copied} primary />
                    <CopyButton text={created.token} label={c.copyToken} done={c.copied} />
                  </div>
                </>
              ) : (
                <>
                  <SetupSnippets agent={agent} endpoint={endpoint} appUrl={appUrl} token={created.token} c={c} />
                  <CopyButton text={created.token} label={c.copyToken} done={c.copied} />
                </>
              )}
              <p className="text-[12.5px] text-amber">{c.tokenOnce}</p>
              <div className="space-y-1.5 pt-1">
                <Progress done={joined} waiting={c.waiting} finished={c.joined} />
                {agent !== "mcp" && (
                  <Progress done={bridge.connected} waiting={c.waitingBridge} finished={c.bridgeUp(bridge.host)} />
                )}
              </div>
              <button type="button" className={smallBtn} onClick={() => setCreated(null)}>
                {c.done}
              </button>
            </div>
          ) : (
            <div className="space-y-4 border-t border-line pt-4">
              <AgentPicker value={agent} onChange={setAgent} c={c} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <button type="button" className={primaryBtn} onClick={connect} disabled={pending || !agent}>
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
            </div>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      </section>

      <AgentNameCard c={c} />

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
            <AgentPicker value={agent} onChange={setAgent} c={c} />
            {agent && <SetupSnippets agent={agent} endpoint={endpoint} appUrl={appUrl} token={c.tokenPlaceholder} c={c} />}
            <div className="space-y-1.5">
              {agent && agent !== "mcp" && (
                <>
                  <p className="text-[13px] font-semibold text-ink">{c.manualGeneric}</p>
                  <p className="text-[12.5px] text-ink-mute">{c.manualGenericHint}</p>
                  <Snippet code={`URL: ${endpoint}\nAuthorization: Bearer ${c.tokenPlaceholder}`} c={c} />
                </>
              )}
              <p className="text-[12.5px] leading-relaxed text-ink-mute">{c.manualClaudeAi}</p>
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
