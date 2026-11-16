// Client-safe types and limits for "Claude commands" in a call: things the local user says (push to
// talk) or types are queued for THEIR OWN Claude Code, which runs them through the zentico-bridge
// (tools/zentico-bridge.mjs). Optionally ("Claude listens to the meeting") their browser also sends
// the meeting's mixed audio in chunks so commands come with what was said.
// Shared by the call UI, /api/meet/voice and src/lib/mcp/agent.

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
  /** "confirm" / "cancel" handled. */
  action?: "approved" | "rejected" | "cancelled";
};

/** What a voice clip is: a push-to-talk command, or a chunk of meeting audio for context. */
export type VoiceKind = "command" | "context";
/** A push-to-talk command clip stops by itself at this length. */
export const VOICE_MAX_CLIP_MS = 20_000;
/** Shorter presses are taps, not commands: discarded in the browser. */
export const PTT_MIN_MS = 500;
/** ~32 kbit/s Opus for 20 s is ~80 KB; headroom for browsers that ignore the requested bitrate. */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;
/** Server rate limit per user for command clips (a press is ≥ 500 ms plus the release). */
export const VOICE_MIN_INTERVAL_MS = 1000;
/**
 * Meeting audio is recorded in chunks of this length (each a standalone file). Whisper on the CPU
 * server takes ~11 s per chunk, so chunks barely keep up; the server drops older waiting ones.
 */
export const CONTEXT_CHUNK_MS = 15_000;
/** Server rate limit per user for context chunks. */
export const CONTEXT_MIN_INTERVAL_MS = 5000;
export const COMMAND_MAX_CHARS = 2000;
/** How long a write tool waits for Approve / Reject. */
export const CONFIRM_TIMEOUT_MS = 120_000;
export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * "1" = "Claude listens to the meeting" is on (off by default). A new key on purpose: the old
 * "zw-meet-claude-commands" meant "my own microphone only" and must not turn on meeting capture.
 */
export const CLAUDE_LISTEN_PREF = "zw-meet-claude-listen";
/**
 * "Claude is listening" notice over the LiveKit data channel (reliable), repeated every few seconds
 * so late joiners see it. Meeting audio is only captured after the "on" signal went out.
 */
export const CLAUDE_LISTEN_TOPIC = "zw-claude-listen";
export type ClaudeListenSignal = { type: "listen"; on: boolean };

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
