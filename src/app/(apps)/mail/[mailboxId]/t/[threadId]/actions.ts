"use server";

// Thread-reader actions that reach beyond mail: saving an attachment into Drive.
import { CAP, jmap, JmapError, primaryAccount } from "@/lib/jmap";
import { BLOB_ID, cleanFileName, MIME } from "@/lib/mail-read";

const FILENODE = "urn:ietf:params:jmap:filenode";
const USING = [CAP.core, FILENODE];

type Node = { id?: string; parentId?: string | null; name?: string | null; role?: string | null };
type SetError = { type?: string; description?: string };

/**
 * Creates a Drive file (in the root folder) that points at an attachment's blob — no copy of the
 * bytes goes through the app. Stalwart requires `@type` and calls the MIME type `mediaType`;
 * explicit nulls are rejected, so only set fields are sent.
 */
export async function saveAttachmentToDrive(input: {
  blobId: string;
  name: string;
  type: string;
}): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    if (!input || typeof input.blobId !== "string" || !BLOB_ID.test(input.blobId)) return { ok: false, error: "Invalid attachment" };
    const name = cleanFileName(typeof input.name === "string" ? input.name.normalize("NFC") : null);
    const type = typeof input.type === "string" && MIME.test(input.type) ? input.type.toLowerCase() : null;

    const accountId = await primaryAccount(FILENODE).catch(() => primaryAccount(CAP.mail));
    const r = await jmap([["FileNode/get", { accountId, ids: null, properties: ["id", "parentId", "name", "role"] }, "g"]], USING);
    const nodes = (r.g.list as Node[] | undefined) ?? [];
    // Some servers expose a single top-level home folder; it is then the effective root.
    const root = nodes.find((n) => n.parentId == null && (n.role === "root" || n.role === "home"))?.id ?? null;
    const taken = new Set(
      nodes.filter((n) => (n.parentId ?? null) === root && n.name).map((n) => n.name!.toLowerCase()),
    );

    const node: Record<string, unknown> = { "@type": "File", name: uniqueName(name, taken), blobId: input.blobId };
    if (type) node.mediaType = type;
    if (root) node.parentId = root;

    const s = await jmap([["FileNode/set", { accountId, create: { f: node } }, "s"]], USING);
    const err = (s.s.notCreated as Record<string, SetError> | null | undefined)?.f;
    if (err || !(s.s.created as Record<string, unknown> | undefined)?.f) {
      console.error("[mail] save to Drive rejected:", JSON.stringify(err ?? s.s));
      return { ok: false, error: err?.description || err?.type || "Drive rejected the file" };
    }
    return { ok: true, name: node.name as string };
  } catch (e) {
    console.error("[mail] save to Drive:", e instanceof Error ? e.message : e);
    return { ok: false, error: e instanceof JmapError ? e.message : "Drive is not available" };
  }
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}
