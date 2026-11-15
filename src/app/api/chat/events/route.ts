// Server-sent events for Chat: new/edited/deleted messages, reactions, typing, read markers and
// conversation list changes for the signed-in user. Fed by the in-process bus in
// src/lib/chat/events.ts, so it only works with a single app instance (our deployment).
import { jsonError } from "@/lib/chat/http";
import { subscribe } from "@/lib/chat/events";
import { chatUserOrNull } from "@/lib/chat/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  const me = await chatUserOrNull();
  if (!me) return jsonError("unauthorized", 401);

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
      const unsubscribe = subscribe(me.id, (event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
        cleanup = () => {};
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
