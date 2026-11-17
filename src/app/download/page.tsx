import { Apple, Download, Monitor, Smartphone } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";
import { Wordmark } from "@/components/Logo";
import { availableDownloads, platformFromUA, type AvailableDownload, type Platform } from "@/lib/downloads";

export const metadata: Metadata = { title: "Download" };
export const dynamic = "force-dynamic";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export default async function DownloadPage() {
  const t = await getTranslations("downloads");
  const files = await availableDownloads();
  const mine = platformFromUA((await headers()).get("user-agent"));
  // The configured public host (APP_URL), not whatever Host header reached the container.
  let host = (await headers()).get("host") ?? "";
  try {
    if (process.env.APP_URL) host = new URL(process.env.APP_URL).host;
  } catch {}

  const platforms: { id: Platform; icon: typeof Monitor; label: string }[] = [
    { id: "windows", icon: Monitor, label: "Windows" },
    { id: "android", icon: Smartphone, label: "Android" },
    { id: "mac", icon: Apple, label: "macOS" },
    { id: "ios", icon: Apple, label: "iPhone / iPad" },
  ];
  // The visitor's platform first.
  platforms.sort((a, b) => Number(b.id === mine) - Number(a.id === mine));

  const link = (f: AvailableDownload, primary: boolean) => (
    <a
      key={f.name}
      href={`/download/${f.name}`}
      download
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-[14px] font-medium transition-colors ${
        primary ? "bg-primary text-primary-ink hover:bg-primary-hover" : "border border-line-strong text-ink hover:bg-hover"
      }`}
    >
      <Download size={16} aria-hidden />
      {t(`kind.${f.kind}`)} <span className="text-[12.5px] opacity-70">· {mb(f.size)}</span>
    </a>
  );

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div className="grid-canvas pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative w-full max-w-[560px]">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <section className="sheet p-6 sm:p-8">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">{t("title")}</h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{t("body", { host })}</p>

          <ul className="mt-6 space-y-3">
            {platforms.map(({ id, icon: Icon, label }) => {
              const mineFiles = files.filter((f) => f.platform === id);
              return (
                <li key={id} className={`rounded-xl border p-4 ${id === mine ? "border-primary/50 bg-primary-soft" : "border-line"}`}>
                  <div className="flex items-center gap-2">
                    <Icon size={18} className="text-ink-soft" aria-hidden />
                    <span className="text-[15px] font-medium text-ink">{label}</span>
                    {id === mine && <span className="ml-auto text-[12px] text-ink-mute">{t("yourDevice")}</span>}
                  </div>
                  {mineFiles.length ? (
                    <>
                      <div className="mt-3 flex flex-wrap gap-2">{mineFiles.map((f, i) => link(f, i === 0))}</div>
                      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">{t(`note.${id}`)}</p>
                    </>
                  ) : (
                    <p className="mt-2 text-[13px] text-ink-mute">{t("soon")}</p>
                  )}
                </li>
              );
            })}
          </ul>

          <p className="mt-6 text-center text-[13px] text-ink-mute">
            <Link href="/" className="underline underline-offset-2 hover:text-ink">
              {t("back")}
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
