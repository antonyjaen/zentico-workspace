import { getTranslations } from "next-intl/server";
import { Whiteboard } from "./Whiteboard";
import { loadNativeDoc } from "../../native";

export const dynamic = "force-dynamic";

export default async function DrawPage({
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

  const r = await loadNativeDoc(fileId, "whiteboard");
  if (!r.ok) {
    const notice =
      r.error === "too_large"
        ? { title: t("nativeTooLarge"), hint: t("unsupportedHint") }
        : r.error === "unavailable"
          ? { title: t("unavailable"), hint: t("unavailableHint") }
          : r.error === "wrong_kind"
            ? { title: t("unsupported"), hint: t("unsupportedHint") }
            : { title: t("notFound") };
    return <Whiteboard doc={null} back={back} notice={notice} />;
  }
  return <Whiteboard doc={r.doc} back={back} />;
}
