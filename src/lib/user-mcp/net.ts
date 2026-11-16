// A fetch() for user-supplied MCP server URLs without SSRF: https only, no credentials in the URL,
// and the host is resolved inside the socket's own DNS lookup with every address checked against
// private/loopback/link-local/reserved ranges (lib/chat/safe-http), so the checked address is the
// one connected to. Redirects are never followed here: a 3xx is returned as is and the MCP SDK only
// follows same-origin ones, which come back through this function and are checked again.
// Responses stream (SSE needs that) with a hard byte cap. Server-only.
import { lookup as dnsLookup } from "node:dns";
import { request, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import { checkEndpointUrl, isBlockedAddress, UnsafeUrlError } from "../chat/safe-http";
import { UserMcpError } from "./errors";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Time allowed until response headers arrive. */
const HEADERS_TIMEOUT_MS = 30_000;
/** Hard cap on any single response body (tool results are capped much lower later). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Static checks for an MCP server URL (at save time and before each request). */
export function checkServerUrl(raw: string): URL {
  try {
    const u = checkEndpointUrl(raw);
    u.hash = "";
    return u;
  } catch (e) {
    throw new UserMcpError("unsafe_url", e instanceof UnsafeUrlError ? `URL not allowed: ${e.message}` : "URL not allowed");
  }
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family as number | undefined }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (addresses ?? []).filter((a) => a.family === 4 || a.family === 6);
    if (!list.length) return callback(new UnsafeUrlError("no address"), "", 0);
    if (list.some((a) => isBlockedAddress(a.address))) return callback(new UnsafeUrlError("resolves to a private address"), "", 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

async function bodyBytes(body: RequestInit["body"], headers: Headers): Promise<Buffer | null> {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return Buffer.from(body.toString(), "utf8");
  }
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new UserMcpError("failed", "unsupported request body");
}

/** SSRF-safe fetch for MCP traffic (MCP endpoints, OAuth metadata, token and registration endpoints). */
export const safeFetch: FetchLike = async (input, init = {}) => {
  const url = checkServerUrl(typeof input === "string" ? input : input.toString());
  const headers = new Headers(init.headers);
  const body = await bodyBytes(init.body, headers);
  if (body && body.length > MAX_REQUEST_BYTES) throw new UserMcpError("invalid_args", "request too large");
  headers.delete("host");
  headers.delete("cookie");
  if (!headers.has("user-agent")) headers.set("user-agent", "Zentico-Workspace-MCP/1.0");
  if (body) headers.set("content-length", String(body.length));
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortError();

  const outHeaders: Record<string, string> = {};
  headers.forEach((v, k) => (outHeaders[k] = v));
  const options: RequestOptions = {
    method: (init.method ?? "GET").toUpperCase(),
    headers: outHeaders,
    lookup: safeLookup,
    // No proxies or keep-alive pools shared with other code.
    agent: false,
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request(url, options, (res) => {
      const status = res.statusCode ?? 0;
      const respHeaders = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        const k = res.rawHeaders[i];
        if (k.toLowerCase() === "set-cookie") continue;
        try {
          respHeaders.append(k, res.rawHeaders[i + 1]);
        } catch {
          // invalid header from upstream: drop it
        }
      }
      if (status < 200 || status > 599) {
        res.destroy();
        return finish(() => reject(new UserMcpError("upstream_error", `unexpected HTTP status ${status}`)));
      }
      const noBody = status === 204 || status === 205 || status === 304 || options.method === "HEAD";
      if (noBody) {
        res.resume();
        return finish(() => resolve(new Response(null, { status, headers: respHeaders })));
      }
      let size = 0;
      const capped = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) return cb(new UserMcpError("upstream_error", "response too large"));
          cb(null, chunk);
        },
      });
      res.on("error", (e) => capped.destroy(e));
      res.pipe(capped);
      const onAbort = () => {
        res.destroy();
        capped.destroy(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      capped.on("close", () => signal?.removeEventListener("abort", onAbort));
      const web = Readable.toWeb(capped) as unknown as ReadableStream<Uint8Array>;
      finish(() => resolve(new Response(web, { status, headers: respHeaders })));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new UserMcpError("timeout", "the MCP server took too long to answer")));
    }, HEADERS_TIMEOUT_MS);
    const onAbort = () => {
      req.destroy();
      finish(() => reject(abortError()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.on("error", (e) =>
      finish(() =>
        reject(
          e instanceof UnsafeUrlError
            ? new UserMcpError("unsafe_url", `URL not allowed: ${e.message}`)
            : e instanceof UserMcpError
              ? e
              : new UserMcpError("unreachable", "the MCP server could not be reached"),
        ),
      ),
    );
    req.end(body ?? undefined);
  });
};
