import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "zw_locale";

/** Per-feature message files (messages/<feature>/<locale>.json), merged over the base file. */
const FEATURES = ["mailRead", "compose", "mailActions", "mailSettings", "calendar", "contacts", "drive", "docs", "meet", "chat", "notifications", "dashboard", "apps", "security", "tasks"] as const;

type Tree = { [key: string]: unknown };
const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: two features may add keys under the same namespace (e.g. "apps") without wiping each other. */
function merge(target: Tree, source: Tree): Tree {
  for (const [k, v] of Object.entries(source)) target[k] = isTree(v) && isTree(target[k]) ? merge({ ...(target[k] as Tree) }, v) : v;
  return target;
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
  return {
    locale,
    messages: [(await import(`../../messages/${locale}.json`)).default as Tree, ...(parts as Tree[])].reduce((acc, m) => merge(acc, m), {} as Tree),
  };
});
