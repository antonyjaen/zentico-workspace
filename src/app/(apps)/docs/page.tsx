import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { DocsHome } from "./DocsHome";
import { toDocs } from "./list";
import { VIEW_COOKIE, type DocItem } from "./shared";
import { Notice } from "./ui";
import { getAllNodes, getDriveSession, getRootId, getTrashId } from "@/lib/drive";
import { collaboraUrl, supportedExts } from "@/lib/wopi";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  const t = await getTranslations("docs");
  const base = collaboraUrl();

  if (!base) {
    return (
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
        <Notice title={t("notConfigured")} hint={t("notConfiguredHint")} />
      </main>
    );
  }

  const view = (await cookies()).get(VIEW_COOKIE)?.value === "grid" ? "grid" : "list";

  let docs: DocItem[] | null = null;
  try {
    if (await getDriveSession()) {
      const [all, rootId, trashId, supported] = await Promise.all([
        getAllNodes(),
        getRootId(),
        getTrashId(),
        // Discovery tells which extensions this Collabora opens; if it's unreachable, list everything.
        supportedExts(base).catch(() => null),
      ]);
      docs = toDocs(all, rootId, trashId, supported);
    }
  } catch (e) {
    unstable_rethrow(e);
    console.error("[docs] page:", e instanceof Error ? e.message : e);
  }

  if (!docs) {
    return (
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
        <Notice title={t("unavailable")} hint={t("unavailableHint")} />
      </main>
    );
  }

  return <DocsHome docs={docs} initialView={view} />;
}
