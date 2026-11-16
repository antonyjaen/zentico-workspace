import { getLocale } from "next-intl/server";
import { requireSession } from "@/lib/auth";
import { chatState } from "@/lib/dashboard/chat";
import { getDashboard, undoCount } from "@/lib/dashboard/store";
import { DashboardApp } from "./DashboardApp";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();
  const locale = await getLocale();
  const doc = getDashboard(session.email, locale);
  return <DashboardApp initialDoc={doc} initialChat={chatState(session)} initialUndo={undoCount(session.email)} />;
}
