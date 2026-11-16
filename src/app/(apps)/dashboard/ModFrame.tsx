"use client";

// Mod runtime. A mod (mods/<id>/ in the user's `Zentico UI/` folder) runs in a sandboxed iframe:
// srcdoc + sandbox="allow-scripts" WITHOUT allow-same-origin (opaque origin: no cookies, storage
// or access to this page) and a CSP that blocks every network request. Its only way out is the
// `zentico.*` SDK injected below, which posts messages to this page. Here every call is checked:
// it must come from this very iframe, be rate limited, be covered by a permission the mod declares
// AND the user granted, and write actions / Claude requests / side-effecting MCP tools are
// confirmed by the user (once per session, or "always allow"). Data goes through the workspace
// API with the user's session; no token or cookie ever reaches the iframe. A frame that navigates
// away from its srcdoc is stopped (it could carry data out in a URL).
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { callTool, listServers, UserMcpClientError, type McpServerWithTools } from "@/lib/user-mcp/client-api";
import { effectiveMcp, effectivePerms, mcpAllows, MOD_ACTIONS, MOD_EVENTS, MOD_QUERIES, missingPerms, type ModView, type UiView } from "@/lib/ui/schema";
import { safePath, useStudio, type Selection } from "./studio-context";
import { viewerTimeZone } from "./widgets";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

const THEME_VARS = [
  ["--zw-ink", "--color-ink"],
  ["--zw-ink-soft", "--color-ink-soft"],
  ["--zw-ink-mute", "--color-ink-mute"],
  ["--zw-line", "--color-line"],
  ["--zw-sheet", "--ui-card"],
  ["--zw-sheet-muted", "--color-sheet-muted"],
  ["--zw-accent", "--dash-accent"],
  ["--zw-radius", "--ui-radius"],
] as const;

type Theme = { vars: Record<string, string>; dark: boolean };

function themeOf(el: HTMLElement | null, userVars: Record<string, string>): Theme {
  const vars: Record<string, string> = {};
  const root = getComputedStyle(document.documentElement);
  const local = el ? getComputedStyle(el) : root;
  for (const [mine, theirs] of THEME_VARS) {
    const v = (local.getPropertyValue(theirs) || root.getPropertyValue(theirs) || (mine === "--zw-sheet" ? root.getPropertyValue("--color-sheet") : "")).trim();
    if (/^[#a-zA-Z0-9(),.%\s/-]{1,80}$/.test(v)) vars[mine] = v;
  }
  for (const [k, v] of Object.entries(userVars)) if (/^--[a-z][a-z0-9-]{0,40}$/.test(k) && /^[#a-zA-Z0-9 .,%()+\-/*]{1,100}$/.test(v)) vars[k] = v;
  return { vars, dark: document.documentElement.dataset.theme === "dark" };
}

// Runs inside the iframe before the mod's own code.
const BRIDGE = `(function(){
var seq=0,pending={},handlers={};var init=__INIT__;
function call(kind,payload,ms){return new Promise(function(resolve,reject){var id=++seq;pending[id]={resolve:resolve,reject:reject};
parent.postMessage({zw:"call",id:id,kind:kind,payload:payload},"*");
setTimeout(function(){if(pending[id]){delete pending[id];reject(new Error("timeout"));}},ms||60000);});}
function applyTheme(t){if(!t||!t.vars)return;var s=document.documentElement.style;for(var k in t.vars){if(/^--[a-z][a-z0-9-]*$/.test(k))s.setProperty(k,String(t.vars[k]));}
window.zentico.theme={dark:!!t.dark};document.documentElement.style.colorScheme=t.dark?"dark":"light";}
function emit(ev,data){var l=(handlers[ev]||[]).slice();for(var i=0;i<l.length;i++){try{l[i](data);}catch(e){console.error(e);}}}
var clone=function(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v));};
window.zentico={mod:init.mod,config:init.config,locale:init.locale,theme:{dark:false},
query:function(n,a){return call("query",{name:String(n),args:a===undefined?{}:clone(a)});},
action:function(n,a){return call("action",{name:String(n),args:a===undefined?{}:clone(a)},300000);},
storage:{get:function(k){return call("storage",{op:"get",key:String(k)});},set:function(k,v){return call("storage",{op:"set",key:String(k),value:clone(v)});},
remove:function(k){return call("storage",{op:"remove",key:String(k)});},keys:function(){return call("storage",{op:"keys"});}},
on:function(ev,fn){if(typeof fn!=="function")return function(){};(handlers[ev]=handlers[ev]||[]).push(fn);return function(){handlers[ev]=(handlers[ev]||[]).filter(function(f){return f!==fn;});};},
ui:{toast:function(t){return call("ui",{op:"toast",text:String(t)});},openApp:function(x){return call("ui",{op:"open",target:String(x)});},
navigate:function(p){return call("ui",{op:"navigate",page:String(p)});},select:function(k,id,extra){return call("ui",{op:"select",kind:String(k),id:id==null?null:String(id),extra:clone(extra||{})});}},
claude:{ask:function(p){return call("claude",{prompt:String(p)},900000);}},
mcp:{listServers:function(){return call("mcp",{op:"servers"});},listTools:function(id){return call("mcp",{op:"tools",serverId:String(id)});},
call:function(id,tool,args){return call("mcp",{op:"call",serverId:String(id),tool:String(tool),args:clone(args||{})},300000);}}};
window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=="object")return;
if(d.zw==="result"&&pending[d.id]){var p=pending[d.id];delete pending[d.id];if(d.ok)p.resolve(d.data);else p.reject(new Error(String(d.error||"error")));}
else if(d.zw==="event"){if(d.name==="theme")applyTheme(d.data);if(d.name==="config")window.zentico.config=d.data;emit(d.name,d.name==="theme"?{dark:!!(d.data&&d.data.dark)}:d.data);}});
applyTheme(init.theme);
})();`;

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function buildDoc(html: string, init: unknown): string {
  // JSON inside <script>: "<" escaped so nothing can close the element.
  const esc = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;
  const json = JSON.stringify(init).replace(/[<\u2028\u2029]/g, (c) => esc(c.charCodeAt(0)));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:transparent;color:var(--zw-ink,#0a0a0a);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}a{color:var(--zw-accent,#3b6cf6)}</style>
<script>${BRIDGE.replace("__INIT__", () => json)}</script></head><body>${html}</body></html>`;
}

const LIMITS: Record<string, number> = { query: 60, action: 20, storage: 120, claude: 5, ui: 60, mcp: 30 };
const ARGS_MAX = 64 * 1024 + 2048;

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string; message?: string };
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

function Approval({ mod, onGranted }: { mod: ModView; onGranted: (v: UiView) => void }) {
  const t = useTranslations("dashboard.mods");
  const tp = useTranslations("dashboard.perms");
  const studio = useStudio();
  const missing = missingPerms(mod, studio.grantOf(mod.id));
  const [busy, setBusy] = useState(false);
  const label = (p: string) => (p.startsWith("mcp:") ? t("mcpScope", { scope: p.slice(4) }) : tp(p.replace(".", "_")));
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-4 text-center">
      <ShieldCheck size={20} aria-hidden className="text-[var(--dash-accent)]" />
      <div>
        <p className="text-[13.5px] font-medium text-ink">{t("wants", { name: mod.name })}</p>
        <ul className="mt-2 flex flex-col gap-1 text-left text-[12.5px] text-ink-soft">
          {missing.map((p) => (
            <li key={p} className="flex gap-2">
              <span aria-hidden>•</span>
              {label(p)}
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            onGranted((await post("/api/ui/mod", { modId: mod.id, op: "grant" })) as UiView);
          } catch (e) {
            studio.toast(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-60"
      >
        {t("enable")}
      </button>
    </div>
  );
}

export function ModFrame({ mod, instance, config, title }: { mod: ModView; instance: string; config: Record<string, unknown>; title: string }) {
  const t = useTranslations("dashboard.widget");
  const tm = useTranslations("dashboard.mods");
  const locale = useLocale();
  const studio = useStudio();
  const frame = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const loads = useRef(0);
  const hits = useRef<Record<string, number[]>>({});
  const servers = useRef<McpServerWithTools[] | null>(null);
  const [escaped, setEscaped] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(null);
  const studioRef = useRef(studio);
  studioRef.current = studio;

  const grant = studio.grantOf(mod.id);
  const waiting = missingPerms(mod, grant).length > 0;
  const perms = effectivePerms(mod, grant);
  const permsKey = perms.join(",");
  const merged = useMemo(() => ({ ...mod.config, ...config }), [mod.config, config]);
  const configKey = JSON.stringify(merged);

  useEffect(() => setTheme(themeOf(holder.current, studio.userVars)), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The document is rebuilt only when the mod's code or its granted permissions change.
  const srcDoc = useMemo(
    () =>
      theme && !waiting
        ? buildDoc(mod.html, { mod: { id: mod.id, instance, name: mod.name, version: mod.version, permissions: perms }, config: merged, locale, theme })
        : null,
    [mod.hash, theme == null, waiting, permsKey, instance, locale], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    loads.current = 0;
    setEscaped(false);
  }, [srcDoc]);

  const sendEvent = (name: string, data: unknown) => frame.current?.contentWindow?.postMessage({ zw: "event", name, data }, "*");

  // Theme changes (color scheme, theme.json).
  useEffect(() => {
    const push = () => sendEvent("theme", themeOf(holder.current, studioRef.current.userVars));
    push();
    const obs = new MutationObserver(push);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => obs.disconnect();
  }, [studio.dark, JSON.stringify(studio.userVars)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => sendEvent("config", merged), [configKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (studio.selection) sendEvent("selection", studio.selection);
  }, [studio.selection]);
  useEffect(
    () =>
      studio.subscribeLive((e) => {
        const need = MOD_EVENTS[e.category]?.permission;
        if (need && !perms.includes(need)) return;
        sendEvent(e.category, { kind: e.kind, title: e.title, body: e.body, ref: e.ref, at: e.at });
      }),
    [permsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => studio.subscribeCommand((c) => c.mod === mod.id && sendEvent("command", { id: c.command, args: c.args ?? null })), [mod.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!srcDoc) return;
    async function handle(kind: string, p: Record<string, unknown>): Promise<unknown> {
      const s = studioRef.current;
      const g = s.grantOf(mod.id);
      const allowed = effectivePerms(mod, g);
      const need = (perm: string | null | undefined) => {
        if (perm && !allowed.includes(perm as never)) throw new Error(`permission "${perm}" not granted (declare it in manifest.json)`);
      };
      const ask = async (key: string, title: string, detail: string) => {
        if (!(await s.confirm({ modId: mod.id, modName: mod.name, key, title, detail }))) throw new Error("denied");
      };
      switch (kind) {
        case "query": {
          const name = String(p.name);
          const spec = MOD_QUERIES[name];
          if (!spec) throw new Error(`Unknown query "${name}"`);
          need(spec.permission);
          return ((await post("/api/dashboard/query", { query: name, args: p.args ?? {}, timeZone: viewerTimeZone(), modId: mod.id })) as { data: unknown }).data;
        }
        case "action": {
          const name = String(p.name);
          const spec = MOD_ACTIONS[name];
          if (!spec) throw new Error(`Unknown action "${name}"`);
          need(spec.permission);
          await ask(name, tm(`actions.${name.replace(".", "_")}`), JSON.stringify(p.args ?? {}).slice(0, 400));
          return ((await post("/api/ui/action", { modId: mod.id, name, args: p.args ?? {}, timeZone: viewerTimeZone() })) as { data: unknown }).data;
        }
        case "storage": {
          const r = (await post("/api/ui/storage", { modId: mod.id, op: p.op, key: p.key, value: p.value })) as { value?: unknown; keys?: string[] };
          return p.op === "get" ? (r.value ?? null) : p.op === "keys" ? (r.keys ?? []) : undefined;
        }
        case "ui": {
          if (p.op === "toast") s.toast(`${mod.name}: ${String(p.text ?? "").slice(0, 200)}`);
          else if (p.op === "open") {
            const path = safePath(String(p.target ?? ""));
            if (!path) throw new Error("openApp takes an app name (mail, calendar, …) or a workspace path starting with /");
            s.openApp(path);
          } else if (p.op === "navigate") s.navigate(String(p.page ?? ""));
          else if (p.op === "select") {
            const k = String(p.kind);
            if (k !== "mail.thread" && k !== "chat.conversation" && k !== "drive.file") throw new Error('kind must be "mail.thread", "chat.conversation" or "drive.file"');
            const extra = (p.extra ?? {}) as Record<string, unknown>;
            const href = typeof extra.href === "string" ? safePath(extra.href) : null;
            s.select(p.id ? ({ kind: k, id: String(p.id).slice(0, 255), ...(href ? { href } : {}), ...(typeof extra.label === "string" ? { label: extra.label.slice(0, 200) } : {}) } as Selection) : null);
          }
          return null;
        }
        case "claude": {
          need("claude");
          const prompt = String(p.prompt ?? "").trim();
          if (!prompt) throw new Error("Empty prompt");
          await ask("claude", tm("askClaude"), prompt.slice(0, 400));
          const r = (await post("/api/ui/claude", { modId: mod.id, prompt, timeZone: viewerTimeZone() })) as { turn: { commandId: string | null } };
          if (!r.turn.commandId) throw new Error("Not sent");
          const done = await s.awaitTurn(r.turn.commandId);
          return { status: done.status, text: done.result ?? "" };
        }
        case "mcp": {
          need("mcp");
          const scopes = effectiveMcp(mod, g);
          try {
            servers.current = p.op === "servers" || !servers.current ? await listServers() : servers.current;
          } catch (e) {
            if (e instanceof UserMcpClientError && (e.status === 404 || e.code === "unreachable")) throw new Error("MCP servers not available");
            throw e;
          }
          const list = servers.current.filter((sv) => sv.enabled && mcpAllows(scopes, [sv.id, sv.slug], null));
          if (p.op === "servers") return list.map((sv) => ({ id: sv.id, slug: sv.slug, name: sv.name }));
          const server = list.find((sv) => sv.id === p.serverId || sv.slug === p.serverId);
          if (!server) throw new Error("Unknown or not allowed MCP server");
          const tools = server.tools.filter((tl) => tl.enabled && mcpAllows(scopes, [server.id, server.slug], tl.name));
          if (p.op === "tools") return tools.map((tl) => ({ name: tl.name, description: tl.description ?? "", readOnly: tl.access === "read" }));
          const tool = tools.find((tl) => tl.name === p.tool);
          if (!tool) throw new Error(`Tool "${String(p.tool)}" is outside this mod's MCP scopes`);
          const key = `mcp:${server.slug}/${tool.name}`;
          const readOnly = tool.access === "read";
          if (!readOnly) await ask(key, tm("mcpCall", { tool: tool.title || tool.name, server: server.name }), JSON.stringify(p.args ?? {}).slice(0, 400));
          const args = (p.args && typeof p.args === "object" ? p.args : {}) as Record<string, unknown>;
          try {
            return (await callTool(mod.id, server.id, tool.name, args)).result;
          } catch (e) {
            // The user already approved here: answer the server's consent with its token.
            if (e instanceof UserMcpClientError && e.code === "consent_required" && e.consent) {
              const always = !!s.grantOf(mod.id)?.always.includes(key);
              return (await callTool(mod.id, server.id, tool.name, args, { confirmToken: e.consent.confirmToken, remember: always ? "tool" : "once" })).result;
            }
            throw e;
          }
        }
        default:
          throw new Error("Unknown call");
      }
    }
    async function onMessage(e: MessageEvent) {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || loads.current > 1) return;
      const d = e.data as { zw?: unknown; id?: unknown; kind?: unknown; payload?: unknown } | null;
      if (!d || typeof d !== "object" || d.zw !== "call" || typeof d.id !== "number" || typeof d.kind !== "string") return;
      const reply = (msg: Record<string, unknown>) => {
        if (frame.current?.contentWindow === win && loads.current <= 1) win.postMessage({ zw: "result", id: d.id, ...msg }, "*");
      };
      const kind = d.kind;
      const now = Date.now();
      const list = (hits.current[kind] ?? []).filter((h) => now - h < 60_000);
      if (list.length >= (LIMITS[kind] ?? 30)) return reply({ ok: false, error: "rate_limited" });
      list.push(now);
      hits.current[kind] = list;
      let payload: Record<string, unknown>;
      try {
        const json = JSON.stringify(d.payload ?? {});
        if (json.length > ARGS_MAX) return reply({ ok: false, error: "Arguments too large" });
        payload = JSON.parse(json) as Record<string, unknown>;
      } catch {
        return reply({ ok: false, error: "Invalid arguments" });
      }
      try {
        const data = await handle(kind, payload);
        reply({ ok: true, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) });
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : "error" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [srcDoc, mod.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={holder} className="h-full w-full">
      {waiting ? (
        <Approval mod={mod} onGranted={(v) => studio.setView(v)} />
      ) : escaped ? (
        <div className="grid h-full place-items-center p-4 text-center text-[13px] text-ink-mute">
          <span className="flex flex-col items-center gap-2">
            <ShieldAlert size={18} aria-hidden className="text-amber" />
            {t("customEscaped")}
          </span>
        </div>
      ) : srcDoc ? (
        <iframe
          key={srcDoc}
          ref={frame}
          title={title}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-transparent"
          onLoad={() => {
            loads.current += 1;
            if (loads.current > 1) setEscaped(true);
            else if (studioRef.current.selection) sendEvent("selection", studioRef.current.selection);
          }}
        />
      ) : null}
    </div>
  );
}
