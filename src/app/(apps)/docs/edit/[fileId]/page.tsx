import { getLocale, getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { EditorWorkspace } from "./EditorFrame";
import { Notice } from "../../ui";
import { getRootId } from "@/lib/drive";
import { env } from "@/lib/env";
import {
  collaboraUrl,
  docKind,
  editorUrlFor,
  ID,
  mintWopiToken,
  userFiles,
  wopiIsLocal,
  wopiSrc,
  type FileNode,
} from "@/lib/wopi";

export const dynamic = "force-dynamic";

/** Public URL of this app when it isn't a loopback host (where the editor can work). */
function deployedUrl(): string | null {
  try {
    const u = new URL(env.appUrl);
    return /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(u.hostname) || u.hostname.endsWith(".localhost") ? null : u.origin;
  } catch {
    return null;
  }
}

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

  const shell = (node: FileNode | null, body: React.ReactNode, extra: Partial<Parameters<typeof EditorWorkspace>[0]> = {}) => (
    <EditorWorkspace
      file={node ? { id: node.id, name: node.name, kind: docKind(node.name) ?? "text" } : null}
      folderId={null}
      back={back}
      readOnly={false}
      {...extra}
    >
      {body}
    </EditorWorkspace>
  );

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

  // Drive folder for "Open in Drive": the top-level/home folder maps to /drive itself.
  let folderId = node.parentId;
  try {
    const rootId = await getRootId();
    if (folderId && folderId === rootId) folderId = null;
  } catch (e) {
    unstable_rethrow(e);
  }

  let editor: Awaited<ReturnType<typeof editorUrlFor>> = null;
  try {
    editor = await editorUrlFor(base, node.name);
  } catch (e) {
    unstable_rethrow(e);
    return shell(node, <Notice title={t("editorError")} />, { folderId });
  }
  if (!editor) return shell(node, <Notice title={t("unsupported")} hint={t("unsupportedHint")} />, { folderId });

  // Collabora calls WOPISrc server-to-server: a loopback host can never be reached from it.
  if (wopiIsLocal()) {
    const url = deployedUrl();
    return shell(
      node,
      <Notice
        title={t("localOnlyTitle")}
        hint={url ? t("localOnlyHintUrl", { url: url.replace(/^https?:\/\//, "") }) : t("localOnlyHint")}
      >
        {url && (
          <a
            href={`${url}/docs/edit/${encodeURIComponent(fileId)}`}
            className="mt-5 inline-flex h-9 items-center rounded-md bg-primary px-3 text-[13.5px] font-medium text-primary-ink transition-colors hover:bg-primary-hover"
          >
            {t("openDeployed")}
          </a>
        )}
      </Notice>,
      { folderId },
    );
  }

  const { token, ttl } = await mintWopiToken(fileId, user);
  const locale = await getLocale();
  const action =
    editor.url + new URLSearchParams({ WOPISrc: wopiSrc(fileId), lang: locale, closebutton: "1" }).toString();

  return shell(node, null, {
    folderId,
    readOnly: !editor.canEdit,
    frame: { action, origin: new URL(base).origin, token, ttl, title: t("editorTitle", { name: node.name }) },
  });
}
