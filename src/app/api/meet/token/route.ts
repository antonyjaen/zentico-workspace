import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  isValidRoom,
  livekitConfig,
  mintAccessToken,
  parseRecentRooms,
  RECENT_ROOMS_COOKIE,
  RECENT_ROOMS_MAX,
} from "@/lib/livekit";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** POST { room } → { token, url }: a LiveKit join token for the signed-in user. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  // JSON-only keeps cross-site form posts out (they can't set this content type without CORS).
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415, headers: NO_STORE });
  }

  const config = livekitConfig();
  if (!config) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });

  let room: unknown;
  try {
    room = ((await req.json()) as { room?: unknown } | null)?.room;
  } catch {
    room = undefined;
  }
  if (!isValidRoom(room)) return NextResponse.json({ error: "invalid_room" }, { status: 400, headers: NO_STORE });

  const token = await mintAccessToken(config, {
    identity: session.email,
    name: session.name || session.email,
    room,
  });

  const res = NextResponse.json({ token, url: config.url }, { headers: NO_STORE });
  const recent = [room, ...parseRecentRooms(req.cookies.get(RECENT_ROOMS_COOKIE)?.value).filter((r) => r !== room)];
  res.cookies.set(RECENT_ROOMS_COOKIE, JSON.stringify(recent.slice(0, RECENT_ROOMS_MAX)), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}
