// The built-in "GitHub" chat app. Anyone can add it to a conversation; it always acts with the
// GitHub connection of the person using it (never someone else's):
//   /github issue <owner/repo> <title>     creates an issue as you and posts its card
//   /github subscribe <owner/repo>         posts new issues and pull requests here
//   /github unsubscribe <owner/repo>       stops that
//   /github list                           subscriptions of this conversation
// Subscriptions poll the repo every 5 minutes with the subscriber's token (conditional requests:
// unchanged repos cost no rate limit), dedupe by item id, and stop when the subscriber
// disconnects GitHub, leaves the conversation, or the app is removed from it. Server-only.
import type { ChatMessage } from "@/app/(apps)/chat/shared";
import { builtinBot, rateLimiter, type BotRow } from "../chat/bots";
import { get as chatGet } from "../chat/db";
import { isConversationMember, postBotMessage, postEphemeral, type ConversationBrief } from "../chat/store";
import { githubCard } from "./cards";
import { all, get, run, tx } from "./db";
import * as github from "./github";
import { ProviderError } from "./http";
import { isConfigured } from "./providers";
import { getConnection, withToken } from "./store";

const POLL_MS = 5 * 60_000;
const MAX_POSTS_PER_POLL = 5;
const MAX_SUBS_PER_CONVERSATION = 20;
const MAX_SUBS_PER_USER = 50;
const SEEN_KEEP = 500;
/** Leave this much of the user's hourly GitHub budget for everything else. */
const RATE_FLOOR = 200;

const commandAllowed = rateLimiter(10, 60_000);

const strv = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v ?? 0);

function subOf(chatUserId: number): string {
  const r = chatGet("SELECT sub FROM users WHERE id = ? AND bot_id IS NULL", chatUserId);
  return strv(r?.sub);
}

const notice = (conv: ConversationBrief, m: ChatMessage, bot: BotRow, n: Parameters<typeof postEphemeral>[3]["notice"]) =>
  postEphemeral(conv.id, m.author!.id, bot.userId, { notice: n, threadRoot: m.threadRoot });

const errorText = (e: unknown) => (e instanceof ProviderError ? e.message : "Something went wrong.");

/** "/github …" in a conversation the app is in (people's messages only). */
export async function onGithubCommand(bot: BotRow, conv: ConversationBrief, m: ChatMessage, args: string): Promise<void> {
  if (!m.author || m.author.bot) return;
  const [verb = "", ...rest] = args.trim().split(/\s+/);
  const sub = subOf(m.author.id);
  if (!verb || verb === "help") return notice(conv, m, bot, { code: "githubUsage" });
  if (!commandAllowed(String(m.author.id))) return;
  if (!isConfigured("github") || !sub || !getConnection(sub, "github") || getConnection(sub, "github")?.status !== "ok") {
    return notice(conv, m, bot, { code: "connectRequired", provider: "GitHub" });
  }

  try {
    switch (verb.toLowerCase()) {
      case "issue": {
        const repo = github.parseRepo(rest[0]);
        const title = rest.slice(1).join(" ").trim().slice(0, 256);
        if (!title) return notice(conv, m, bot, { code: "githubUsage" });
        const issue = await withToken(sub, "github", (t) => github.createIssue(t, repo, { title }));
        const card = githubCard(issue);
        postBotMessage(conv.id, bot.userId, { body: "", cards: card ? [card] : [], threadRoot: m.threadRoot });
        return;
      }
      case "subscribe": {
        const repo = github.parseRepo(rest[0]);
        const info = await withToken(sub, "github", (t) => github.repoInfo(t, repo));
        const fullName = info.fullName;
        if (get("SELECT 1 AS x FROM subscriptions WHERE conversation_id = ? AND provider = 'github' AND lower(target) = lower(?)", conv.id, fullName)) {
          return notice(conv, m, bot, { code: "githubSubscribed", repo: fullName });
        }
        if (num(get("SELECT count(*) AS n FROM subscriptions WHERE conversation_id = ?", conv.id)?.n) >= MAX_SUBS_PER_CONVERSATION) {
          return notice(conv, m, bot, { code: "appError", error: `At most ${MAX_SUBS_PER_CONVERSATION} subscriptions per conversation.` });
        }
        if (num(get("SELECT count(*) AS n FROM subscriptions WHERE user_sub = ?", sub)?.n) >= MAX_SUBS_PER_USER) {
          return notice(conv, m, bot, { code: "appError", error: `At most ${MAX_SUBS_PER_USER} subscriptions per person.` });
        }
        // Seed with what exists now so only newer items are posted.
        const first = await withToken(sub, "github", (t) => github.recentItems(t, fullName, null));
        tx(() => {
          const id = num(
            run(
              "INSERT INTO subscriptions (user_sub, chat_user_id, provider, target, conversation_id, etag, created, last_polled) VALUES (?, ?, 'github', ?, ?, ?, ?, ?)",
              sub,
              m.author!.id,
              fullName,
              conv.id,
              first.etag,
              Date.now(),
              Date.now(),
            ).lastInsertRowid,
          );
          for (const item of first.items ?? []) run("INSERT OR IGNORE INTO subscription_seen (subscription_id, item, at) VALUES (?, ?, ?)", id, item.id, Date.now());
        });
        ensurePoller();
        return notice(conv, m, bot, { code: "githubSubscribed", repo: fullName });
      }
      case "unsubscribe": {
        const repo = github.parseRepo(rest[0]);
        const r = run("DELETE FROM subscriptions WHERE conversation_id = ? AND provider = 'github' AND lower(target) = lower(?)", conv.id, repo);
        return notice(conv, m, bot, num(r.changes) ? { code: "githubUnsubscribed", repo } : { code: "githubNotSubscribed", repo });
      }
      case "list": {
        const repos = all("SELECT target FROM subscriptions WHERE conversation_id = ? AND provider = 'github' ORDER BY target", conv.id).map((r) => strv(r.target));
        return notice(conv, m, bot, { code: "githubSubscriptions", repos });
      }
      default:
        return notice(conv, m, bot, { code: "githubUsage" });
    }
  } catch (e) {
    if (!(e instanceof ProviderError)) console.error("[github-app] command failed:", e instanceof Error ? e.message : e);
    notice(conv, m, bot, { code: "appError", error: errorText(e) });
  }
}

/** The app was @mentioned or written to: a short usage notice. */
export function onGithubAddressed(bot: BotRow, conv: ConversationBrief, m: ChatMessage): void {
  if (!m.author || m.author.bot) return;
  notice(conv, m, bot, { code: "githubUsage" });
}

/** The app was removed from a conversation: its subscriptions there end. */
export function onGithubRemoved(conversationId: string): void {
  run("DELETE FROM subscriptions WHERE conversation_id = ? AND provider = 'github'", conversationId);
}

/* ------------------------------------------------------------------ polling */

type SubRow = { id: number; sub: string; chatUserId: number; repo: string; conversationId: string; etag: string | null; created: number };

const g = globalThis as typeof globalThis & { __zwGithubPoller?: { timer: ReturnType<typeof setInterval>; running: boolean; blocked: Map<string, number> } };

function remove(id: number) {
  run("DELETE FROM subscriptions WHERE id = ?", id);
}

async function pollOne(s: SubRow, bot: BotRow, blocked: Map<string, number>): Promise<void> {
  // The subscriber or the app left the conversation: stop.
  if (!isConversationMember(s.conversationId, s.chatUserId) || !isConversationMember(s.conversationId, bot.userId)) return remove(s.id);
  const conn = getConnection(s.sub, "github");
  if (!conn) return remove(s.id);
  if (conn.status !== "ok") {
    run("UPDATE subscriptions SET last_polled = ?, last_error = ? WHERE id = ?", Date.now(), "GitHub connection needs reconnecting", s.id);
    return;
  }
  if ((blocked.get(s.sub) ?? 0) > Date.now()) return;

  let res: Awaited<ReturnType<typeof github.recentItems>>;
  try {
    res = await withToken(s.sub, "github", (t) => github.recentItems(t, s.repo, s.etag));
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "failed";
    if (code === "notConnected") return remove(s.id);
    if (code === "rateLimited") blocked.set(s.sub, Date.now() + 15 * 60_000);
    run("UPDATE subscriptions SET last_polled = ?, last_error = ? WHERE id = ?", Date.now(), errorText(e).slice(0, 300), s.id);
    return;
  }
  if (res.rateRemaining != null && res.rateRemaining < RATE_FLOOR && res.rateReset) blocked.set(s.sub, res.rateReset);

  const fresh = (res.items ?? [])
    .filter((i) => i.id && !get("SELECT 1 AS x FROM subscription_seen WHERE subscription_id = ? AND item = ?", s.id, i.id))
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const now = Date.now();
  tx(() => {
    for (const i of fresh) run("INSERT OR IGNORE INTO subscription_seen (subscription_id, item, at) VALUES (?, ?, ?)", s.id, i.id, now);
    run(
      "DELETE FROM subscription_seen WHERE subscription_id = ? AND item NOT IN (SELECT item FROM subscription_seen WHERE subscription_id = ? ORDER BY at DESC LIMIT ?)",
      s.id,
      s.id,
      SEEN_KEEP,
    );
    run("UPDATE subscriptions SET etag = ?, last_polled = ?, last_error = NULL WHERE id = ?", res.etag ?? s.etag, now, s.id);
  });
  // Only items created after the subscription (older ones that just became visible are skipped).
  for (const i of fresh.filter((x) => Date.parse(x.created) >= s.created - 60_000).slice(-MAX_POSTS_PER_POLL)) {
    const card = githubCard(i);
    if (!card) continue;
    try {
      postBotMessage(s.conversationId, bot.userId, { body: "", cards: [card] });
    } catch (e) {
      console.error("[github-app] posting failed:", e instanceof Error ? e.message : e);
      return;
    }
  }
}

async function pollAll(): Promise<void> {
  const state = g.__zwGithubPoller;
  if (!state || state.running) return;
  state.running = true;
  try {
    if (!isConfigured("github")) return;
    const bot = builtinBot("github");
    if (!bot) return;
    const rows: SubRow[] = all(
      "SELECT * FROM subscriptions WHERE provider = 'github' AND (last_polled IS NULL OR last_polled < ?) ORDER BY last_polled LIMIT 200",
      Date.now() - POLL_MS + 30_000,
    ).map((r) => ({
      id: num(r.id),
      sub: strv(r.user_sub),
      chatUserId: num(r.chat_user_id),
      repo: strv(r.target),
      conversationId: strv(r.conversation_id),
      etag: r.etag == null ? null : strv(r.etag),
      created: num(r.created),
    }));
    for (const s of rows) {
      try {
        await pollOne(s, bot, state.blocked);
      } catch (e) {
        console.error("[github-app] poll failed:", e instanceof Error ? e.message : e);
      }
      // Spread requests out a little.
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    state.running = false;
  }
}

/** Starts the 5-minute poller once per process (idempotent). */
export function ensurePoller(): void {
  if (g.__zwGithubPoller) return;
  const timer = setInterval(() => void pollAll(), POLL_MS);
  timer.unref?.();
  g.__zwGithubPoller = { timer, running: false, blocked: new Map() };
  // First pass shortly after start (catch up after a restart).
  setTimeout(() => void pollAll(), 30_000).unref?.();
}

/** Starts the poller when there is anything to poll (called at server start). */
export function startIfNeeded(): void {
  try {
    if (get("SELECT 1 AS x FROM subscriptions LIMIT 1")) ensurePoller();
  } catch (e) {
    console.error("[github-app] start failed:", e instanceof Error ? e.message : e);
  }
}
