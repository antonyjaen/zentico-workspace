// What Settings → Integrations shows about the user's agent connection: their tokens (with last
// use) and whether their local bridge is connected, and with which agent. Rendered by the page and
// polled by the client through /api/integrations/status. Server-only.
import { bridgeStatus } from "@/lib/mcp/agent";
import { userTokens } from "@/lib/mcp/db";
import { FAMILY_LABELS, familyOf, hostOf, type AgentFamily } from "@/lib/meetings/wake";
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
  /**
   * From the bridge's "zentico-bridge/<version> <agent> (<hostname>)" header: host = the computer it
   * runs on, family / agent = what it runs (bridges before 1.3.0 only ran Claude Code).
   */
  bridge: { connected: boolean; lastSeen: number | null; host: string | null; family: AgentFamily | null; agent: string | null };
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
  const family = familyOf(b.client);
  return {
    tokens,
    bridge: { connected: b.connected, lastSeen: b.lastSeen, host: hostOf(b.client), family, agent: family ? FAMILY_LABELS[family] : null },
    now: Date.now(),
  };
}
