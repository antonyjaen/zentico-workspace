// OAuth redirect URI for connected apps (`${APP_URL}/api/connect/<provider>/callback`). Checks the
// sealed transaction cookie (same provider, same state, same signed-in user, not expired),
// exchanges the code server-side, looks up the account and stores the connection. Tokens never
// reach the browser; errors are reported to Settings as short codes.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { unseal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { ProviderError } from "@/lib/connect/http";
import { CONNECT_COOKIE, exchangeCode, fetchAccount, revokeAtProvider, type ConnectTx } from "@/lib/connect/oauth";
import { isConfigured, isProviderId } from "@/lib/connect/providers";
import { saveConnection } from "@/lib/connect/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function done(q: string) {
  const res = NextResponse.redirect(`${env.appUrl}/settings/apps?${q}#connected-apps`);
  res.cookies.set(CONNECT_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/connect", maxAge: 0 });
  return res;
}
const fail = (code: string, provider?: string) => done(`connectError=${encodeURIComponent(code)}${provider ? `&provider=${provider}` : ""}`);

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isProviderId(provider)) return fail("unknown");
  const q = req.nextUrl.searchParams;
  const tx = await unseal<ConnectTx>(req.cookies.get(CONNECT_COOKIE)?.value);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
  const state = q.get("state") ?? "";
  if (!tx || tx.provider !== provider || tx.exp < Date.now() || !state || !sameString(state, tx.state) || tx.sub !== session.sub) {
    return fail("state", provider);
  }
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "denied" : "providerError", provider);
  const code = q.get("code") ?? "";
  if (!code || code.length > 2048) return fail("providerError", provider);
  if (!isConfigured(provider)) return fail("notConfigured", provider);

  try {
    const { tokens, raw } = await exchangeCode(provider, code, tx.verifier);
    let account;
    try {
      account = await fetchAccount(provider, tokens, raw);
    } catch (e) {
      // Don't leave a grant behind that nobody can see or disconnect.
      await revokeAtProvider(provider, tokens);
      throw e;
    }
    await saveConnection({ sub: session.sub, email: session.email }, provider, account, tokens);
    return done(`connected=${provider}`);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "failed";
    console.error(`[connect] ${provider} callback failed:`, e instanceof Error ? e.message : "unknown error");
    return fail(["exchangeFailed", "accountFailed", "noSite", "timeout", "unreachable"].includes(code) ? code : "failed", provider);
  }
}
