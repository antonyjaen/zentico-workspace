import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The running build's id (see next.config env), for VersionWatcher. */
export function GET() {
  return NextResponse.json({ build: process.env.NEXT_PUBLIC_BUILD_ID ?? "" }, { headers: { "Cache-Control": "no-store" } });
}
