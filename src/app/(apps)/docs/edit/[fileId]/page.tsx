import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { EditorFrame } from "./EditorFrame";
import { KIND_ICON, Notice } from "../../ui";
import {
  collaboraUrl,
  docKind,
  editorUrlFor,
  ID,
  mintWopiToken,
  userFiles,
  wopiSrc,
  type FileNode,
} from "@/lib/wopi";

export const dynamic = "force-dynamic";

export default async function EditDocPage({
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
  const base = collaboraUrl();

  const shell = (title: string | null, body: React.ReactNode, readOnly = false) => {
    const Icon = KIND_ICON[(title && docKind(title)) || "text"];
    return (
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
          <Link
            href={back.href}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            aria-label={`${t("back")}: ${back.label}`}
          >
            <ArrowLeft size={16} aria-hidden />
            <span className="hidden sm:inline">{back.label}</span>
          </Link>
          {title && (
            <>
              <span aria-hidden className="h-5 w-px bg-line" />
              <Icon size={16} aria-hidden className="ml-1 shrink-0" style={{ color: "var(--color-app-docs)" }} />
              <h1 className="min-w-0 truncate text-[14px] font-medium text-ink">{title}</h1>
              {readOnly && (
                <span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-mute">
                  {t("readOnly")}
                </span>
              )}
            </>
          )}
        </div>
        {body}
      </main>
    );
  };

  if (!base) return shell(null, <Notice title={t("notConfigured")} hint={t("notConfiguredHint")} />);
  if (!ID.test(fileId)) return shell(null, <Notice title={t("notFound")} />);

  const user = await userFiles();
  if (!user) return shell(null, <Notice title={t("notFound")} />);

  let node: FileNode | null = null;
  try {
    node = await user.client.getNode(fileId);
  } catch (e) {
    unstable_rethrow(e);
    return shell(null, <Notice title={t("unavailable")} hint={t("unavailableHint")} />);
  }
  if (!node || !node.blobId) return shell(null, <Notice title={t("notFound")} />);

  let editor: Awaited<ReturnType<typeof editorUrlFor>> = null;
  try {
    editor = await editorUrlFor(base, node.name);
  } catch (e) {
    unstable_rethrow(e);
    return shell(node.name, <Notice title={t("editorError")} />);
  }
  if (!editor) return shell(node.name, <Notice title={t("unsupported")} />);

  const { token, ttl } = await mintWopiToken(fileId, user);
  const locale = await getLocale();
  const action =
    editor.url +
    new URLSearchParams({ WOPISrc: wopiSrc(fileId), lang: locale, closebutton: "1" }).toString();

  return shell(
    node.name,
    <EditorFrame
      action={action}
      origin={new URL(base).origin}
      token={token}
      ttl={ttl}
      backHref={back.href}
      title={t("editorTitle", { name: node.name })}
    />,
    !editor.canEdit,
  );
}
