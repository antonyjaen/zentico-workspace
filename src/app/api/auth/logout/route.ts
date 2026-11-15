import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getDiscovery } from "@/lib/oidc";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST() {
  let target = `${env.appUrl}/signin`;
  try {
    const { end_session_endpoint } = await getDiscovery();
    if (end_session_endpoint) {
      const url = new URL(end_session_endpoint);
      url.searchParams.set("client_id", env.clientId);
      url.searchParams.set("post_logout_redirect_uri", target);
      target = url.toString();
    }
  } catch {
    // Provider unreachable: still clear the local session.
  }
  const res = NextResponse.redirect(target, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
