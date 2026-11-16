import { ArrowLeft } from "lucide-react";
import { getLocale } from "next-intl/server";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { recentAudit } from "@/lib/mcp/db";
import { listTools } from "@/lib/mcp/tools";
import { copyFor } from "./copy";
import { IntegrationsClient, type AuditView, type ToolView } from "./IntegrationsClient";
import { claudeStatus } from "./status";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const session = await requireSession();
  const locale = await getLocale();
  const c = copyFor(locale);

  const audit: AuditView[] = recentAudit(session.sub, 20).map((a) => ({
    id: a.id,
    tokenName: a.tokenName,
    tool: a.tool,
    at: a.at,
    ok: a.ok,
    error: a.error,
  }));
  const tools: ToolView[] = listTools("write").map((t) => ({ name: t.name, write: !t.annotations.readOnlyHint }));

  return (
    <main className="sheet flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link href="/mail" className="icon-btn h-9 w-9" aria-label={c.back} title={c.back}>
          <ArrowLeft size={17} aria-hidden />
        </Link>
        <h1 className="text-[15px] font-medium text-ink">{c.title}</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <IntegrationsClient
          locale={locale}
          endpoint={`${env.appUrl}/api/mcp`}
          appUrl={env.appUrl}
          tools={tools}
          initial={claudeStatus(session)}
          audit={audit}
        />
      </div>
    </main>
  );
}
