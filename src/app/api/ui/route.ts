// The signed-in user's Zentico UI (files in Drive → what the Dashboard renders).
// GET ?sync=1 (look for Drive changes) | ?force=1 (re-read and re-validate) → UiView
// POST { action: "patch", baseSig, ops: PointerOp[] }   edits ui.json (validated before writing)
//      { action: "undo" } | { action: "reset" }        file history / default files
//      { action: "restore" }                           "Restore default UI": theme + shell back to defaults (backed up, undoable)
//      { action: "preset", id }                         a workspace theme preset as theme.json
//      { action: "template", id, grant? }              adds a recommended layout as a new page
//      { action: "reload" }                            tells every open dashboard to re-sync
import { getLocale } from "next-intl/server";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { publish } from "@/lib/dashboard/store";
import { failure, gate, jsonError, limited, NO_STORE } from "@/lib/ui/http";
import type { PointerOp } from "@/lib/ui/schema";
import { applyTemplate, applyThemePreset, patchUi, resetUi, restoreDefaultUi, syncUi, undoUi, viewOf } from "@/lib/ui/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const sp = req.nextUrl.searchParams;
  try {
    if (sp.get("sync") || sp.get("force")) {
      if (limited(`ui-sync:${session.email.toLowerCase()}`, 30)) return NextResponse.json(viewOf(session.email), { headers: NO_STORE });
      return NextResponse.json(await syncUi(session, { force: !!sp.get("force"), locale: await getLocale() }), { headers: NO_STORE });
    }
    return NextResponse.json(viewOf(session.email), { headers: NO_STORE });
  } catch (e) {
    return failure(e, "sync");
  }
}

const OPS = new Set(["set", "remove", "insert"]);

export async function POST(req: NextRequest) {
  const g = await gate(req, 256 * 1024);
  if ("response" in g) return g.response;
  const { session, body } = g;
  if (limited(`ui-edit:${session.email.toLowerCase()}`, 60)) return jsonError("rate_limited", 429);
  const locale = await getLocale();
  try {
    switch (body.action) {
      case "patch": {
        const ops = body.ops;
        if (!Array.isArray(ops) || !ops.length || ops.length > 60) return jsonError("invalid", 400);
        for (const op of ops) {
          if (!op || typeof op !== "object" || !OPS.has((op as PointerOp).op) || typeof (op as PointerOp).pointer !== "string") return jsonError("invalid", 400);
        }
        const view = await patchUi(session, typeof body.baseSig === "string" ? body.baseSig : null, ops as PointerOp[], locale);
        return NextResponse.json(view, { headers: NO_STORE });
      }
      case "undo": {
        const view = await undoUi(session, locale);
        if (!view) return jsonError("nothing_to_undo", 409);
        return NextResponse.json(view, { headers: NO_STORE });
      }
      case "restore":
        return NextResponse.json(await restoreDefaultUi(session, locale), { headers: NO_STORE });
      case "preset":
        if (typeof body.id !== "string" || body.id.length > 40) return jsonError("invalid", 400);
        return NextResponse.json(await applyThemePreset(session, body.id, locale), { headers: NO_STORE });
      case "reset":
        return NextResponse.json(await resetUi(session, locale), { headers: NO_STORE });
      case "template": {
        if (typeof body.id !== "string") return jsonError("invalid", 400);
        const r = await applyTemplate(session, body.id, locale, body.grant === true);
        return NextResponse.json({ ...r.view, pageId: r.pageId }, { headers: NO_STORE });
      }
      case "reload":
        publish(session.email, { type: "reload" });
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      default:
        return jsonError("invalid", 400);
    }
  } catch (e) {
    return failure(e, String(body.action));
  }
}
