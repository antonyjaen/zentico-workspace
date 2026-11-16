// Server-side HTTP to OAuth providers. Every URL must be https on one of the provider's fixed
// hosts (no user-supplied hosts reach here, but the allowlist keeps it that way), redirects are
// refused, requests time out and responses are capped. Nothing here logs URLs with secrets,
// headers or bodies. Server-only.

export class ProviderError extends Error {
  /** Stable code, safe to show (e.g. "unauthorized", "notFound", "rateLimited", "failed"). */
  code: string;
  status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type ProviderResponse = { status: number; headers: Headers; text: string };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export async function providerFetch(
  rawUrl: string,
  {
    method = "GET",
    headers = {},
    body,
    hosts,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  }: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    hosts: readonly string[];
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<ProviderResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError("failed", "invalid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !hosts.includes(url.hostname)) {
    throw new ProviderError("failed", "host not allowed");
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "User-Agent": "Zentico-Workspace/1.0", ...headers },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ProviderError(timeout ? "timeout" : "unreachable", timeout ? "the service took too long to answer" : "the service could not be reached");
  }
  // Capped read: stop (and cancel) as soon as the limit is passed.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ProviderError("tooLarge", "the response was too large");
      }
      chunks.push(value);
    }
  }
  return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
}

export function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** Maps an HTTP status from a provider API to a ProviderError (message never includes the body). */
export function statusError(provider: string, status: number, detail?: string): ProviderError {
  const d = detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 200)}` : "";
  if (status === 401) return new ProviderError("unauthorized", `${provider} refused the connection (reconnect it in Settings → Apps & bots)`, status);
  if (status === 403) return new ProviderError("forbidden", `${provider} denied access${d}`, status);
  if (status === 404) return new ProviderError("notFound", `${provider}: not found (or no access)`, status);
  if (status === 410) return new ProviderError("notFound", `${provider}: gone`, status);
  if (status === 422 || status === 400) return new ProviderError("invalid", `${provider} rejected the request${d}`, status);
  if (status === 429) return new ProviderError("rateLimited", `${provider} rate limit reached; try again later`, status);
  return new ProviderError("failed", `${provider} answered HTTP ${status}`, status);
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
