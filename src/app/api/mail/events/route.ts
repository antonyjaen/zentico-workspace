// Server-sent events proxy for JMAP push (RFC 8620 §7.3): the browser subscribes here and we
// relay Stalwart's EventSource stream for Email/Mailbox changes, so the token never leaves us.
import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function eventSourceUrl(token: string): Promise<string> {
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`JMAP session failed: ${res.status}`);
  const { eventSourceUrl: template } = (await res.json()) as { eventSourceUrl?: string };
  if (!template) throw new Error("No eventSourceUrl in JMAP session");
  const url = new URL(
    template
      .replace(/\{types\}|%7Btypes%7D/gi, "Email,Mailbox")
      .replace(/\{closeafter\}|%7Bcloseafter%7D/gi, "no")
      .replace(/\{ping\}|%7Bping%7D/gi, "30"),
  );
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Bad eventSourceUrl");
  return url.toString();
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const upstreamAbort = new AbortController();
  req.signal.addEventListener("abort", () => upstreamAbort.abort());

  let upstream: Response;
  try {
    upstream = await fetch(await eventSourceUrl(session.accessToken), {
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: "text/event-stream" },
      cache: "no-store",
      signal: upstreamAbort.signal,
    });
  } catch {
    return new Response("Upstream unavailable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    upstreamAbort.abort();
    return new Response("Upstream unavailable", { status: upstream.status === 401 ? 401 : 502 });
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Opens the stream on the client right away and sets its reconnect delay.
      controller.enqueue(encoder.encode("retry: 5000\n: connected\n\n"));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // Upstream dropped or the client went away; the browser reconnects.
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      upstreamAbort.abort();
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
