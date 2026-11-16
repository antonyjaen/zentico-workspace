// Structured errors for connected MCP servers. Messages are safe to show to the user (never
// include credentials, URLs with secrets or raw upstream bodies). Server-only.
import type { UserMcpErrorCode } from "./types";

const STATUS: Record<UserMcpErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  invalid_args: 400,
  not_found: 404,
  server_disabled: 403,
  tool_disabled: 403,
  consent_required: 403,
  auth_required: 409,
  unsafe_url: 400,
  rate_limited: 429,
  too_many_sessions: 503,
  timeout: 504,
  unreachable: 502,
  upstream_error: 502,
  failed: 500,
};

export class UserMcpError extends Error {
  code: UserMcpErrorCode;
  retryAfter?: number;
  constructor(code: UserMcpErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
  get status(): number {
    return STATUS[this.code];
  }
}

export const httpStatusOf = (code: UserMcpErrorCode) => STATUS[code];

/** Short, single-line, length-capped text for upstream error messages. */
export const oneLine = (s: unknown, max = 300) => {
  const text = (typeof s === "string" ? s : s instanceof Error ? s.message : "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
