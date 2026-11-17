// The user's assistant name and the wake words that address it ("Codex, …", "oye asistente, …").
// Pure functions (no I/O): shared by the voice pipeline, typed commands and the UI strings.

/** Agent families a bridge can report in its "zentico-bridge/<version> <agent> (<host>)" header. */
export const AGENT_FAMILIES = ["claude", "codex", "opencode", "gemini", "custom", "openai", "anthropic"] as const;
export type AgentFamily = (typeof AGENT_FAMILIES)[number];

/** Label of each family for "Codex on HOST" and the integrations page. */
export const FAMILY_LABELS: Record<AgentFamily, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  custom: "Custom agent",
  openai: "OpenAI-compatible API",
  anthropic: "Anthropic API",
};

export const genericAgentName = (locale: string) => (locale.startsWith("es") ? "Asistente" : "Assistant");

/**
 * The agent a bridge runs, from its client header. Bridges before 1.3.0 only ran Claude Code and
 * didn't say so: any older bridge header means "claude". Null when no bridge ever connected.
 */
export function familyOf(client: string | null | undefined): AgentFamily | null {
  if (!client) return null;
  const m = /^zentico-bridge\/\S+\s+([a-z]+)\b/i.exec(client);
  if (!m) return /^zentico-bridge\//i.test(client) ? "claude" : null;
  const f = m[1].toLowerCase();
  return (AGENT_FAMILIES as readonly string[]).includes(f) ? (f as AgentFamily) : null;
}

/** The host a bridge runs on, from the same header. */
export function hostOf(client: string | null | undefined): string | null {
  if (!client) return null;
  return /\(([^()]+)\)\s*$/.exec(client)?.[1] || null;
}

/**
 * The name shown in the UI and used as the main wake word: the user's choice, else the generic
 * "Assistant". Never a vendor's brand: which agent runs is shown as a fact (FAMILY_LABELS), not as a name.
 */
export function resolveAgentName(input: { name: string | null; locale: string }): string {
  return input.name?.trim() || genericAgentName(input.locale);
}

/** 1–24 letters (any script) and single spaces. */
export const AGENT_NAME = /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u;
export const MAX_WAKE_WORDS = 6;

export function cleanAgentName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFC").replace(/\s+/g, " ").trim();
  return t.length >= 1 && t.length <= 24 && AGENT_NAME.test(t) ? t : null;
}

/* -------------------------------------------------------------- wake words */

/** How speech recognition tends to write known names (regex sources, matched case-insensitively). */
const VARIANTS: Record<string, string[]> = {
  claude: ["claude", "cloud", "clod", "claud", "cloth", "klaud", "klod", "clow", "clau", "cloude"],
  codex: ["codex", "kodex", "codecs", "code x", "codecks"],
  gemini: ["gemini", "geminis", "jiminy", "yemini"],
  opencode: ["open ?code"],
};
/** Words that always address the assistant, whatever it is called. */
const GENERIC = ["asistente", "assistant", "agente", "agent", "zentico"];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
/** A typed or spoken word: accents optional, spaces flexible. */
const wordSource = (w: string) => escape(fold(w).trim()).replace(/\s+/g, "\\s+");

/** `family`: the agent the user's bridge runs; people address it by its name ("Codex, …") out of habit. */
export type WakeProfile = { name: string; wakeWords?: string[]; family?: AgentFamily | null };

/**
 * The wake prefix for a user: their assistant's name (plus how recognition misspells known names),
 * their extra wake words, the name of the agent their bridge runs, and the generic words, with an
 * optional "hey" / "oye" / "ok" in front. Anchored at the start; matches on accent-folded text.
 */
export function wakeRegex(profile: WakeProfile): RegExp {
  const alts = new Set<string>();
  const add = (w: string) => {
    const key = fold(w).replace(/\s+/g, "");
    for (const v of VARIANTS[key] ?? []) alts.add(v.replace(/ /g, "\\s*"));
    if (w.trim()) alts.add(wordSource(w));
  };
  add(profile.name);
  for (const w of profile.wakeWords ?? []) add(w);
  if (profile.family) add(profile.family);
  for (const w of GENERIC) alts.add(w);
  // Longest first, so "open code" wins over "open".
  const list = [...alts].sort((a, b) => b.length - a.length);
  return new RegExp(`^(?:(?:hey|oye|ok|okay)[\\s,]+)?(?:${list.join("|")})(?![\\p{L}\\p{N}])[,:.!]?\\s*`, "iu");
}

/**
 * Strips a leading wake phrase ("Codex, …", "oye asistente: …"). Returns the rest, or the text
 * unchanged when it doesn't start with one. Matching ignores accents; the returned text keeps them.
 */
export function stripWake(text: string, re: RegExp): string {
  // Folding can change the length (decomposed accents): match on a per-character fold instead.
  const folded = [...text].map((ch) => fold(ch) || ch).join("");
  if ([...folded].length !== [...text].length) return text.replace(re, "");
  const m = re.exec(folded);
  if (!m) return text;
  return [...text].slice([...m[0]].length).join("");
}
