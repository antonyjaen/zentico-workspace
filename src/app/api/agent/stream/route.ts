// Server-Sent Events stream for tools/zentico-bridge.mjs, authenticated with the user's MCP access
// token (Authorization: Bearer). It only ever carries that user's own commands:
//   event: hello    data: {"user":{"email","name"},"scope":"read"|"write","mcpUrl","serverTime","agentName"}
//   event: command  data: BridgeCommand (src/lib/meetings/claude-commands.ts)
//   event: cancel   data: {"id"}
//   : ping          (comment, every 15 s)
// Commands are claimed atomically when sent, so with several bridges each command runs once.
// The bridge says which agent it runs in X-Zentico-Bridge ("zentico-bridge/1.3.0 codex (host)"); it is
// stored as bridges.client, which names the assistant until the user picks a name.
import { env } from "@/lib/env";
import { bridgePayload } from "@/lib/meetings/claude-commands";
import { agentNameFor, bridgeConnected, bridgeSeen, claimQueued, onWake, statusesOf } from "@/lib/mcp/agent";
import { bearerOf, verifyToken } from "@/lib/mcp/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICK_MS = 1500;
const PING_MS = 15_000;
const REVERIFY_MS = 60_000;

export async function GET(req: Request) {
  const row = verifyToken(bearerOf(req));
  if (!row) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="zentico-agent"' } });
  }
  const email = row.userEmail;
  const client = (req.headers.get("x-zentico-bridge") ?? "").replace(/[^\w .:/@()+-]/g, "").slice(0, 120);
  const appUrl = env.appUrl;
  const encoder = new TextEncoder();

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const inFlight = new Set<string>();
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      const event = (name: string, data: unknown) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

      const pump = () => {
        if (closed) return;
        try {
          for (const c of claimQueued(email, row.id)) {
            inFlight.add(c.id);
            event("command", bridgePayload(c, appUrl));
          }
          if (inFlight.size) {
            const statuses = statusesOf(email, [...inFlight]);
            for (const id of [...inFlight]) {
              const st = statuses.get(id);
              if (st === "cancelled") event("cancel", { id });
              if (!st || st === "cancelled" || st === "done" || st === "failed") inFlight.delete(id);
            }
          }
        } catch (e) {
          console.error("[agent] stream:", e instanceof Error ? e.message : e);
        }
      };

      const disconnected = bridgeConnected(email, row.id, client);
      const unsubscribe = onWake(email, () => setTimeout(pump, 0));
      let lastVerify = Date.now();
      const tick = setInterval(pump, TICK_MS);
      const ping = setInterval(() => {
        send(": ping\n\n");
        bridgeSeen(email);
        // A revoked or expired token ends the stream.
        if (Date.now() - lastVerify > REVERIFY_MS) {
          lastVerify = Date.now();
          const again = verifyToken(bearerOf(req));
          if (!again || again.id !== row.id) stop();
        }
      }, PING_MS);

      function stop() {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        clearInterval(ping);
        unsubscribe();
        disconnected();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      cleanup = stop;
      req.signal.addEventListener("abort", stop);

      send("retry: 5000\n\n");
      event("hello", {
        user: { email: row.userEmail, name: row.userName || row.userEmail },
        scope: row.scope,
        mcpUrl: `${appUrl}/api/mcp`,
        serverTime: new Date().toISOString(),
        // The wake word the bridge logs ("waiting for \"Codex, …\""); bridgeConnected() stored its agent first.
        agentName: agentNameFor(email, "en"),
      });
      pump();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
