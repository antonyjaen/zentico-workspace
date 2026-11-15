"use server";

// Docs mutations. Form input is untrusted: the kind is checked against a fixed list.
import { getTranslations } from "next-intl/server";
import { redirect, unstable_rethrow } from "next/navigation";
import { userFiles, type DocKind } from "@/lib/wopi";

const KINDS: DocKind[] = ["text", "spreadsheet", "presentation"];

/** Creates an empty document in the Drive root and opens it in the editor. */
export async function createDocument(fd: FormData) {
  const kind = fd.get("kind");
  if (typeof kind !== "string" || !KINDS.includes(kind as DocKind)) redirect("/docs?error=create");
  const user = await userFiles();
  if (!user) redirect("/signin?returnTo=/docs");
  const t = await getTranslations("docs");

  let id: string | null = null;
  try {
    id = await user.client.createEmpty(kind as DocKind, t(`untitled.${kind as DocKind}`));
  } catch (e) {
    unstable_rethrow(e);
  }
  redirect(id ? `/docs/edit/${encodeURIComponent(id)}` : "/docs?error=create");
}
