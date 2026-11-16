import { MessageSquare } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { chatUser } from "@/lib/chat/session";
import { overview } from "@/lib/chat/store";
import { ChatApp } from "./ChatApp";
import { isConversationId, type ChatOverview } from "./shared";
import { isTaskId } from "./tasks-shared";

export const dynamic = "force-dynamic";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ c?: string; task?: string }> }) {
  const { c, task } = await searchParams;
  let data: ChatOverview;
  try {
    data = overview(await chatUser());
  } catch (e) {
    unstable_rethrow(e);
    console.error("[chat] page:", e instanceof Error ? e.message : e);
    const t = await getTranslations("chat");
    return (
      <main className="sheet grid flex-1 place-items-center p-10 text-center">
        <div className="rise max-w-sm">
          <span
            className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted"
            style={{ color: "var(--color-app-chat)" }}
          >
            <MessageSquare size={26} aria-hidden />
          </span>
          <p className="mt-6 text-[17px] font-medium text-ink">{t("unavailable")}</p>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">{t("unavailableHint")}</p>
        </div>
      </main>
    );
  }
  return <ChatApp initial={data} initialId={isConversationId(c) ? c : null} initialTask={isConversationId(c) && isTaskId(task) ? task : null} />;
}
