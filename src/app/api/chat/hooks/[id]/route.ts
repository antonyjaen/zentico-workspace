// Incoming webhook (Google Chat style): POST /api/chat/hooks/<id>?key=<secret>
//   { "text": "…", "cards"?: […] | "cardsV2"?: […], "thread"?: { "key": "…" } }
// posts as the webhook's identity into its conversation. Messages with the same thread key (also
// `thread.threadKey` or ?threadKey=) go into the same thread. The key is stored hashed; 60 posts
// per minute per webhook; 32 KB per request. Not behind the session middleware.
import { rememberWebhookThread, rateLimiter, webhookByKey, webhookThreadRoot } from "@/lib/chat/bots";
import { json, messageSummary, readJson } from "@/lib/chat/bot-http";
import { CardError, parseBotMessage } from "@/lib/chat/cards";
import { ChatError, postBotMessage } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed = rateLimiter(60, 60_000);
const THREAD_KEY = /^[\w.:@-]{1,64}$/;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const hook = webhookByKey(id, url.searchParams.get("key") ?? "");
  if (!hook || !hook.conversationId) return json({ error: "not_found" }, 404);
  if (!allowed(hook.id)) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });

  const body = await readJson(req);
  if (!body.ok) return body.res;
  let message;
  try {
    message = parseBotMessage(body.value);
  } catch (e) {
    return json({ error: e instanceof CardError ? e.message : "invalid" }, 400);
  }

  const thread = (body.value as { thread?: { key?: unknown; threadKey?: unknown } }).thread;
  const rawKey = thread?.key ?? thread?.threadKey ?? url.searchParams.get("threadKey");
  if (rawKey != null && (typeof rawKey !== "string" || !THREAD_KEY.test(rawKey))) return json({ error: "invalid_thread_key" }, 400);
  const key = typeof rawKey === "string" ? rawKey : null;
  const root = key ? webhookThreadRoot(hook.id, key) : null;

  try {
    const posted = postBotMessage(hook.conversationId, hook.userId, { ...message, threadRoot: root });
    if (key && root === null) rememberWebhookThread(hook.id, key, posted.id);
    return json({ ok: true, message: messageSummary(posted) });
  } catch (e) {
    if (e instanceof ChatError) return json({ error: e.message }, e.message === "notFound" ? 404 : 400);
    console.error("[hooks] post failed:", e instanceof Error ? e.message : e);
    return json({ error: "failed" }, 500);
  }
}
