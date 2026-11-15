import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "zw_locale";

function pick(value: string | undefined): Locale | undefined {
  return LOCALES.find((l) => value?.toLowerCase().startsWith(l));
}

export default getRequestConfig(async () => {
  const fromCookie = pick((await cookies()).get(LOCALE_COOKIE)?.value);
  const fromHeader = pick((await headers()).get("accept-language")?.split(",")[0]);
  const locale: Locale = fromCookie ?? fromHeader ?? "es";
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
