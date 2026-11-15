import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { THEME_COOKIE, type Theme } from "@/lib/theme";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: { default: t("title"), template: `%s · ${t("title")}` }, description: t("description") };
}

// Resolves "system" before paint so there is no light/dark flash.
const themeScript = `(function(){try{var d=document.documentElement;if(d.dataset.theme==="system"){d.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}}catch(e){}})()`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const theme = ((await cookies()).get(THEME_COOKIE)?.value as Theme | undefined) ?? "system";

  return (
    <html
      lang={locale}
      data-theme={theme}
      data-theme-pref={theme}
      className={`${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
