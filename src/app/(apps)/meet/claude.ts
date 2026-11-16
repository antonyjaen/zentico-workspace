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
  /** One or two short sentences to read aloud in the call (done only). */
  spoken: string | null;
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
  /** What was heard in the clip (shown to the speaker only; not stored on the client). */
  heard: string;
  command?: CommandView;
  /** "Claude confirm" / "Claude cancel" handled. */
  action?: "approved" | "rejected" | "cancelled";
};

/** One clip = one utterance of the local microphone (voice activity detection in the browser). */
export const VOICE_MAX_CLIP_MS = 20_000;
/** ~32 kbit/s Opus for 20 s is ~80 KB; headroom for browsers that ignore the requested bitrate. */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;
/** A clip needs ≥ 600 ms of speech + 900 ms of trailing silence, so real clips are ≥ 1.5 s apart. */
export const VOICE_MIN_INTERVAL_MS = 1000;
export const COMMAND_MAX_CHARS = 2000;
/** How long a write tool waits for Approve / Reject. */
export const CONFIRM_TIMEOUT_MS = 120_000;
export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const CLAUDE_COMMANDS_PREF = "zw-meet-claude-commands";

/** Max length of the spoken summary of a result. */
export const SPOKEN_MAX = 300;

/** Spoken replies over the LiveKit data channel (reliable). The sender is always the command's owner. */
export const CLAUDE_VOICE_TOPIC = "zw-claude-voice";
export type ClaudeVoiceSignal = { kind: "say"; id: string; text: string; lang?: string } | { kind: "stop"; id: string };
/** "1" = this browser never speaks Claude's replies (local opt-out). */
export const CLAUDE_VOICE_MUTE_PREF = "zw-meet-claude-voice-mute";
/** "0" = the owner doesn't want their answers spoken to the call (default: spoken). */
export const CLAUDE_SPEAK_PREF = "zw-meet-claude-speak";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Plain single-line text for speech: no control characters, markdown marks or long runs of spaces. */
export function cleanSpoken(text: string): string {
  return text
    .replace(CONTROL, " ")
    .replace(/[*_`#~|<>\[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SPOKEN_MAX);
}
