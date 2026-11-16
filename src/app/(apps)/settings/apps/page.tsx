import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { myApps } from "@/lib/chat/bots";
import { chatUser } from "@/lib/chat/session";
import { env } from "@/lib/env";
import { bridgeStatus } from "@/lib/mcp/agent";
import { AppsSettings, type AppView } from "./AppsSettings";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("apps.settings");
  return { title: t("title") };
}

export default async function AppsSettingsPage() {
  const me = await chatUser();
  const t = await getTranslations("apps.settings");
  const apps: AppView[] = myApps(me.id).map((b) => ({
    id: b.id,
    userId: b.userId,
    name: b.name,
    handle: b.handle,
    description: b.description,
    color: b.color,
    avatar: b.avatar,
    endpointUrl: b.endpointUrl ?? "",
    shared: b.shared,
    commands: b.commands ?? [],
    tokenPrefix: b.tokenPrefix,
    created: b.created,
  }));
  const bridge = bridgeStatus(me.email);
  return (
    <main className="sheet flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/chat" className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{t("title")}</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <AppsSettings apps={apps} appUrl={env.appUrl} me={{ id: me.id, name: me.name, email: me.email }} bridgeConnected={bridge.connected} />
      </div>
    </main>
  );
}
