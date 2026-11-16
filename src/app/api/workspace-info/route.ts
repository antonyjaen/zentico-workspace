import { NextResponse } from "next/server";
import { version } from "../../../../package.json";
import { collaboraUrl } from "@/lib/wopi";

export const dynamic = "force-dynamic";

const host = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

/**
 * Public identity of this server, used by the desktop/mobile apps to validate a workspace address
 * and to build their navigation allow-list (sign-in and office hosts). Public-safe: host names only.
 */
export function GET() {
  return NextResponse.json(
    {
      product: "zentico-workspace",
      name: "Zentico Workspace",
      version,
      authHost: host(process.env.OIDC_ISSUER),
      officeHost: host(collaboraUrl()),
    },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
