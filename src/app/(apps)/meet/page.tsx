import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { MeetLanding } from "./MeetLanding";
import { NotConfigured } from "./NotConfigured";
import { requireSession } from "@/lib/auth";
import { livekitConfig, parseRecentRooms, RECENT_ROOMS_COOKIE } from "@/lib/livekit";

export default async function MeetPage() {
  await requireSession();
  const t = await getTranslations("meet");
  const configured = !!livekitConfig();
  const recent = parseRecentRooms((await cookies()).get(RECENT_ROOMS_COOKIE)?.value);

  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-y-auto">
      {configured ? (
        <MeetLanding recent={recent} />
      ) : (
        <NotConfigured title={t("notConfigured")} hint={t("notConfiguredHint")} />
      )}
    </main>
  );
}
