// Starts connecting a third-party app: state + PKCE verifier go into a short-lived sealed cookie
// bound to the signed-in user, then the browser is sent to the provider's consent screen.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { seal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { buildAuthorize, CONNECT_COOKIE, CONNECT_TX_MAX_AGE } from "@/lib/connect/oauth";
import { isConfigured, isProviderId } from "@/lib/connect/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settings = (q: string) => `${env.appUrl}/settings/apps?${q}#connected-apps`;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${env.appUrl}/signin`);
  if (!isProviderId(provider)) return NextResponse.redirect(settings("connectError=unknown"));
  if (!isConfigured(provider)) return NextResponse.redirect(settings(`connectError=notConfigured&provider=${provider}`));

  const { url, tx } = await buildAuthorize(provider, session.sub);
  const res = NextResponse.redirect(url);
  res.cookies.set(CONNECT_COOKIE, await seal(tx), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: sent on the provider's top-level redirect back to the callback.
    sameSite: "lax",
    path: "/api/connect",
    maxAge: CONNECT_TX_MAX_AGE,
  });
  return res;
}
