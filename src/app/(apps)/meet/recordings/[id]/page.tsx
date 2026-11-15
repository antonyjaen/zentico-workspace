import { notFound } from "next/navigation";
import { RecordingView } from "./RecordingView";
import { requireSession } from "@/lib/auth";
import { boot } from "@/lib/meetings/jobs";
import { getMeetingDetail } from "@/lib/meetings/store";
import { whisperConfig } from "@/lib/meetings/transcribe";
import { MEETING_ID } from "../../recording";

export const dynamic = "force-dynamic";

export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!MEETING_ID.test(id)) notFound();
  const session = await requireSession();
  boot();
  const detail = getMeetingDetail(id, session.email);
  if (!detail) notFound();

  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-y-auto">
      <RecordingView detail={detail} transcriptionConfigured={!!whisperConfig()} />
    </main>
  );
}
