import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { MeetLanding } from "./MeetLanding";
import { NotConfigured } from "./NotConfigured";
import { requireSession } from "@/lib/auth";
import { livekitConfig, parseRecentRooms, RECENT_ROOMS_COOKIE } from "@/lib/livekit";
import { boot } from "@/lib/meetings/jobs";
import { listMeetings } from "@/lib/meetings/store";

export default async function MeetPage() {
  const session = await requireSession();
  const t = await getTranslations("meet");
  const configured = !!livekitConfig();
  const recent = parseRecentRooms((await cookies()).get(RECENT_ROOMS_COOKIE)?.value);
  boot();
  const recordings = await listMeetings(session.email, { limit: 20 }).catch((e) => {
    console.error("[meetings] list:", e instanceof Error ? e.message : e);
    return [];
  });

  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-y-auto">
      {configured ? (
        <MeetLanding recent={recent} recordings={recordings} />
      ) : (
        <NotConfigured title={t("notConfigured")} hint={t("notConfiguredHint")} />
      )}
    </main>
  );
}
