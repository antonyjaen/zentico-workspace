import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { genericAgentName } from "@/lib/meetings/wake";

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "zw_locale";

/** Per-feature message files (messages/<feature>/<locale>.json), merged over the base file. */
const FEATURES = ["mailRead", "compose", "mailActions", "mailSettings", "calendar", "contacts", "drive", "docs", "meet", "chat", "notifications", "dashboard", "apps", "security", "tasks", "booking", "downloads", "calendarSync"] as const;

type Tree = { [key: string]: unknown };
const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: two features may add keys under the same namespace (e.g. "apps") without wiping each other. */
function merge(target: Tree, source: Tree): Tree {
  for (const [k, v] of Object.entries(source)) target[k] = isTree(v) && isTree(target[k]) ? merge({ ...(target[k] as Tree) }, v) : v;
  return target;
}

/**
 * The assistant's name goes into every message that mentions it ("Ask {agent}", "My {agent}"): the
 * user's chosen name, else the agent their bridge runs ("Codex"), else "Assistant" / "Asistente".
 * Substituted here so no t() call has to pass it. Cached per locale + name (few distinct names).
 */
const withAgentCache = new Map<string, Tree>();

function withAgent(tree: Tree, name: string): Tree {
  const out: Tree = {};
  for (const [k, v] of Object.entries(tree)) {
    out[k] = typeof v === "string" ? (v.includes("{agent}") ? v.split("{agent}").join(name) : v) : isTree(v) ? withAgent(v, name) : v;
  }
  return out;
}

async function agentName(locale: Locale): Promise<string> {
  try {
    const session = await getSession();
    if (session) return (await import("@/lib/mcp/agent")).agentNameFor(session.email, locale);
  } catch (e) {
    console.error("[i18n] agent name:", e instanceof Error ? e.message : e);
  }
  return genericAgentName(locale);
}

function pick(value: string | undefined): Locale | undefined {
  return LOCALES.find((l) => value?.toLowerCase().startsWith(l));
}

export default getRequestConfig(async () => {
  const fromCookie = pick((await cookies()).get(LOCALE_COOKIE)?.value);
  const fromHeader = pick((await headers()).get("accept-language")?.split(",")[0]);
  const locale: Locale = fromCookie ?? fromHeader ?? "es";
  const parts = await Promise.all(
    FEATURES.map(async (f) => (await import(`../../messages/${f}/${locale}.json`)).default),
  );
  const name = await agentName(locale);
  const key = `${locale}|${name}`;
  // Dev keeps editing the JSON files: no cache there.
  let messages = process.env.NODE_ENV === "production" ? withAgentCache.get(key) : undefined;
  if (!messages) {
    const merged = [(await import(`../../messages/${locale}.json`)).default as Tree, ...(parts as Tree[])].reduce((acc, m) => merge(acc, m), {} as Tree);
    messages = withAgent(merged, name);
    if (withAgentCache.size > 200) withAgentCache.clear();
    withAgentCache.set(key, messages);
  }
  return { locale, messages };
});
