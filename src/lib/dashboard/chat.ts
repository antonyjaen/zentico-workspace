// Snapshot of the Dashboard's Claude chat for the UI (turns, pending confirmations, bridge). Server-only.
import type { ChatState } from "@/app/(apps)/dashboard/model";
import { DASHBOARD_ROOM } from "@/app/(apps)/meet/shared";
import { hasWriteToken } from "../meetings/claude-commands";
import { bridgeStatus, pendingConfirmations } from "../mcp/agent";
import type { Session } from "../session";
import { listTurns } from "./store";

export function chatState(session: Session): ChatState {
  const bridge = bridgeStatus(session.email);
  return {
    turns: listTurns(session.email),
    confirmations: pendingConfirmations(session.email, DASHBOARD_ROOM).map((c) => ({
      id: c.id,
      commandId: c.commandId,
      tool: c.tool,
      summary: c.summary,
      expiresAt: c.expiresAt,
    })),
    bridge: { connected: bridge.connected, lastSeen: bridge.lastSeen },
    hasWriteToken: hasWriteToken(session.sub),
  };
}
