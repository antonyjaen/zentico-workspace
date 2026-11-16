"use client";

// Custom widget: HTML/CSS/JS authored by the user's Claude, rendered in a sandboxed iframe
// (srcdoc, sandbox="allow-scripts" WITHOUT allow-same-origin → opaque origin, no cookies or
// storage of the workspace) with a CSP that blocks every network request. It can only read data
// through `zentico.query(name, args)`: a postMessage to this page, which checks the sender is
// this very iframe, allows only the read-only DATA_QUERIES and answers with plain JSON. No token
// or cookie ever reaches the iframe.
// A sandboxed frame can still navigate itself (CSP can't prevent that), which could carry data
// out in a URL: after any navigation away from the srcdoc the bridge goes silent and the widget is
// replaced by a notice.
import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { isDataQuery } from "./model";
import { fetchQuery } from "./widgets";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

const THEME_VARS = [
  ["--zw-ink", "--color-ink"],
  ["--zw-ink-soft", "--color-ink-soft"],
  ["--zw-ink-mute", "--color-ink-mute"],
  ["--zw-line", "--color-line"],
  ["--zw-sheet", "--color-sheet"],
  ["--zw-sheet-muted", "--color-sheet-muted"],
  ["--zw-accent", "--dash-accent"],
] as const;

function themeOf(el: HTMLElement | null): { vars: Record<string, string>; dark: boolean } {
  const vars: Record<string, string> = {};
  const root = getComputedStyle(document.documentElement);
  const local = el ? getComputedStyle(el) : root;
  for (const [mine, theirs] of THEME_VARS) {
    const v = (local.getPropertyValue(theirs) || root.getPropertyValue(theirs)).trim();
    // Only plain color values go into the iframe's stylesheet.
    if (/^[#a-zA-Z0-9(),.%\s-]{1,64}$/.test(v)) vars[mine] = v;
  }
  return { vars, dark: document.documentElement.dataset.theme === "dark" || root.colorScheme === "dark" };
}

// Runs inside the iframe before the widget's own code.
const BRIDGE = `(function(){
var seq=0,pending={};
function applyTheme(t){if(!t||!t.vars)return;var s=document.documentElement.style;for(var k in t.vars){if(/^--zw-[a-z-]+$/.test(k))s.setProperty(k,String(t.vars[k]));}window.zentico.theme={dark:!!t.dark};document.documentElement.style.colorScheme=t.dark?"dark":"light";}
window.zentico={theme:{dark:false},query:function(name,args){return new Promise(function(resolve,reject){var id=++seq;pending[id]={resolve:resolve,reject:reject};
parent.postMessage({zw:"query",id:id,name:String(name),args:args===undefined?{}:args},"*");
setTimeout(function(){if(pending[id]){delete pending[id];reject(new Error("timeout"));}},30000);});}};
window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=="object")return;
if(d.zw==="result"&&pending[d.id]){var p=pending[d.id];delete pending[d.id];if(d.ok)p.resolve(d.data);else p.reject(new Error(String(d.error||"error")));}
else if(d.zw==="theme"){applyTheme(d);}});
applyTheme(__THEME__);
})();`;

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function buildDoc(html: string, theme: { vars: Record<string, string>; dark: boolean }): string {
  // JSON inside <script>: "<" escaped so nothing can close the element.
  const themeJson = JSON.stringify(theme).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:transparent;color:var(--zw-ink,#0a0a0a);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}a{color:var(--zw-accent,#3b6cf6)}</style>
<script>${BRIDGE.replace("__THEME__", themeJson)}</script></head><body>${html}</body></html>`;
}

/** Max queries per widget per minute (a custom widget polling every few seconds still fits). */
const QUERY_LIMIT = 30;
const ARGS_MAX = 4096;

export function CustomWidget({ html, title }: { html: string; title: string }) {
  const t = useTranslations("dashboard.widget");
  const frame = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const loads = useRef(0);
  const hits = useRef<number[]>([]);
  const [escaped, setEscaped] = useState(false);
  const [theme, setTheme] = useState<{ vars: Record<string, string>; dark: boolean } | null>(null);

  // The theme is read once per HTML (srcdoc), then pushed on changes over postMessage.
  useEffect(() => setTheme(themeOf(holder.current)), []);
  const srcDoc = useMemo(() => (theme ? buildDoc(html, theme) : null), [html, theme == null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loads.current = 0;
    setEscaped(false);
  }, [srcDoc]);

  useEffect(() => {
    const push = () => frame.current?.contentWindow?.postMessage({ zw: "theme", ...themeOf(holder.current) }, "*");
    const obs = new MutationObserver(push);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", push);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", push);
    };
  }, []);

  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || escaped) return;
      const d = e.data as { zw?: unknown; id?: unknown; name?: unknown; args?: unknown } | null;
      if (!d || typeof d !== "object" || d.zw !== "query" || typeof d.id !== "number") return;
      const reply = (msg: Record<string, unknown>) => win.postMessage({ zw: "result", id: d.id, ...msg }, "*");
      const now = Date.now();
      hits.current = hits.current.filter((h) => now - h < 60_000);
      if (hits.current.length >= QUERY_LIMIT) return reply({ ok: false, error: "rate_limited" });
      hits.current.push(now);
      if (!isDataQuery(d.name)) return reply({ ok: false, error: "Unknown query" });
      let args: unknown;
      try {
        const json = JSON.stringify(d.args ?? {});
        if (json.length > ARGS_MAX) return reply({ ok: false, error: "Arguments too large" });
        args = JSON.parse(json);
      } catch {
        return reply({ ok: false, error: "Invalid arguments" });
      }
      try {
        const data = await fetchQuery(d.name, args);
        // The frame may have navigated meanwhile: answer only the same document.
        if (frame.current?.contentWindow === win && loads.current <= 1) reply({ ok: true, data });
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : "error" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [escaped]);

  return (
    <div ref={holder} className="h-full w-full">
      {escaped ? (
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
          // allow-forms: without it the browser drops submit events, so form-based mods can't react
          // to Enter/submit. form-action 'none' in the CSP still blocks any real submission.
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-full w-full border-0 bg-transparent"
          onLoad={() => {
            loads.current += 1;
            if (loads.current > 1) setEscaped(true);
          }}
        />
      ) : null}
    </div>
  );
}
