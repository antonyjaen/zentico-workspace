// The signed-in user's assistant: its name (also the main wake word in calls), extra wake words and
// the language of its voice replies.
// GET → AgentProfileResponse.
// PUT { name: string | null, wakeWords?: string[], voiceLang?: string | null } → AgentProfileResponse.
//   name null = named after the agent the bridge runs ("Codex"…), or "Assistant" without a bridge.
import { NextResponse, type NextRequest } from "next/server";
import { getLocale } from "next-intl/server";
import { getSession } from "@/lib/auth";
import { jsonError, NO_STORE, sameOrigin } from "@/lib/meetings/http";
import { agentNameFor, getAgentProfile, setAgentProfile } from "@/lib/mcp/agent";
import { cleanAgentName, FAMILY_LABELS, MAX_WAKE_WORDS, resolveAgentName, type AgentFamily } from "@/lib/meetings/wake";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type AgentProfileResponse = {
  /** The name in use (the chosen one or the default). */
  name: string;
  /** The user's own choice, or null. */
  customName: string | null;
  /** What the name falls back to without a choice. */
  defaultName: string;
  wakeWords: string[];
  voiceLang: string | null;
  /** The agent the user's bridge last reported, with a readable label. */
  agent: { family: AgentFamily; label: string } | null;
};

const LANG = /^[a-z]{2,3}$/;

async function view(email: string): Promise<AgentProfileResponse> {
  const locale = await getLocale();
  const p = getAgentProfile(email);
  return {
    name: agentNameFor(email, locale),
    customName: p.name,
    defaultName: resolveAgentName({ name: null, client: p.family ? `zentico-bridge/0 ${p.family}` : null, locale }),
    wakeWords: p.wakeWords,
    voiceLang: p.voiceLang,
    agent: p.family ? { family: p.family, label: FAMILY_LABELS[p.family] } : null,
  };
}

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  return NextResponse.json(await view(session.email), { headers: NO_STORE });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!sameOrigin(req)) return jsonError("forbidden", 403);
  if (Number(req.headers.get("content-length") ?? "0") > 4096) return jsonError("too_large", 413);
  let body: { name?: unknown; wakeWords?: unknown; voiceLang?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 4096) return jsonError("too_large", 413);
    body = JSON.parse(raw) as typeof body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("invalid", 400);
  } catch {
    return jsonError("invalid", 400);
  }
  const current = getAgentProfile(session.email);

  let name: string | null = current.name;
  if (body.name === null || body.name === "") name = null;
  else if (body.name !== undefined) {
    name = cleanAgentName(body.name);
    if (!name) return jsonError("invalid_name", 400);
  }

  let wakeWords = current.wakeWords;
  if (body.wakeWords !== undefined) {
    if (!Array.isArray(body.wakeWords) || body.wakeWords.length > MAX_WAKE_WORDS) return jsonError("invalid_wake_words", 400);
    const cleaned = body.wakeWords.map(cleanAgentName);
    if (cleaned.some((w) => !w)) return jsonError("invalid_wake_words", 400);
    wakeWords = [...new Set(cleaned as string[])];
  }

  let voiceLang = current.voiceLang;
  if (body.voiceLang === null || body.voiceLang === "") voiceLang = null;
  else if (body.voiceLang !== undefined) {
    if (typeof body.voiceLang !== "string" || !LANG.test(body.voiceLang)) return jsonError("invalid", 400);
    voiceLang = body.voiceLang;
  }

  setAgentProfile(session.email, { name, wakeWords, voiceLang });
  return NextResponse.json(await view(session.email), { headers: NO_STORE });
}
