// OAuth redirect URI for connected MCP servers (`${APP_URL}/api/user-mcp/oauth/callback`). Checks
// the sealed transaction cookie (same state, same signed-in user, server still theirs, not
// expired), exchanges the code server-side with the PKCE verifier and stores the tokens sealed.
// Tokens never reach the browser; errors are reported to Settings as short codes.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { unseal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { UserMcpError } from "@/lib/user-mcp/errors";
import { dropServer, getCatalog } from "@/lib/user-mcp/manager";
import { exchangeCode, MCP_OAUTH_COOKIE, MCP_OAUTH_COOKIE_PATH, type McpOAuthTx } from "@/lib/user-mcp/oauth";
import { getServer, oauthConfig, saveTokens } from "@/lib/user-mcp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function done(q: string) {
  const res = NextResponse.redirect(`${env.appUrl}/settings/apps?${q}#mcp-servers`);
  res.cookies.set(MCP_OAUTH_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: MCP_OAUTH_COOKIE_PATH, maxAge: 0 });
  return res;
}
const fail = (code: string, serverId?: string) => done(`mcpError=${encodeURIComponent(code)}${serverId ? `&mcpServer=${encodeURIComponent(serverId)}` : ""}`);

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tx = await unseal<McpOAuthTx>(req.cookies.get(MCP_OAUTH_COOKIE)?.value);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
  const state = q.get("state") ?? "";
  if (!tx || tx.exp < Date.now() || !state || !sameString(state, tx.state) || tx.sub !== session.sub) return fail("state");
  const rec = getServer(session.sub, tx.serverId);
  if (!rec || rec.authType !== "oauth") return fail("not_found");
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "denied" : "auth_required", rec.id);
  const code = q.get("code") ?? "";
  if (!code || code.length > 4096) return fail("auth_required", rec.id);

  try {
    const cfg = await oauthConfig(rec.id);
    if (!cfg) throw new UserMcpError("auth_required", "OAuth is not set up for this server");
    const tokens = await exchangeCode(cfg, code, tx.verifier);
    await saveTokens(rec.id, tokens);
    dropServer(rec.id);
    // Warm the tool catalog; failures show up in Settings (Test connection).
    const fresh = getServer(session.sub, rec.id);
    if (fresh) await getCatalog(fresh, { refresh: true }).catch(() => undefined);
    return done(`mcpConnected=${encodeURIComponent(rec.id)}`);
  } catch (e) {
    const c = e instanceof UserMcpError ? e.code : "failed";
    console.error("[user-mcp] oauth callback failed:", e instanceof Error ? e.message : "unknown error");
    return fail(c, rec.id);
  }
}
