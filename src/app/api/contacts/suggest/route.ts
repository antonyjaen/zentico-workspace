import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { suggestRecipients } from "@/lib/contacts";

/** Mail autocomplete: GET /api/contacts/suggest?q=ana → [{ name, email }] (max 8). */
export async function GET(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (q.length < 1 || q.length > 100) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  try {
    const results = await suggestRecipients(q, 8);
    return NextResponse.json(results, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // Contacts capability missing or server error: autocomplete simply has no suggestions.
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  }
}
