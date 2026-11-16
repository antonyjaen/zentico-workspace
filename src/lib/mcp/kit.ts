// Shared building blocks for the MCP tool modules: the tool shape, JSON-schema helpers and
// small formatting helpers.
import { env } from "../env";
import type { Session } from "../session";
import type { Args } from "./args";
import type { Scope } from "./db";

export type ToolContext = {
  session: Session;
  scope: Scope;
  tokenName: string;
  tokenExpires: number | null;
  /**
   * Set when the request carries X-Zentico-Command (sent by tools/zentico-bridge.mjs for a meeting
   * command): write tools then wait for the user's Approve / Reject in the call. null = normal MCP use.
   */
  commandId?: string | null;
};

export type JsonSchema = Record<string, unknown>;
export type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, JsonSchema>; required?: string[] };
  /** Changes something: only offered to read+write tokens, and confirmed in-call for meeting commands. */
  write?: boolean;
  /**
   * Only changes the user's own workspace UI (e.g. their dashboard) and is undoable: runs without
   * the in-call / in-dashboard confirmation that other write tools wait for.
   */
  selfService?: boolean;
  /** Deletes or overwrites data (MCP destructiveHint). */
  destructive?: boolean;
  /** Reaches people outside the workspace UI, e.g. sends mail or invitations (MCP openWorldHint). */
  openWorld?: boolean;
  /** Runs on the user's connected app (lib/connect): only listed when it is connected. */
  provider?: import("../connect/providers").ProviderId;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
};

/* ------------------------------------------------------------------ helpers */

export const appUrl = () => env.appUrl;
export const S = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
export const I = (description: string, minimum: number, maximum: number, def?: number): JsonSchema => ({
  type: "integer",
  description,
  minimum,
  maximum,
  ...(def !== undefined ? { default: def } : {}),
});
export const B = (description: string, def = false): JsonSchema => ({ type: "boolean", description, default: def });
export const A = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });

export const iso = (ms: number) => new Date(ms).toISOString();
export const addr = (list: { name: string | null; email: string }[] | null | undefined) =>
  (list ?? []).map((a) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email));

/** Page of a list plus the offset of the next page (null when done). */
export function page<T>(list: T[], position: number, limit: number): { total: number; nextPosition: number | null; items: T[] } {
  const items = list.slice(position, position + limit);
  return { total: list.length, nextPosition: position + items.length < list.length ? position + items.length : null, items };
}

/** Lowercase, accent-free form for local substring matching. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** "leo.park@x" → "Leo Park" (real names are kept). */
export { readableName as personName } from "@/app/(apps)/chat/shared";
