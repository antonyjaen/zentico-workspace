import { Clock } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { activePage } from "@/lib/booking/service";
import { HANDLE, publicView, SLUG } from "@/lib/booking/types";
import { BookingWidget, LOCATION_ICON } from "../../_ui/BookingWidget";
import { Shell } from "../../_ui/Shell";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ handle: string; slug: string }> };

function load(handle: string, slug: string) {
  return HANDLE.test(handle) && SLUG.test(slug) ? activePage(handle, slug) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, slug } = await params;
  const page = load(handle, slug);
  return { title: page ? `${page.type.title} · ${page.host.name}` : "Zentico", robots: { index: false, follow: false } };
}

export default async function BookingPage({ params }: Params) {
  const { handle, slug } = await params;
  const page = load(handle, slug);
  if (!page) notFound();
  const t = await getTranslations("booking.public");
  const type = publicView(page.type);
  const Icon = LOCATION_ICON[type.location];

  return (
    <Shell wide>
      <div className="sheet rise grid overflow-hidden md:grid-cols-[280px_1fr]">
        <aside className="border-b border-line p-5 md:border-r md:border-b-0">
          <p className="text-[13px] text-ink-soft">{page.host.name}</p>
          {page.host.showEmail && <p className="text-[12.5px] text-ink-mute">{page.host.email}</p>}
          <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em]">{type.title}</h1>
          <ul className="mt-4 flex flex-col gap-2 text-[13.5px] text-ink-soft">
            <li className="flex items-center gap-2">
              <Clock size={15} aria-hidden className="shrink-0" />
              {type.durations.map((d) => t("minutes", { n: d })).join(" · ")}
            </li>
            <li className="flex items-start gap-2">
              <Icon size={15} aria-hidden className="mt-0.5 shrink-0" />
              <span>{type.locationText || t(`location.${type.location}`)}</span>
            </li>
          </ul>
          {type.description && <p className="mt-4 text-[14px] leading-relaxed whitespace-pre-line text-ink-soft">{type.description}</p>}
        </aside>
        <div className="p-5">
          <BookingWidget mode={{ kind: "book", handle, slug }} type={type} />
        </div>
      </div>
    </Shell>
  );
}
