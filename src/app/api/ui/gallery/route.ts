// The workspace gallery of Zentico UI pages and mods, plus the built-in recommended library.
// GET → { recommended: [...], items: [...] }   (each with a layout preview and the permissions it asks)
// POST { action: "publish", kind: "page" | "mod", id, name, description }   copies one of your pages
//        (with the mods it uses) or a mod into the shared gallery
//      { action: "install", id, grant? }   copies a gallery item into your `Zentico UI/` folder
//        (pages get a new id, clashing mods a new name; grant = approve its permissions now)
//      { action: "remove", id }            removes an item you published
import { getLocale } from "next-intl/server";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { failure, gate, jsonError, limited, NO_STORE } from "@/lib/ui/http";
import { checkUi, isIconName, MOD_ID, PAGE_ID, requestedGrants, utf8Bytes } from "@/lib/ui/schema";
import { addMod, addPage, exportMod, exportPage } from "@/lib/ui/service";
import { APP_TEMPLATES, catalog, modFiles, TEMPLATES } from "@/lib/ui/starter";
import { addGalleryItem, countInstall, getGalleryItem, listGallery, removeGalleryItem, type GalleryPayload } from "@/lib/ui/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Raw = Record<string, unknown>;

/** Permissions + MCP scopes the given mod files request (compiled with the real validator). */
function grantsOf(mods: Record<string, Record<string, string>>): string[] {
  const texts: Record<string, string> = {};
  for (const [id, files] of Object.entries(mods)) for (const [n, t] of Object.entries(files)) texts[`mods/${id}/${n}`] = t;
  const r = checkUi({ ...texts, "ui.json": '{"pages":[{"id":"x","title":"x","layout":{"type":"component","component":"clock"}}]}' });
  return [...new Set(Object.values(r.ui?.mods ?? {}).flatMap((m) => requestedGrants(m)))];
}

const modsOf = (ids: string[]) => {
  const out: Record<string, Record<string, string>> = {};
  for (const [p, t] of Object.entries(modFiles(ids))) {
    const [, id, n] = p.split("/");
    (out[id] ??= {})[n] = t;
  }
  return out;
};

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const locale = await getLocale();
  const l = locale === "en" ? "en" : "es";
  const pages = new Map([...TEMPLATES, ...APP_TEMPLATES].map((t) => [t.id, t.page(l)]));
  const recommended = catalog(locale).map((e) => {
    const page = pages.get(e.id) as Raw | undefined;
    return { ...e, official: true, preview: page?.layout ?? null, app: page?.app ?? null, permissions: grantsOf(modsOf(e.mods)) };
  });
  const items = listGallery().map((it) => {
    const full = getGalleryItem(it.id);
    return { ...it, mine: it.author.email === session.email.toLowerCase(), preview: (full?.payload.page?.layout as unknown) ?? null };
  });
  return NextResponse.json({ recommended, items }, { headers: NO_STORE });
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

export async function POST(req: NextRequest) {
  const g = await gate(req, 8 * 1024);
  if ("response" in g) return g.response;
  const { session, body } = g;
  if (limited(`ui-gallery:${session.email.toLowerCase()}`, 20)) return jsonError("rate_limited", 429);
  const locale = await getLocale();
  try {
    switch (body.action) {
      case "publish": {
        const name = clean(body.name, 60);
        const description = clean(body.description, 400);
        if (!name) return jsonError("invalid", 400);
        let payload: GalleryPayload;
        let icon: string | null = null;
        if (body.kind === "page") {
          if (typeof body.id !== "string" || !PAGE_ID.test(body.id)) return jsonError("invalid", 400);
          const { page, mods } = await exportPage(session, body.id);
          payload = { page, mods };
          icon = isIconName(page.icon) ? page.icon : null;
        } else if (body.kind === "mod") {
          if (typeof body.id !== "string" || !MOD_ID.test(body.id)) return jsonError("invalid", 400);
          payload = { mods: { [body.id]: await exportMod(session, body.id) } };
        } else return jsonError("invalid", 400);
        if (utf8Bytes(JSON.stringify(payload)) > 1024 * 1024) return NextResponse.json({ error: "too_large", message: "Larger than 1 MB" }, { status: 413, headers: NO_STORE });
        const item = addGalleryItem({
          kind: body.kind,
          name,
          description,
          icon,
          author: { email: session.email, name: session.name || session.email },
          permissions: grantsOf(payload.mods),
          payload,
        });
        return NextResponse.json({ item }, { headers: NO_STORE });
      }
      case "install": {
        const item = typeof body.id === "string" ? getGalleryItem(body.id) : null;
        if (!item) return jsonError("not_found", 404);
        const grant = body.grant === true;
        if (item.kind === "page" && item.payload.page) {
          const r = await addPage(session, item.payload.page, item.payload.mods, { reason: `install ${item.name}`, locale, grantMods: grant });
          countInstall(item.id);
          return NextResponse.json({ ...r.view, pageId: r.pageId }, { headers: NO_STORE });
        }
        const [id, files] = Object.entries(item.payload.mods)[0] ?? [];
        if (!id) return jsonError("invalid", 400);
        const r = await addMod(session, id, files, { locale, grant });
        countInstall(item.id);
        return NextResponse.json({ ...r.view, modId: r.modId }, { headers: NO_STORE });
      }
      case "remove": {
        if (typeof body.id !== "string" || !removeGalleryItem(body.id, session.email)) return jsonError("not_found", 404);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      default:
        return jsonError("invalid", 400);
    }
  } catch (e) {
    return failure(e, "gallery");
  }
}
