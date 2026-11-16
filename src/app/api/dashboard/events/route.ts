// Server-Sent Events for the signed-in user's open dashboards (and rail apps):
//   event: ui      data: UiView     (on connect and after every change of the UI files or grants)
//   event: reload  data: {}         (ui_reload: re-sync with Drive now)
//   event: chat    data: ChatState  (on connect and whenever a turn, its progress, a pending
//                                    confirmation or the bridge status changes)
//   event: live    data: { category, kind, title, body, ref, at }  (new mail / chat / calendar
//                                    notifications, forwarded to mods that may read them)
// UI changes come from the in-process notifier (src/lib/dashboard/store.ts, single instance);
// command progress lives in the agent queue, so the chat state is re-checked every second.
import { getSession } from "@/lib/auth";
import { chatState } from "@/lib/dashboard/chat";
import { subscribe } from "@/lib/dashboard/store";
import { jsonError } from "@/lib/meetings/http";
import { subscribe as subscribeNotifications } from "@/lib/notifications/store";
import { viewOf } from "@/lib/ui/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICK_MS = 1000;
const IDLE_TICK_MS = 5000;
const PING_MS = 20_000;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  const encoder = new TextEncoder();

  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      const event = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

      let lastChat = "";
      let busy = false;
      let lastCheck = 0;
      const checkChat = (force = false) => {
        if (closed) return;
        const now = Date.now();
        // Fast while something runs, slower when idle (the bridge status still updates).
        if (!force && !busy && now - lastCheck < IDLE_TICK_MS) return;
        lastCheck = now;
        try {
          const state = chatState(session);
          busy = state.turns.some((t) => t.status === "queued" || t.status === "dispatched" || t.status === "needs_confirmation");
          const json = JSON.stringify(state);
          if (json !== lastChat) {
            lastChat = json;
            send(`event: chat\ndata: ${json}\n\n`);
          }
        } catch (e) {
          console.error("[dashboard] events:", e instanceof Error ? e.message : e);
        }
      };
      const sendUi = () => {
        try {
          event("ui", viewOf(session.email));
        } catch (e) {
          console.error("[dashboard] events ui:", e instanceof Error ? e.message : e);
        }
      };

      const unsubscribe = subscribe(session.email, (e) => {
        if (e.type === "ui") sendUi();
        else if (e.type === "reload") event("reload", {});
        else checkChat(true);
      });
      const unsubscribeLive = subscribeNotifications(session.email, (e) => {
        if (e.type !== "notification") return;
        const n = e.notification;
        if (n.category !== "mail" && n.category !== "chat" && n.category !== "calendar") return;
        event("live", { category: n.category, kind: n.kind, title: n.title, body: n.body, ref: n.ref, at: n.created });
      });
      const tick = setInterval(() => checkChat(), TICK_MS);
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);

      function stop() {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        clearInterval(ping);
        unsubscribe();
        unsubscribeLive();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      cleanup = stop;
      req.signal.addEventListener("abort", stop);

      send("retry: 3000\n\n");
      sendUi();
      checkChat(true);
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
