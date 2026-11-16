// Two-step verification: workspace policy and each user's last known status. Server-only.
// The second factor itself lives in Stalwart (x:AccountPassword otpAuth, asked on its sign-in
// page); ${DATA_DIR:-./data}/security.sqlite only keeps what the workspace needs to enforce the
// admin policy without calling Stalwart on every request: the policy, and per user whether TOTP
// was on the last time it was read from Stalwart with the user's own security grant.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

type SQLValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SQLValue>;
type Statement = {
  run(...params: SQLValue[]): { changes: number | bigint };
  get(...params: SQLValue[]): Row | undefined;
  all(...params: SQLValue[]): Row[];
};
type Database = { exec(sql: string): void; prepare(sql: string): Statement };

// Loaded at runtime so neither webpack nor Turbopack tries to bundle the builtin.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
  "node:sqlite",
) as { DatabaseSync: new (path: string, options?: { timeout?: number }) => Database };

const MIGRATIONS = [
  `
  CREATE TABLE policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    require_2fa INTEGER NOT NULL,
    -- Epoch ms from which unenrolled users are blocked (grace period end).
    enforce_after INTEGER NOT NULL,
    -- Maximum browser session age from sign-in, in ms; 0 = no limit.
    session_max_ms INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE TABLE users (
    sub TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    checked INTEGER NOT NULL
  );
  `,
];

const g = globalThis as typeof globalThis & { __zwSecurityDb?: Database; __zwSecurityAttempts?: Map<string, { count: number; reset: number }> };

function db(): Database {
  if (g.__zwSecurityDb) return g.__zwSecurityDb;
  const dir = resolve(process.env.DATA_DIR?.trim() || "./data");
  mkdirSync(dir, { recursive: true });
  const d = new DatabaseSync(join(dir, "security.sqlite"), { timeout: 5000 });
  d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const version = Number(d.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.exec("BEGIN");
    try {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
  return (g.__zwSecurityDb = d);
}

export type Policy = {
  required: boolean;
  enforceAfter: number;
  /** Maximum session age from sign-in in ms; 0 = no limit (sessions roll while in use). */
  sessionMaxMs: number;
  updatedBy: string | null;
  updated: number | null;
};

export function getPolicy(): Policy {
  const row = db().prepare("SELECT require_2fa, enforce_after, session_max_ms, updated_by, updated FROM policy WHERE id = 1").get();
  if (!row) return { required: false, enforceAfter: 0, sessionMaxMs: 0, updatedBy: null, updated: null };
  return {
    required: row.require_2fa === 1,
    enforceAfter: Number(row.enforce_after),
    sessionMaxMs: Number(row.session_max_ms),
    updatedBy: String(row.updated_by),
    updated: Number(row.updated),
  };
}

export const GRACE_DAYS = [0, 7] as const;
export const HOUR_MS = 3_600_000;
/** Session lifetime bounds for a custom value: 1 hour to 365 days. */
export const SESSION_MAX_LIMIT_MS = 365 * 24 * HOUR_MS;

function savePolicy(p: Pick<Policy, "required" | "enforceAfter" | "sessionMaxMs">, by: string): Policy {
  db()
    .prepare(
      `INSERT INTO policy (id, require_2fa, enforce_after, session_max_ms, updated_by, updated) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET require_2fa = excluded.require_2fa, enforce_after = excluded.enforce_after,
         session_max_ms = excluded.session_max_ms, updated_by = excluded.updated_by, updated = excluded.updated`,
    )
    .run(p.required ? 1 : 0, p.enforceAfter, p.sessionMaxMs, by, Date.now());
  return getPolicy();
}

export function setRequire2fa(required: boolean, graceDays: number, by: string): Policy {
  const current = getPolicy();
  // Keep the original deadline when re-saving an already required policy.
  const enforceAfter = !required ? 0 : current.required ? current.enforceAfter : Date.now() + graceDays * 86_400_000;
  return savePolicy({ ...current, required, enforceAfter }, by);
}

/** `ms` must already be validated (0, or 1 hour..365 days). */
export function setSessionMax(ms: number, by: string): Policy {
  return savePolicy({ ...getPolicy(), sessionMaxMs: ms }, by);
}

/**
 * True when a browser session signed in at `signedInAt` is older than the workspace limit.
 * Sessions from before `signedInAt` existed get it stamped at their next token refresh.
 */
export function exceedsLifetime(signedInAt: number | undefined, now = Date.now()): boolean {
  const max = getPolicy().sessionMaxMs;
  return max > 0 && signedInAt !== undefined && now - signedInAt >= max;
}

/** Records the TOTP status just read from (or set in) Stalwart for this user. */
export function recordStatus(sub: string, email: string, enabled: boolean) {
  db()
    .prepare(
      `INSERT INTO users (sub, email, enabled, checked) VALUES (?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET email = excluded.email, enabled = excluded.enabled, checked = excluded.checked`,
    )
    .run(sub, email, enabled ? 1 : 0, Date.now());
}

/** Last known status: true/false, or null when never checked. */
export function statusOf(sub: string): boolean | null {
  const row = db().prepare("SELECT enabled FROM users WHERE sub = ?").get(sub);
  return row ? row.enabled === 1 : null;
}

export type UserStatus = { email: string; enabled: boolean; checked: number };

export function listStatuses(): UserStatus[] {
  return db()
    .prepare("SELECT email, enabled, checked FROM users ORDER BY enabled ASC, email COLLATE NOCASE ASC LIMIT 1000")
    .all()
    .map((r) => ({ email: String(r.email), enabled: r.enabled === 1, checked: Number(r.checked) }));
}

/** True when the workspace requires 2FA (past any grace period) and this user isn't known to have it. */
export function isGated(sub: string, now = Date.now()): boolean {
  const policy = getPolicy();
  return policy.required && now >= policy.enforceAfter && statusOf(sub) !== true;
}

/**
 * Workspace admins: WORKSPACE_ADMINS, comma-separated emails. Stalwart's admin role can't be read
 * with the workspace's tokens (their scopes filter out admin permissions), so it is configured here.
 */
export function isAdmin(email: string): boolean {
  const list = (process.env.WORKSPACE_ADMINS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(email.toLowerCase());
}

/**
 * Per-user limit on code/password attempts (5 per 10 minutes). In-process like the rest of the
 * live state (single instance). Returns false when the attempt must be refused.
 */
export function allowAttempt(sub: string, now = Date.now()): boolean {
  const attempts = (g.__zwSecurityAttempts ??= new Map());
  const entry = attempts.get(sub);
  if (!entry || entry.reset <= now) {
    attempts.set(sub, { count: 1, reset: now + 10 * 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= 5;
}

/** Clears the attempt counter after a success. */
export const resetAttempts = (sub: string) => g.__zwSecurityAttempts?.delete(sub);
