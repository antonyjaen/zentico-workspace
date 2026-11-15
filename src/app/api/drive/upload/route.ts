import { NextResponse, type NextRequest } from "next/server";
import { guessType } from "@/app/(apps)/drive/shared";
import { getSession } from "@/lib/auth";
import { createFile, DriveError, getNode, MAX_UPLOAD_BYTES, MIME, resolveAccount, uploadStream, validId, validName } from "@/lib/drive";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Drive upload proxy: streams the raw file body to the JMAP upload endpoint with the user's
 * token (which never reaches the browser), then creates the FileNode.
 * Query: ?name=<file name>&parentId=<folder id, optional>&account=<account id, optional>.
 * Body: file bytes.
 */
export async function POST(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin && origin !== new URL(env.appUrl).origin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams;
  const name = validName(q.get("name"));
  if (!name) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  const rawParent = q.get("parentId");
  const parentId = rawParent ? rawParent : null;
  if (parentId !== null && !validId(parentId)) return NextResponse.json({ error: "invalid_parent" }, { status: 400 });
  const rawAccount = q.get("account") || null;
  if (rawAccount !== null && !validId(rawAccount)) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const lengthHeader = req.headers.get("content-length");
  const declared = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (declared != null && declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const rawType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const type = guessType(name, MIME.test(rawType) ? rawType : null);

  try {
    const account = await resolveAccount(rawAccount);
    if (parentId) {
      const parent = await getNode(parentId, account.id);
      if (!parent?.isFolder) return NextResponse.json({ error: "invalid_parent" }, { status: 400 });
      if (!parent.rights.mayAddChildren) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = req.body && declared !== 0 ? req.body : new ArrayBuffer(0);
    const blob = await uploadStream(body, type, declared, { accountId: account.id });
    const node = await createFile(parentId, name, { ...blob, type }, account.id);
    return NextResponse.json({
      item: {
        id: node.id,
        parentId,
        name: node.name,
        isFolder: false,
        type: node.type,
        size: node.size,
        modified: node.modified,
      },
    });
  } catch (e) {
    if (e instanceof DriveError && e.code === "too_large") return NextResponse.json({ error: "too_large" }, { status: 413 });
    if (e instanceof DriveError && e.code === "truncated") return NextResponse.json({ error: "truncated" }, { status: 413 });
    if (e instanceof DriveError && e.code === "unavailable") return NextResponse.json({ error: "unavailable" }, { status: 503 });
    if (e instanceof DriveError && e.code === "not_found") return NextResponse.json({ error: "invalid" }, { status: 400 });
    if (e instanceof DriveError && e.code === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    console.error("[drive] upload route:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }
}
