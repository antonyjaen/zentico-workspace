// New-mail notifications: one watcher per signed-in user while at least one of their
// /api/notifications/stream connections is open. It follows the Inbox through JMAP push
// (Stalwart's EventSource, RFC 8620 §7.3) and falls back to polling Email/changes every 60 s.
// Only from / subject / preview are fetched, never bodies. The access token is the one from the
// newest stream connection (streams reconnect before it expires, see the route). Server-only.
import { threadHref } from "@/app/(apps)/mail/hrefs";
import { env } from "../env";
import { normEmail, notify } from "./store";

const POLL_MS = 60_000;
/** While push is connected, still check now and then in case an event was missed. */
const SAFETY_POLL_MS = 5 * 60_000;
/** Keep the watcher a little after the last stream closes (tabs reconnect, navigations). */
const LINGER_MS = 45_000;
/** Mail older than this when first seen is not "new" (e.g. moved back into the Inbox). */
const FRESH_MS = 30 * 60_000;
const MAX_PER_CHECK = 5;
const MAIL = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

type Raw = Record<string, unknown>;

type Watcher = {
  email: string;
  token: string;
  refs: number;
  stopped: boolean;
  linger?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  apiUrl?: string;
  eventSourceUrl?: string | null;
  accountId?: string;
  inboxId?: string;
  state?: string;
  pushLive: boolean;
  checking: boolean;
  again: boolean;
  /** The token was refused: wait for a new connection to bring a fresh one. */
  needsToken: boolean;
};

const g = globalThis as typeof globalThis & { __zwMailWatchers?: Map<string, Watcher> };
const watchers = (g.__zwMailWatchers ??= new Map());

class AuthError extends Error {}

async function call(w: Watcher, calls: [string, Raw, string][]): Promise<Record<string, Raw>> {
  const res = await fetch(w.apiUrl!, {
    method: "POST",
    headers: { Authorization: `Bearer ${w.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using: MAIL, methodCalls: calls }),
    cache: "no-store",
    signal: w.abort.signal,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`JMAP ${res.status}`);
  const { methodResponses } = (await res.json()) as { methodResponses: [string, Raw, string][] };
  const out: Record<string, Raw> = {};
  for (const [name, args, id] of methodResponses) out[id] ??= name === "error" ? { error: args.type } : args;
  return out;
}

async function setup(w: Watcher): Promise<void> {
  const res = await fetch(`${env.issuer}/jmap/session`, {
    headers: { Authorization: `Bearer ${w.token}` },
    cache: "no-store",
    signal: w.abort.signal,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`JMAP session ${res.status}`);
  const session = (await res.json()) as { apiUrl?: string; eventSourceUrl?: string; primaryAccounts?: Record<string, string> };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!session.apiUrl || !accountId) throw new Error("No mail account");
  w.apiUrl = session.apiUrl;
  w.accountId = accountId;
  w.eventSourceUrl = session.eventSourceUrl ?? null;
  const r = await call(w, [
    ["Mailbox/query", { accountId, filter: { role: "inbox" } }, "m"],
    ["Email/get", { accountId, ids: [] }, "e"],
  ]);
  const inbox = (r.m?.ids as string[] | undefined)?.[0];
  if (!inbox) throw new Error("No inbox");
  w.inboxId = inbox;
  w.state = typeof r.e?.state === "string" ? r.e.state : undefined;
}

async function check(w: Watcher): Promise<void> {
  if (w.stopped || w.needsToken || !w.accountId) return;
  if (w.checking) {
    w.again = true;
    return;
  }
  w.checking = true;
  try {
    do {
      w.again = false;
      if (!w.state) {
        const r = await call(w, [["Email/get", { accountId: w.accountId, ids: [] }, "e"]]);
        w.state = typeof r.e?.state === "string" ? r.e.state : undefined;
        return;
      }
      const r = await call(w, [["Email/changes", { accountId: w.accountId, sinceState: w.state, maxChanges: 100 }, "c"]]);
      const c = r.c ?? {};
      if (c.error || typeof c.newState !== "string") {
        // cannotCalculateChanges and friends: start over from the current state.
        w.state = undefined;
        w.again = true;
        continue;
      }
      w.state = c.newState;
      if (c.hasMoreChanges === true) w.again = true;
      const created = ((c.created as string[] | undefined) ?? []).slice(-50);
      if (created.length) await announce(w, created);
    } while (w.again && !w.stopped);
  } catch (e) {
    if (e instanceof AuthError) w.needsToken = true;
    else if (!w.stopped) console.error("[notifications] mail check:", e instanceof Error ? e.message : e);
  } finally {
    w.checking = false;
  }
}

async function announce(w: Watcher, ids: string[]): Promise<void> {
  const r = await call(w, [
    [
      "Email/get",
      { accountId: w.accountId, ids, properties: ["threadId", "mailboxIds", "keywords", "from", "subject", "preview", "receivedAt"] },
      "g",
    ],
  ]);
  const me = normEmail(w.email);
  const now = Date.now();
  const fresh = ((r.g?.list as Raw[] | undefined) ?? []).filter((m) => {
    const boxes = (m.mailboxIds ?? {}) as Record<string, boolean>;
    const keywords = (m.keywords ?? {}) as Record<string, boolean>;
    const from = ((m.from as { email?: string }[] | null) ?? [])[0]?.email?.toLowerCase() ?? "";
    const received = Date.parse(String(m.receivedAt ?? ""));
    return boxes[w.inboxId!] && !keywords.$seen && !keywords.$draft && from !== me && (!received || now - received < FRESH_MS);
  });
  if (!fresh.length) return;
  if (fresh.length > MAX_PER_CHECK) {
    notify(w.email, {
      category: "mail",
      kind: "mailBatch",
      title: `${fresh.length}`,
      body: fresh
        .slice(0, 3)
        .map((m) => String(m.subject ?? ""))
        .join(" · "),
      href: `/mail/${w.inboxId}`,
      key: "mail:batch",
    });
    return;
  }
  for (const m of fresh) {
    const from = ((m.from as { name?: string | null; email?: string }[] | null) ?? [])[0];
    const subject = String(m.subject ?? "").trim();
    const preview = String(m.preview ?? "").trim();
    notify(w.email, {
      category: "mail",
      kind: "mail",
      title: from?.name || from?.email || "—",
      body: subject && preview ? `${subject} — ${preview}` : subject || preview,
      href: threadHref(w.inboxId!, String(m.threadId ?? "")),
      ref: String(m.threadId ?? ""),
      key: `mail:${String(m.id ?? "")}`,
      once: true,
    });
  }
}

function schedulePoll(w: Watcher) {
  clearTimeout(w.poll);
  if (w.stopped) return;
  w.poll = setTimeout(async () => {
    await check(w);
    schedulePoll(w);
  }, w.pushLive ? SAFETY_POLL_MS : POLL_MS);
}

/** Follows the JMAP EventSource; on Email state changes, checks the Inbox. Reconnects with backoff. */
async function push(w: Watcher): Promise<void> {
  let attempt = 0;
  while (!w.stopped && w.eventSourceUrl) {
    if (w.needsToken) {
      await sleep(5000);
      continue;
    }
    try {
      const url = new URL(
        w.eventSourceUrl
          .replace(/\{types\}|%7Btypes%7D/gi, "Email")
          .replace(/\{closeafter\}|%7Bcloseafter%7D/gi, "no")
          .replace(/\{ping\}|%7Bping%7D/gi, "30"),
      );
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${w.token}`, Accept: "text/event-stream" },
        cache: "no-store",
        signal: w.abort.signal,
      });
      if (res.status === 401) {
        w.needsToken = true;
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`EventSource ${res.status}`);
      w.pushLive = true;
      attempt = 0;
      schedulePoll(w);
      void check(w); // catch up on anything between setup and now
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          try {
            const changed = (JSON.parse(data) as { changed?: Record<string, Record<string, string>> }).changed;
            const next = changed?.[w.accountId!]?.Email;
            if (next && next !== w.state) void check(w);
          } catch {
            // not a state change
          }
        }
        if (buffer.length > 65_536) buffer = "";
      }
    } catch (e) {
      if (w.stopped) return;
      if (!(e instanceof Error && e.name === "AbortError")) attempt += 1;
    }
    w.pushLive = false;
    schedulePoll(w);
    if (w.stopped) return;
    await sleep(Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5)));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(w: Watcher): Promise<void> {
  for (let attempt = 0; !w.stopped; attempt++) {
    if (w.needsToken) {
      await sleep(5000);
      continue;
    }
    try {
      await setup(w);
      break;
    } catch (e) {
      if (w.stopped) return;
      if (e instanceof AuthError) w.needsToken = true;
      else await sleep(Math.min(5 * 60_000, 10_000 * 2 ** Math.min(attempt, 5)));
    }
  }
  if (w.stopped) return;
  schedulePoll(w);
  if (w.eventSourceUrl) void push(w);
}

/**
 * A stream for this user opened: start (or keep) their watcher with the freshest token. Returns
 * the release function to call when that stream closes.
 */
export function watchMail(email: string, token: string): () => void {
  const key = normEmail(email);
  let w = watchers.get(key);
  if (!w || w.stopped) {
    w = {
      email: key,
      token,
      refs: 0,
      stopped: false,
      abort: new AbortController(),
      pushLive: false,
      checking: false,
      again: false,
      needsToken: false,
    };
    watchers.set(key, w);
    void run(w);
  } else if (w.token !== token) {
    w.token = token;
    w.needsToken = false;
  }
  clearTimeout(w.linger);
  w.refs += 1;
  const watcher = w;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watcher.refs -= 1;
    if (watcher.refs > 0) return;
    clearTimeout(watcher.linger);
    watcher.linger = setTimeout(() => {
      if (watcher.refs > 0) return;
      watcher.stopped = true;
      clearTimeout(watcher.poll);
      watcher.abort.abort();
      if (watchers.get(key) === watcher) watchers.delete(key);
    }, LINGER_MS);
  };
}
