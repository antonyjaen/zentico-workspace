import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { MarkdownEditor } from "./MarkdownEditor";
import { loadNativeDoc } from "../../native";
import { MD_VIEW_COOKIE, type MdView } from "../../shared";

export const dynamic = "force-dynamic";

export default async function MarkdownPage({
  params,
  searchParams,
}: {
  params: Promise<{ fileId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { fileId } = await params;
  const { from } = await searchParams;
  const t = await getTranslations("docs");
  const back = from === "drive" ? { href: "/drive", label: t("backToDrive") } : { href: "/docs", label: t("backToDocs") };
  const saved = (await cookies()).get(MD_VIEW_COOKIE)?.value;
  const view: MdView = saved === "edit" || saved === "preview" ? saved : "split";

  const r = await loadNativeDoc(fileId, "markdown");
  if (!r.ok) {
    const notice =
      r.error === "too_large"
        ? { title: t("nativeTooLarge"), hint: t("unsupportedHint") }
        : r.error === "unavailable"
          ? { title: t("unavailable"), hint: t("unavailableHint") }
          : r.error === "wrong_kind"
            ? { title: t("unsupported"), hint: t("unsupportedHint") }
            : { title: t("notFound") };
    return <MarkdownEditor doc={null} back={back} notice={notice} initialView={view} />;
  }
  return <MarkdownEditor doc={r.doc} back={back} initialView={view} />;
}
