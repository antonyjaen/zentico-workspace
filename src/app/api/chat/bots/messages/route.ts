// App API: an HTTP app posts asynchronously with its own token.
//   POST /api/chat/bots/messages   Authorization: Bearer zwbot_…
//   { "conversationId": "…", "text"?: "…", "cards"?: […] | "cardsV2"?: […], "threadRoot"?: <message id> }
// Only into conversations the app is a member of. 60 posts per minute per app; 32 KB per request.
// Not behind the session middleware.
import { appByToken, rateLimiter } from "@/lib/chat/bots";
import { json, messageSummary, readJson } from "@/lib/chat/bot-http";
import { CardError, parseBotMessage } from "@/lib/chat/cards";
import { ChatError, postBotMessage } from "@/lib/chat/store";
import { isConversationId } from "@/app/(apps)/chat/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed = rateLimiter(60, 60_000);

const unauthorized = () => json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="zentico-chat-apps"' });

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "";
  const app = appByToken(token);
  if (!app) return unauthorized();
  if (!allowed(app.id)) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });

  const body = await readJson(req);
  if (!body.ok) return body.res;
  const input = (body.value ?? {}) as { conversationId?: unknown; threadRoot?: unknown };
  if (!isConversationId(input.conversationId)) return json({ error: "invalid_conversation" }, 400);
  const threadRoot = input.threadRoot == null ? null : input.threadRoot;
  if (threadRoot !== null && (typeof threadRoot !== "number" || !Number.isSafeInteger(threadRoot) || threadRoot <= 0)) {
    return json({ error: "invalid_thread" }, 400);
  }
  let message;
  try {
    message = parseBotMessage(body.value);
  } catch (e) {
    return json({ error: e instanceof CardError ? e.message : "invalid" }, 400);
  }
  try {
    const posted = postBotMessage(input.conversationId, app.userId, { ...message, threadRoot });
    return json({ ok: true, message: messageSummary(posted) });
  } catch (e) {
    if (e instanceof ChatError) {
      // Unknown conversation and "not a member" look the same from outside.
      if (e.message === "notFound" || e.message === "notMember") return json({ error: "not_found" }, 404);
      return json({ error: e.message }, 400);
    }
    console.error("[bots] post failed:", e instanceof Error ? e.message : e);
    return json({ error: "failed" }, 500);
  }
}
