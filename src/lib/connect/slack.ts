// Slack (user token): list channels, post a message as the person. Slack answers HTTP 200 with
// { ok: false, error } on failure. Server-only.
import { callApi } from "./api";
import { arr, clip, obj, ProviderError, str } from "./http";

const API = "https://slack.com/api";
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,20}$/;
const CHANNEL_NAME = /^#?[a-z0-9][a-z0-9._-]{0,79}$/;

function check(json: unknown): Record<string, unknown> {
  const o = obj(json);
  if (o.ok === true) return o;
  const err = str(o.error) || "failed";
  if (["not_authed", "invalid_auth", "token_revoked", "token_expired", "account_inactive"].includes(err)) {
    throw new ProviderError("unauthorized", "Slack refused the connection (reconnect it in Settings → Apps & bots)", 401);
  }
  if (err === "ratelimited") throw new ProviderError("rateLimited", "Slack rate limit reached; try again later", 429);
  throw new ProviderError("invalid", `Slack: ${err.slice(0, 80)}`);
}

type Channel = { id: string; name: string; private: boolean; member: boolean; members: number | null; topic: string | null };

export async function listChannels(token: string, limit: number, query?: string): Promise<Channel[]> {
  const out: Channel[] = [];
  let cursor = "";
  const q = query?.replace(/^#/, "").toLowerCase();
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const params = new URLSearchParams({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) });
    const { json } = await callApi("slack", token, `${API}/conversations.list?${params}`);
    const o = check(json);
    for (const raw of arr(o.channels)) {
      const c = obj(raw);
      const name = str(c.name);
      if (q && !name.includes(q)) continue;
      out.push({
        id: str(c.id),
        name,
        private: c.is_private === true,
        member: c.is_member === true,
        members: typeof c.num_members === "number" ? c.num_members : null,
        topic: clip(str(obj(c.topic).value), 200) || null,
      });
      if (out.length >= limit) break;
    }
    cursor = str(obj(o.response_metadata).next_cursor);
    if (!cursor) break;
  }
  return out;
}

/** A channel id, or a #name resolved among the channels the person can see. */
export async function resolveChannel(token: string, v: unknown): Promise<string> {
  const s = typeof v === "string" ? v.trim() : "";
  if (CHANNEL_ID.test(s)) return s;
  if (!CHANNEL_NAME.test(s)) throw new ProviderError("invalid", "Expected a Slack channel id (C…) or #name.");
  const name = s.replace(/^#/, "");
  const match = (await listChannels(token, 1000, name)).find((c) => c.name === name);
  if (!match) throw new ProviderError("notFound", `Slack channel #${name} not found (or not visible to you).`);
  return match.id;
}

export async function postMessage(token: string, channel: string, text: string, threadTs?: string) {
  const { json } = await callApi("slack", token, `${API}/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
  });
  const o = check(json);
  return { channel: str(o.channel), ts: str(o.ts) };
}
