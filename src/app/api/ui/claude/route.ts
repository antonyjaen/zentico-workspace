// zentico.agent.ask (or its older name zentico.claude.ask) from a mod: POST { modId, prompt, timeZone? } → { turn }. Needs the mod's
// "claude" permission (declared and granted) and a confirmation in the dashboard. The request goes
// to the user's own Claude like a message typed in the Dashboard's Claude panel (where it shows
// up, labelled with the mod's name); write tools Claude calls still wait for the user's approval.
import { NextResponse, type NextRequest } from "next/server";
import { CHAT_TEXT_MAX } from "@/app/(apps)/dashboard/model";
import { cleanChatText, sendDashboardMessage } from "@/lib/dashboard/commands";
import { cleanTimeZone, hasWriteToken } from "@/lib/meetings/claude-commands";
import { failure, gate, jsonError, limited, modContext, NO_STORE } from "@/lib/ui/http";
import { recordModAsk } from "@/lib/ui/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const g = await gate(req, 16 * 1024);
  if ("response" in g) return g.response;
  const { session, body } = g;
  const ctx = modContext(session.email, body.modId);
  if ("error" in ctx) return jsonError("not_found", 404);
  if (!ctx.perms.includes("claude")) return NextResponse.json({ error: "forbidden", message: 'Needs the "claude" permission' }, { status: 403, headers: NO_STORE });
  if (limited(`ui-claude:${session.email.toLowerCase()}:${ctx.mod.id}`, 5)) return jsonError("rate_limited", 429);
  const prompt = cleanChatText(typeof body.prompt === "string" ? body.prompt.slice(0, CHAT_TEXT_MAX) : "");
  if (!prompt) return jsonError("invalid", 400);
  if (!hasWriteToken(session.sub)) return jsonError("no_token", 412);
  try {
    const turn = sendDashboardMessage(session, `[${ctx.mod.name}] ${prompt}`.slice(0, CHAT_TEXT_MAX), cleanTimeZone(body.timeZone));
    if (turn.commandId) recordModAsk(session.email, turn.commandId, ctx.mod.id, ctx.mod.name);
    return NextResponse.json({ turn }, { headers: NO_STORE });
  } catch (e) {
    return failure(e, "claude");
  }
}
