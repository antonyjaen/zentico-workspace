import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { shellOf } from "@/lib/ui/service";
import { appHref, SAFE_COOKIE } from "@/lib/ui/workspace";

/** Landing app after sign-in: ui.json shell.home (Mail by default, and in safe mode). */
export default async function Home() {
  let target = "/mail";
  try {
    const session = await getSession();
    const safe = (await cookies()).get(SAFE_COOKIE)?.value === "1";
    if (session && !safe) target = appHref(shellOf(session.email).prefs.home);
  } catch (e) {
    console.error("[ui] home:", e instanceof Error ? e.message : e);
  }
  redirect(target);
}
