import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { MeetRoom } from "../MeetRoom";
import { NotConfigured } from "../NotConfigured";
import { requireSession } from "@/lib/auth";
import { isValidRoom, livekitConfig } from "@/lib/livekit";
import { egressConfig } from "@/lib/meetings/egress";

export default async function MeetRoomPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  if (!isValidRoom(room)) notFound();
  const session = await requireSession();
  const t = await getTranslations("meet");

  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
      {livekitConfig() ? (
        <MeetRoom room={room} name={session.name || session.email} email={session.email} videoRecording={!!egressConfig()} />
      ) : (
        <NotConfigured title={t("notConfigured")} hint={t("notConfiguredHint")} />
      )}
    </main>
  );
}
