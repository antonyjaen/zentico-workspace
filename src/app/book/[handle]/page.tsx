import { ChevronRight, Clock } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listTypes } from "@/lib/booking/db";
import { activeHost } from "@/lib/booking/service";
import { bookingPath, HANDLE } from "@/lib/booking/types";
import { Shell } from "../_ui/Shell";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ handle: string }> };

const load = (handle: string) => (HANDLE.test(handle) ? activeHost(handle) : null);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const host = load((await params).handle);
  return { title: host?.name || "Zentico", robots: { index: false, follow: false } };
}

/** /book/<handle>: the owner's active booking pages. */
export default async function HostPage({ params }: Params) {
  const { handle } = await params;
  const host = load(handle);
  if (!host) notFound();
  const t = await getTranslations("booking.public");
  const types = listTypes(host.sub).filter((x) => x.active);

  return (
    <Shell>
      <section className="sheet rise p-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{host.name}</h1>
        {host.showEmail && <p className="text-[13px] text-ink-mute">{host.email}</p>}
        <p className="mt-2 text-[14px] text-ink-soft">{t("pickType")}</p>
        {types.length === 0 ? (
          <p className="mt-6 text-[14px] text-ink-mute">{t("noPages")}</p>
        ) : (
          <ul className="mt-5 flex flex-col gap-2">
            {types.map((x) => (
              <li key={x.id}>
                <Link
                  href={bookingPath(host.handle, x.slug)}
                  className="group flex items-center gap-3 rounded-lg border border-line p-4 transition-colors hover:border-ink"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-ink">{x.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-soft">
                      <Clock size={13} aria-hidden /> {x.durations.map((d) => t("minutes", { n: d })).join(" · ")}
                    </span>
                    {x.description && <span className="mt-1 line-clamp-2 block text-[13px] text-ink-mute">{x.description}</span>}
                  </span>
                  <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-mute group-hover:text-ink" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
