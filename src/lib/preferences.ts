"use server";

import { cookies } from "next/headers";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@/i18n/request";
import { THEME_COOKIE, type Theme } from "./theme";

const YEAR = 60 * 60 * 24 * 365;

export async function setTheme(theme: Theme) {
  if (!["light", "dark", "system"].includes(theme)) return;
  (await cookies()).set(THEME_COOKIE, theme, { path: "/", maxAge: YEAR, sameSite: "lax" });
}

export async function setLocale(locale: Locale) {
  if (!LOCALES.includes(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: YEAR, sameSite: "lax" });
}
