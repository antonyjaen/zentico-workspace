// JSON calls to a provider API with the user's bearer token (fixed provider hosts only).
// Server-only.
import { parseJson, ProviderError, providerFetch, statusError } from "./http";
import { provider, type ProviderId } from "./providers";

export type ApiResult = { status: number; json: unknown; headers: Headers };

export async function callApi(
  id: ProviderId,
  token: string,
  url: string,
  {
    method = "GET",
    body,
    headers = {},
    okStatuses = [],
    maxBytes,
  }: { method?: string; body?: unknown; headers?: Record<string, string>; okStatuses?: number[]; maxBytes?: number } = {},
): Promise<ApiResult> {
  const h: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers };
  let payload: string | undefined;
  if (body !== undefined) {
    h["Content-Type"] ??= "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await providerFetch(url, { method, headers: h, body: payload, hosts: provider(id).hosts, maxBytes });
  const json = parseJson(res.text);
  if ((res.status < 200 || res.status >= 300) && !okStatuses.includes(res.status)) {
    throw statusError(provider(id).name, res.status, errorDetail(json));
  }
  return { status: res.status, json, headers: res.headers };
}

/** A short, non-secret error description from a provider error body. */
function errorDetail(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const nested = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : null;
  const msgs = Array.isArray(o.errorMessages) ? o.errorMessages.filter((m): m is string => typeof m === "string").join("; ") : "";
  const errs = o.errors && typeof o.errors === "object" && !Array.isArray(o.errors) ? Object.values(o.errors).filter((m): m is string => typeof m === "string").join("; ") : "";
  return pick(o.message) ?? pick(nested?.message) ?? (pick(msgs) || pick(errs) || pick(o.error_description) || pick(o.error));
}

export { ProviderError };
