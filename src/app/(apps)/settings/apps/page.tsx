import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { myApps } from "@/lib/chat/bots";
import { allProviders, callbackUrl, isConfigured } from "@/lib/connect/providers";
import { listConnections } from "@/lib/connect/store";
import { chatUser } from "@/lib/chat/session";
import { env } from "@/lib/env";
import { bridgeStatus } from "@/lib/mcp/agent";
import { AppsSettings, type AppView } from "./AppsSettings";
import { ConnectedApps, type ConnectedAppView } from "./ConnectedApps";
import { McpServers, type McpServerView } from "./McpServers";
import { listServers as listMcpServers, summary as mcpSummary, toolInfo as mcpToolInfo } from "@/lib/user-mcp/store";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("apps.settings");
  return { title: t("title") };
}

const param = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 40) : undefined);

export default async function AppsSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await chatUser();
  const session = await requireSession();
  const q = await searchParams;
  const connections = listConnections(session.sub);
  const connectedApps: ConnectedAppView[] = allProviders().map((p) => {
    const c = connections.find((x) => x.provider === p.id);
    return {
      id: p.id,
      name: p.name,
      configured: isConfigured(p.id),
      callbackUrl: callbackUrl(p.id),
      envPrefix: p.envPrefix,
      scopes: p.scopes,
      revocable: p.revocable,
      manageUrl: p.manageUrl ?? null,
      connection: c
        ? {
            accountName: c.accountName,
            accountLogin: c.accountLogin,
            avatarUrl: c.avatarUrl,
            detail: c.meta.siteName || c.meta.team || c.meta.workspace || null,
            status: c.status,
            lastUsed: c.lastUsed,
          }
        : null,
    };
  });
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
  const mcpServers: McpServerView[] = listMcpServers(session.sub).map((r) => ({
    ...mcpSummary(r),
    tools: (r.catalog ?? []).map((tool) => mcpToolInfo(r, tool)),
    lastUsed: r.lastUsed,
  }));
  return (
    <main className="sheet flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/chat" className="icon-btn h-9 w-9" aria-label={t("back")} title={t("back")}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{t("title")}</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <AppsSettings apps={apps} appUrl={env.appUrl} me={{ id: me.id, name: me.name, email: me.email }} bridgeConnected={bridge.connected}
          connectedApps={
            <>
              <ConnectedApps apps={connectedApps} result={{ connected: param(q.connected), error: param(q.connectError), provider: param(q.provider) }} />
              <McpServers servers={mcpServers} result={{ connected: param(q.mcpConnected), error: param(q.mcpError), server: param(q.mcpServer) }} />
            </>
          }
        />
      </div>
    </main>
  );
}
