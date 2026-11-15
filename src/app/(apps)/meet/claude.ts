// Client-safe types and limits for "Claude commands" in a call: things the local user says
// ("Claude, …") or types are queued for THEIR OWN Claude Code, which runs them through the
// zentico-bridge (tools/zentico-bridge.mjs). Shared by the call UI, /api/meet/voice and src/lib/mcp/agent.

export type CommandStatus = "queued" | "dispatched" | "needs_confirmation" | "done" | "failed" | "cancelled";
export const COMMAND_STATUSES: readonly CommandStatus[] = ["queued", "dispatched", "needs_confirmation", "done", "failed", "cancelled"];
export const isFinalStatus = (s: CommandStatus) => s === "done" || s === "failed" || s === "cancelled";

export type CommandView = {
  id: string;
  room: string;
  text: string;
  source: "voice" | "typed";
  status: CommandStatus;
  /** Latest progress line from the bridge while running. */
  progress: string | null;
  /** Final answer (done) or error (failed). */
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ConfirmationView = {
  id: string;
  commandId: string;
  /** MCP tool name, e.g. "mail_send". */
  tool: string;
  /** What the tool would do, e.g. 'to ana@x.com · "Budget"'. */
  summary: string;
  createdAt: number;
  expiresAt: number;
};

export type BridgeStatus = { connected: boolean; lastSeen: number | null };

export type CommandsResponse = {
  commands: CommandView[];
  confirmations: ConfirmationView[];
  bridge: BridgeStatus;
  /** The user has an active read+write access token (required for commands). */
  hasWriteToken: boolean;
  /** The room belongs to a Chat meeting card, so results can be shared to its thread. */
  chat: boolean;
};

export type VoiceResponse = {
  ok: true;
  /** What was heard in the window (for the "listening" indicator; not stored on the client). */
  heard: string;
  command?: CommandView;
  /** The command continues in the next window. */
  capturing?: boolean;
  /** "Claude confirm" / "Claude cancel" handled. */
  action?: "approved" | "rejected" | "cancelled";
};

/** Rolling capture windows of the local microphone. */
export const VOICE_WINDOW_MS = 6000;
export const VOICE_OVERLAP_MS = 1000;
export const VOICE_MAX_BYTES = 1024 * 1024;
export const VOICE_MIN_INTERVAL_MS = 2000;
export const COMMAND_MAX_CHARS = 2000;
/** How long a write tool waits for Approve / Reject. */
export const CONFIRM_TIMEOUT_MS = 120_000;
export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const CLAUDE_COMMANDS_PREF = "zw-meet-claude-commands";
