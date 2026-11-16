// Server-sent events for the notification center: new/updated notifications, read markers and
// preference changes of the signed-in user only. While a stream is open it also keeps the user's
// new-mail watcher running (src/lib/notifications/mail-watch.ts). The stream ends itself before
// the access token expires; the browser reconnects and the middleware refreshes the token.
// In-process bus: single app instance (like /api/chat/events).
import { getSession } from "@/lib/auth";
import { watchMail } from "@/lib/notifications/mail-watch";
import { subscribe } from "@/lib/notifications/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;
const MAX_LIFETIME_MS = 25 * 60_000;
const MIN_LIFETIME_MS = 30_000;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const lifetime = Math.max(MIN_LIFETIME_MS, Math.min(MAX_LIFETIME_MS, session.expiresAt - Date.now() - 60_000));

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send("retry: 3000\n: connected\n\n");
      const unsubscribe = subscribe(session.email, (event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const release = watchMail(session.email, session.accessToken);
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      const end = setTimeout(() => cleanup(), lifetime);
      cleanup = () => {
        cleanup = () => {};
        clearInterval(heartbeat);
        clearTimeout(end);
        unsubscribe();
        release();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
