import { AppRail } from "@/components/AppRail";
import { MeetingProvider } from "./meet/MeetingProvider";
import { NotificationsProvider } from "@/components/notifications/NotificationsProvider";
import { VersionWatcher } from "@/components/VersionWatcher";
import { TopBar } from "@/components/TopBar";
import { requireSession } from "@/lib/auth";

export default async function AppsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <NotificationsProvider>
      {/* Owns the live call so it survives moving between apps (mini window outside Meet). */}
      <MeetingProvider>
        <div className="flex h-dvh overflow-hidden">
          <AppRail />
          <VersionWatcher />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar session={session} />
            <div className="flex min-h-0 flex-1 pr-2 pb-2 md:pr-3 md:pb-3">{children}</div>
          </div>
        </div>
      </MeetingProvider>
    </NotificationsProvider>
  );
}
