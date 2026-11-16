// /dashboard and /dashboard/<pageId>: the user's Zentico UI pages. The server syncs the UI with
// the user's `Zentico UI/` Drive folder first (creating it on first use, migrating a classic
// dashboard); if Drive is unreachable the last stored UI is shown and the page keeps polling.
import { getLocale } from "next-intl/server";
import { requireSession } from "@/lib/auth";
import { chatState } from "@/lib/dashboard/chat";
import { syncUi, viewOf } from "@/lib/ui/service";
import type { UiView } from "@/lib/ui/schema";
import { Studio } from "../Studio";

export const dynamic = "force-dynamic";

async function loadView(email: string, run: () => Promise<UiView>): Promise<UiView> {
  try {
    return await run();
  } catch (e) {
    console.error("[ui] sync:", e instanceof Error ? e.message : e);
    return viewOf(email);
  }
}

export default async function DashboardPage({ params }: { params: Promise<{ page?: string[] }> }) {
  const session = await requireSession();
  const locale = await getLocale();
  const { page } = await params;
  const view = await loadView(session.email, () => syncUi(session, { locale }));
  return <Studio initialView={view} initialChat={chatState(session)} mode="dashboard" pageId={page?.[0] ?? null} />;
}
