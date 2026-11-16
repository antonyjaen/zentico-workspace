// "Meet now" from Chat: opened directly in a new tab (window.open of this URL, synchronously in the
// click), it joins the conversation's ongoing meeting or starts one, then redirects to the room.
// Doing the start server-side avoids pre-opening an about:blank tab and steering it after an await,
// which left users on a blank tab whenever anything in between failed.
//   ?c=<conversationId>            the conversation's meeting
//   ?with=<email>&name=<name>      the meeting of my DM with that person (created if needed)
import { NextResponse, type NextRequest } from "next/server";
import { getMeetings, startChat, startMeeting } from "@/app/(apps)/chat/actions";
import { meetHref } from "@/app/(apps)/meet/shared";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Public origin: behind the proxy, req.nextUrl.origin is the container's (http://0.0.0.0:3000). */
function origin(req: NextRequest): string {
  try {
    return new URL(env.appUrl).origin;
  } catch {
    return req.nextUrl.origin;
  }
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;

function back(req: NextRequest, error: string) {
  const url = new URL("/chat", origin(req));
  url.searchParams.set("meetError", error);
  return NextResponse.redirect(url, 303);
}

export async function GET(req: NextRequest) {
  // A GET with side effects: only from our own pages (blocks cross-site links and embeds).
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return back(req, "forbidden");

  const sp = req.nextUrl.searchParams;
  let conv = sp.get("c");
  const withEmail = sp.get("with");
  if (!conv && withEmail) {
    if (!EMAIL.test(withEmail)) return back(req, "invalid");
    const name = (sp.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    const dm = await startChat([{ email: withEmail, name }], null);
    if (!dm.ok) return back(req, dm.error);
    conv = dm.data;
  }
  if (!conv) return back(req, "invalid");

  const meetings = await getMeetings(conv);
  if (!meetings.ok) return back(req, meetings.error);
  let code = meetings.data.ongoing?.code ?? null;
  if (!code) {
    const started = await startMeeting(conv);
    if (!started.ok) return back(req, started.error);
    code = started.data.code;
  }
  return NextResponse.redirect(new URL(meetHref(code), origin(req)), 303);
}
