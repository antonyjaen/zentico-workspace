// What Settings → Integrations shows about the user's Claude connection: their tokens (with last
// use) and whether their local bridge is connected. Rendered by the page and polled by the client
// through /api/integrations/status. Server-only.
import { bridgeStatus } from "@/lib/mcp/agent";
import { userTokens } from "@/lib/mcp/db";
import type { Session } from "@/lib/session";

export type TokenView = {
  id: string;
  name: string;
  scope: "read" | "write";
  created: number;
  lastUsed: number | null;
  expires: number | null;
  needsReauth: boolean;
  /** Created before API keys (holds an unusable refresh token copy): must be reconnected to work. */
  legacy: boolean;
};

export type ClaudeStatus = {
  tokens: TokenView[];
  /** host = the computer the bridge runs on, from its "zentico-bridge/<version> (<hostname>)" header. */
  bridge: { connected: boolean; lastSeen: number | null; host: string | null };
  now: number;
};

export function claudeStatus(session: Session): ClaudeStatus {
  const tokens: TokenView[] = userTokens(session.sub).map((t) => ({
    id: t.id,
    name: t.name,
    scope: t.scope,
    created: t.created,
    lastUsed: t.lastUsed,
    expires: t.expires,
    needsReauth: t.needsReauth,
    legacy: !t.credentialSealed,
  }));
  const b = bridgeStatus(session.email);
  const host = b.client ? (/\(([^()]+)\)\s*$/.exec(b.client)?.[1] ?? b.client) || null : null;
  return { tokens, bridge: { connected: b.connected, lastSeen: b.lastSeen, host }, now: Date.now() };
}
