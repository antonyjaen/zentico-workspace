import { NextResponse } from "next/server";
import { toVcard } from "../vcard";
import { getSession } from "@/lib/auth";
import { getContactsData } from "@/lib/contacts";

/** Downloads every contact (groups excluded) as a single vCard 3.0 file. */
export async function GET() {
  if (!(await getSession())) return new NextResponse("Unauthorized", { status: 401 });
  try {
    const { contacts } = await getContactsData();
    const body = contacts.map(toVcard).join("\r\n") + (contacts.length ? "\r\n" : "");
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.vcf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse("Contacts aren't available on this server yet.", { status: 503 });
  }
}
