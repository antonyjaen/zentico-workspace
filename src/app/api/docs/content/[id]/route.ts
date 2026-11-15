// Saves the content of a whiteboard (.excalidraw) or Markdown (.md) file edited in the built-in
// Docs editors. Used for debounced autosave (fetch) and for the last save before the page unloads
// (navigator.sendBeacon, which sends text/plain). The editor is decided by the stored file's name,
// never by the request, and the body is validated before it replaces the file's content.
import { NextResponse, type NextRequest } from "next/server";
import { MAX_NATIVE_BYTES, NATIVE, nativeKind } from "@/app/(apps)/docs/shared";
import { getSession } from "@/lib/auth";
import { DriveError, getNode, replaceContent, validId } from "@/lib/drive";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Same-origin requests only: the body may arrive as text/plain (a CORS "simple" request). */
function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (!origin) return site === "same-origin";
  return origin === req.nextUrl.origin || origin === new URL(env.appUrl).origin;
}

async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let n = 0;
  for (const c of chunks) {
    out.set(c, n);
    n += c.byteLength;
  }
  return out;
}

/** A serialized Excalidraw scene: { type: "excalidraw", elements: [...], ... }. */
function isScene(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.type !== "excalidraw" || !Array.isArray(o.elements)) return false;
  if (o.appState != null && (typeof o.appState !== "object" || Array.isArray(o.appState))) return false;
  if (o.files != null && (typeof o.files !== "object" || Array.isArray(o.files))) return false;
  return o.elements.every((e) => !!e && typeof e === "object" && !Array.isArray(e) && typeof (e as { type?: unknown }).type === "string");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return json({ error: "unauthorized" }, 401);
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);

  const { id } = await params;
  if (!validId(id)) return json({ error: "invalid" }, 400);

  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > MAX_NATIVE_BYTES) {
    return json({ error: "too_large" }, 413);
  }

  try {
    // Built-in editors only open files in the user's own drive (like Docs).
    const node = await getNode(id);
    if (!node || node.isFolder || !node.blobId) return json({ error: "not_found" }, 404);
    const kind = nativeKind(node.name);
    if (!kind) return json({ error: "invalid" }, 400);
    if (!node.rights.mayModifyContent) return json({ error: "forbidden" }, 403);

    const bytes = await readLimited(req.body, MAX_NATIVE_BYTES);
    if (!bytes) return json({ error: "too_large" }, 413);

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return json({ error: "invalid" }, 400);
    }
    if (kind === "whiteboard") {
      let scene: unknown;
      try {
        scene = JSON.parse(text);
      } catch {
        return json({ error: "invalid" }, 400);
      }
      if (!isScene(scene)) return json({ error: "invalid" }, 400);
    }

    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const next = await replaceContent(id, buf, NATIVE[kind].mediaType);
    return json({ ok: true, size: next.size, modified: next.modified });
  } catch (e) {
    if (e instanceof DriveError) {
      const status = e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "too_large" ? 413 : e.code === "invalid" ? 400 : 502;
      return json({ error: e.code }, status);
    }
    console.error("[docs] save content:", e instanceof Error ? e.message : e);
    return json({ error: "failed" }, 502);
  }
}
