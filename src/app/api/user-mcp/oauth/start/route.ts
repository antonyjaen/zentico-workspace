// Starts (or restarts) OAuth for one of the user's MCP servers: state + PKCE verifier go into a
// short-lived sealed cookie bound to the signed-in user and server, then the browser is sent to
// the authorization server discovered for that MCP server.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { randomToken, seal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { UserMcpError } from "@/lib/user-mcp/errors";
import { authorizeUrl, MCP_OAUTH_COOKIE, MCP_OAUTH_COOKIE_PATH, MCP_OAUTH_TX_MAX_AGE, prepareOAuth, type McpOAuthTx } from "@/lib/user-mcp/oauth";
import { getServer, oauthConfig, serverUrl, setOAuthConfig } from "@/lib/user-mcp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settings = (q: string) => `${env.appUrl}/settings/apps?${q}#mcp-servers`;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
  const id = req.nextUrl.searchParams.get("server") ?? "";
  const rec = getServer(session.sub, id);
  if (!rec || rec.authType !== "oauth") return NextResponse.redirect(settings("mcpError=not_found"));
  try {
    let cfg = await oauthConfig(rec.id);
    if (!cfg) {
      cfg = await prepareOAuth((await serverUrl(rec.id)).toString(), {});
      await setOAuthConfig(rec.id, cfg);
    }
    const state = randomToken(24);
    const { url, verifier } = await authorizeUrl(cfg, state);
    const tx: McpOAuthTx = { serverId: rec.id, state, verifier, sub: session.sub, exp: Date.now() + MCP_OAUTH_TX_MAX_AGE * 1000 };
    const res = NextResponse.redirect(url);
    res.cookies.set(MCP_OAUTH_COOKIE, await seal(tx), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // Lax: sent on the authorization server's top-level redirect back to the callback.
      sameSite: "lax",
      path: MCP_OAUTH_COOKIE_PATH,
      maxAge: MCP_OAUTH_TX_MAX_AGE,
    });
    return res;
  } catch (e) {
    const code = e instanceof UserMcpError ? e.code : "failed";
    console.error("[user-mcp] oauth start failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.redirect(settings(`mcpError=${encodeURIComponent(code)}&mcpServer=${encodeURIComponent(rec.id)}`));
  }
}
