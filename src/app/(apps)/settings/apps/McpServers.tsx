"use client";

// Settings → Apps & bots → MCP servers: remote MCP servers each person connects (Streamable HTTP
// or HTTP+SSE) with no auth, a bearer token / custom header, or OAuth. Their tools become available
// to the person's dashboard mods and to their own Claude (as ext_<server>__<tool>). Credentials
// are sent once and stay on the server.
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, KeyRound, Plug, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BTN, BTN_PRIMARY, FIELD } from "@/app/(apps)/chat/ui";
import type { McpServerSummary, McpToolInfo } from "@/lib/user-mcp/types";
import {
  addMcpServer,
  removeMcpServer,
  renameMcpServer,
  setMcpServerEnabled,
  setMcpToolEnabled,
  testMcpServer,
  updateMcpCredentials,
  type McpActionResult,
  type McpTestView,
} from "./mcp-actions";

export type McpServerView = McpServerSummary & { tools: McpToolInfo[]; lastUsed: number | null };

const ERROR_CODES = ["unsafe_url", "auth_required", "unreachable", "timeout", "upstream_error", "invalid_request", "not_found", "rate_limited", "too_many_sessions", "state", "denied"];

export function McpServers({ servers, result }: { servers: McpServerView[]; result: { connected?: string; error?: string; server?: string } }) {
  const t = useTranslations("apps.mcp");
  const router = useRouter();
  const [banner, setBanner] = useState(result);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (result.connected || result.error) router.replace("/settings/apps#mcp-servers", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = (id?: string) => servers.find((s) => s.id === id)?.name ?? "—";
  const errorKey = (code: string) => (ERROR_CODES.includes(code) ? code : "failed");

  return (
    <section id="mcp-servers" className="scroll-mt-4">
      <div className="mb-1 flex items-center gap-2">
        <Server size={17} className="text-ink-mute" aria-hidden />
        <h2 className="flex-1 text-[14.5px] font-semibold text-ink">{t("title")}</h2>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={BTN_PRIMARY}>
            <Plus size={14} aria-hidden />
            {t("add")}
          </button>
        )}
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">{t("intro")}</p>

      {banner.connected && (
        <p role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13px] text-ink">
          <CheckCircle2 size={15} className="text-[var(--color-app-meet)]" aria-hidden />
          {t("authorizedOk", { name: nameOf(banner.connected) })}
        </p>
      )}
      {banner.error && (
        <p role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13px] text-danger">
          <AlertTriangle size={15} aria-hidden />
          {t(`errors.${errorKey(banner.error)}`)} {banner.server ? `(${nameOf(banner.server)})` : ""}
        </p>
      )}

      {adding && (
        <AddForm
          onCancel={() => setAdding(false)}
          onAdded={(authorizeUrl) => {
            setAdding(false);
            setBanner({});
            if (authorizeUrl) window.location.assign(authorizeUrl);
            else router.refresh();
          }}
        />
      )}

      {servers.length === 0 && !adding ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-mute">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} onChanged={() => setBanner({})} />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ add */

function AddForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: (authorizeUrl: string | null) => void }) {
  const t = useTranslations("apps.mcp");
  const [f, setF] = useState({ name: "", url: "", authType: "none", token: "", headerName: "", headerValue: "", clientId: "", clientSecret: "", scope: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <form
      className="mb-3 space-y-3 rounded-xl border border-line p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await addMcpServer(f);
        setBusy(false);
        if (!r.ok) return setError(r.code === "invalid_request" || r.code === "unsafe_url" || r.code === "auth_required" ? r.error : t(`errors.${ERROR_CODES.includes(r.code) ? r.code : "failed"}`));
        onAdded(r.data.authorizeUrl);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[12.5px] font-medium text-ink-soft">{t("name")}</span>
          <input required maxLength={60} value={f.name} onChange={set("name")} placeholder={t("namePlaceholder")} className={FIELD} />
        </label>
        <label className="block space-y-1">
          <span className="text-[12.5px] font-medium text-ink-soft">{t("url")}</span>
          <input required type="url" maxLength={2048} value={f.url} onChange={set("url")} placeholder="https://example.com/mcp" className={`${FIELD} font-mono text-[13px]`} />
        </label>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-[12.5px] font-medium text-ink-soft">{t("auth")}</legend>
        <div className="flex flex-wrap gap-3 text-[13px] text-ink">
          {(["none", "bearer", "header", "oauth"] as const).map((a) => (
            <label key={a} className="inline-flex items-center gap-1.5">
              <input type="radio" name="authType" value={a} checked={f.authType === a} onChange={set("authType")} />
              {t(`authTypes.${a}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {f.authType === "bearer" && (
        <label className="block space-y-1">
          <span className="text-[12.5px] font-medium text-ink-soft">{t("token")}</span>
          <input required type="password" autoComplete="off" value={f.token} onChange={set("token")} className={`${FIELD} font-mono text-[13px]`} />
        </label>
      )}
      {f.authType === "header" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[12.5px] font-medium text-ink-soft">{t("headerName")}</span>
            <input required pattern="[A-Za-z0-9-]{1,64}" value={f.headerName} onChange={set("headerName")} placeholder="X-API-Key" className={`${FIELD} font-mono text-[13px]`} />
          </label>
          <label className="block space-y-1">
            <span className="text-[12.5px] font-medium text-ink-soft">{t("headerValue")}</span>
            <input required type="password" autoComplete="off" value={f.headerValue} onChange={set("headerValue")} className={`${FIELD} font-mono text-[13px]`} />
          </label>
        </div>
      )}
      {f.authType === "oauth" && (
        <div className="space-y-2">
          <p className="text-[12px] leading-relaxed text-ink-mute">{t("oauthHint")}</p>
          <button type="button" onClick={() => setAdvanced((v) => !v)} className="inline-flex items-center gap-1 text-[12.5px] text-ink-soft hover:text-ink">
            {advanced ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            {t("oauthAdvanced")}
          </button>
          {advanced && (
            <div className="grid gap-3 sm:grid-cols-3">
              <input value={f.clientId} onChange={set("clientId")} placeholder={t("clientId")} aria-label={t("clientId")} className={FIELD} />
              <input type="password" autoComplete="off" value={f.clientSecret} onChange={set("clientSecret")} placeholder={t("clientSecret")} aria-label={t("clientSecret")} className={FIELD} />
              <input value={f.scope} onChange={set("scope")} placeholder={t("scope")} aria-label={t("scope")} className={FIELD} />
            </div>
          )}
        </div>
      )}
      <p className="text-[11.5px] leading-relaxed text-ink-mute">{t("secretsHint")}</p>
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {f.authType === "oauth" ? t("addAndAuthorize") : t("save")}
        </button>
        <button type="button" onClick={onCancel} className={BTN}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- card */

function ServerCard({ server: s, onChanged }: { server: McpServerView; onChanged: () => void }) {
  const t = useTranslations("apps.mcp");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<McpTestView | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState<"name" | "creds" | null>(null);
  const [notRevoked, setNotRevoked] = useState(false);
  const tools = test?.tools ?? s.tools;

  async function run<T>(fn: () => Promise<McpActionResult<T>>, after?: (d: T) => void) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setError(r.code === "failed" ? t("errors.failed") : r.error);
      router.refresh();
      return;
    }
    after?.(r.data);
    onChanged();
    router.refresh();
  }

  const date = (ms: number) => new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[28%] border border-line text-ink-soft">
          <Plug size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{s.name}</h3>
            <span className="rounded border border-line px-1.5 py-px font-mono text-[10.5px] text-ink-mute">ext_{s.slug}__…</span>
            {s.status === "pending" && <span className="rounded border border-line px-1.5 py-px text-[10.5px] text-ink-mute">{t("pending")}</span>}
            {s.status === "reauth" && <span className="rounded border border-danger/40 px-1.5 py-px text-[10.5px] text-danger">{t("needsReconnect")}</span>}
            {!s.enabled && <span className="rounded border border-line px-1.5 py-px text-[10.5px] text-ink-mute">{t("disabled")}</span>}
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-soft">
            {s.host} · {t(`authTypes.${s.authType}`)}
            {s.server ? ` · ${s.server.title || s.server.name} ${s.server.version}` : ""}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-mute">
            {t("lastUsed")} {s.lastUsed ? date(s.lastUsed) : t("never")}
            {s.catalogAt ? ` · ${t("toolCount", { count: s.tools.length })}` : ""}
          </p>
        </div>
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-[12.5px] text-ink-soft">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => run(() => setMcpServerEnabled(s.id, e.target.checked))} />
          {t("enabled")}
        </label>
      </div>

      {s.lastError && !test && <p className="mt-2 text-[12px] text-danger">{t("lastError", { error: s.lastError })}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button type="button" disabled={busy || s.status !== "ok"} onClick={() => run(() => testMcpServer(s.id), (d) => { setTest(d); setShowTools(true); })} className={BTN}>
          <RefreshCw size={14} aria-hidden className={busy ? "animate-spin" : ""} />
          {t("test")}
        </button>
        {s.authType === "oauth" && (
          <a href={`/api/user-mcp/oauth/start?server=${encodeURIComponent(s.id)}`} className={s.status === "ok" ? BTN : BTN_PRIMARY}>
            <KeyRound size={14} aria-hidden />
            {s.status === "pending" ? t("authorize") : t("reauthorize")}
          </a>
        )}
        {(s.authType === "bearer" || s.authType === "header") && (
          <button type="button" disabled={busy} onClick={() => setEditing(editing === "creds" ? null : "creds")} className={BTN}>
            <KeyRound size={14} aria-hidden />
            {t("updateCredentials")}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => setEditing(editing === "name" ? null : "name")} className={BTN}>
          {t("rename")}
        </button>
        {(tools.length > 0 || test) && (
          <button type="button" onClick={() => setShowTools((v) => !v)} className={BTN}>
            {showTools ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {t("tools")} ({tools.length})
          </button>
        )}
        {!confirmRemove && (
          <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)} className={`${BTN} hover:text-danger`}>
            <Trash2 size={14} aria-hidden />
            {t("remove")}
          </button>
        )}
      </div>

      {editing === "name" && (
        <InlineForm
          fields={[{ key: "name", label: t("name"), value: s.name }]}
          onCancel={() => setEditing(null)}
          onSubmit={(v) => run(() => renameMcpServer(s.id, v.name), () => setEditing(null))}
          busy={busy}
          submit={t("save")}
          cancel={t("cancel")}
        />
      )}
      {editing === "creds" && (
        <InlineForm
          fields={
            s.authType === "bearer"
              ? [{ key: "token", label: t("token"), secret: true }]
              : [
                  { key: "headerName", label: t("headerName") },
                  { key: "headerValue", label: t("headerValue"), secret: true },
                ]
          }
          onCancel={() => setEditing(null)}
          onSubmit={(v) => run(() => updateMcpCredentials(s.id, v), () => setEditing(null))}
          busy={busy}
          submit={t("save")}
          cancel={t("cancel")}
        />
      )}

      {confirmRemove && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-sheet-muted px-3 py-2">
          <span className="flex-1 text-[12.5px] text-ink-soft">{t("confirmRemove", { name: s.name })}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => removeMcpServer(s.id), (d) => { setConfirmRemove(false); setNotRevoked(s.authType === "oauth" && !d.revoked); })}
            className="h-7 rounded px-2 text-[12px] font-medium text-danger hover:bg-hover"
          >
            {t("remove")}
          </button>
          <button type="button" onClick={() => setConfirmRemove(false)} className="h-7 rounded px-2 text-[12px] text-ink-soft hover:bg-hover">
            {t("cancel")}
          </button>
        </div>
      )}
      {notRevoked && <p className="mt-2 text-[12px] text-ink-mute">{t("notRevoked")}</p>}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      {test && (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-soft">
          <CheckCircle2 size={14} className="text-[var(--color-app-meet)]" aria-hidden />
          {t("testOk", { ms: test.ms, transport: test.transport, tools: test.tools.length, resources: test.resources.length, prompts: test.prompts.length })}
        </p>
      )}
      {test?.server?.instructions && <p className="mt-1 line-clamp-3 text-[12px] text-ink-mute">{test.server.instructions}</p>}

      {showTools && (
        <div className="mt-3 space-y-3">
          {tools.length > 0 && (
            <div>
              <h4 className="mb-1 text-[12.5px] font-semibold text-ink-soft">{t("tools")}</h4>
              <p className="mb-1.5 text-[11.5px] text-ink-mute">{t("toolsHint")}</p>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {tools.map((tool) => (
                  <li key={tool.name} className="px-3 py-2">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={tool.enabled}
                        disabled={busy}
                        aria-label={t("toolEnabled", { name: tool.name })}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          void run(() => setMcpToolEnabled(s.id, tool.name, enabled), () =>
                            setTest((x) => (x ? { ...x, tools: x.tools.map((y) => (y.name === tool.name ? { ...y, enabled } : y)) } : x)),
                          );
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[12.5px] text-ink">{tool.name}</span>
                          <span className={`rounded border px-1 py-px text-[10px] ${tool.access === "read" ? "border-line text-ink-mute" : "border-danger/40 text-danger"}`}>
                            {tool.access === "read" ? t("readOnly") : t("sideEffects")}
                          </span>
                        </div>
                        {tool.description && <p className="mt-0.5 line-clamp-3 text-[12px] text-ink-soft">{tool.description}</p>}
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11.5px] text-ink-mute">{t("inputSchema")}</summary>
                          <pre className="mt-1 max-h-60 overflow-auto rounded bg-sheet-muted p-2 text-[11px] text-ink-soft">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                        </details>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {test && test.resources.length > 0 && <NamedList title={t("resources")} items={test.resources} />}
          {test && test.prompts.length > 0 && <NamedList title={t("prompts")} items={test.prompts} />}
        </div>
      )}
    </li>
  );
}

function NamedList({ title, items }: { title: string; items: McpTestView["resources"] }) {
  return (
    <div>
      <h4 className="mb-1 text-[12.5px] font-semibold text-ink-soft">{title}</h4>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {items.map((r, i) => (
          <li key={`${r.name}-${i}`} className="px-3 py-1.5">
            <span className="font-mono text-[12px] text-ink">{r.title || r.name}</span>
            {r.uri && <span className="ml-2 font-mono text-[11px] text-ink-mute">{r.uri}</span>}
            {r.description && <p className="line-clamp-2 text-[11.5px] text-ink-soft">{r.description}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InlineForm({
  fields,
  onSubmit,
  onCancel,
  busy,
  submit,
  cancel,
}: {
  fields: { key: string; label: string; value?: string; secret?: boolean }[];
  onSubmit: (v: Record<string, string>) => void;
  onCancel: () => void;
  busy: boolean;
  submit: string;
  cancel: string;
}) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.value ?? ""])));
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-sheet-muted p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      {fields.map((f) => (
        <label key={f.key} className="block min-w-[10rem] flex-1 space-y-1">
          <span className="text-[12px] text-ink-soft">{f.label}</span>
          <input
            required
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={v[f.key]}
            onChange={(e) => setV((x) => ({ ...x, [f.key]: e.target.value }))}
            className={FIELD}
          />
        </label>
      ))}
      <button type="submit" disabled={busy} className={BTN_PRIMARY}>
        {submit}
      </button>
      <button type="button" onClick={onCancel} className={BTN}>
        {cancel}
      </button>
    </form>
  );
}
