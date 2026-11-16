// /x/<appId>[/<sectionId>]: a Zentico UI page the user turned into its own rail app (ui.json
// pages[].app), full height without the dashboard chrome, with optional sub-pages.
import { getLocale } from "next-intl/server";
import { requireSession } from "@/lib/auth";
import { chatState } from "@/lib/dashboard/chat";
import { syncUi, viewOf } from "@/lib/ui/service";
import { Studio } from "../../../dashboard/Studio";

export const dynamic = "force-dynamic";

export default async function UiAppPage({ params }: { params: Promise<{ app: string; section?: string[] }> }) {
  const session = await requireSession();
  const locale = await getLocale();
  const { app, section } = await params;
  let view;
  try {
    view = await syncUi(session, { locale });
  } catch (e) {
    console.error("[ui] sync:", e instanceof Error ? e.message : e);
    view = viewOf(session.email);
  }
  return <Studio initialView={view} initialChat={chatState(session)} mode="app" appId={app} sectionId={section?.[0] ?? null} />;
}
