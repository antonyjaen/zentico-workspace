import { AppRail } from "@/components/AppRail";
import { CallsProvider } from "@/components/calls/CallsProvider";
import { MeetingProvider } from "./meet/MeetingProvider";
import { NotificationsProvider } from "@/components/notifications/NotificationsProvider";
import { VersionWatcher } from "@/components/VersionWatcher";
import { TopBar } from "@/components/TopBar";
import { UiShellProvider } from "@/components/UiShell";
import { requireSession } from "@/lib/auth";
import type { UiShell } from "@/lib/ui/schema";
import { shellOf } from "@/lib/ui/service";

export default async function AppsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  let shell: UiShell = { pages: [], apps: [], keys: [] };
  try {
    shell = shellOf(session.email);
  } catch (e) {
    console.error("[ui] shell:", e instanceof Error ? e.message : e);
  }

  return (
    <UiShellProvider initial={shell}>
      <NotificationsProvider>
        {/* Owns the live call so it survives moving between apps (mini window outside Meet). */}
        <MeetingProvider>
          {/* Ringing calls: incoming modal and outgoing state on every page. */}
          <CallsProvider email={session.email}>
            <div className="flex h-dvh overflow-hidden">
              <AppRail />
              <VersionWatcher />
              <div className="flex min-w-0 flex-1 flex-col">
                <TopBar session={session} />
                <div className="flex min-h-0 flex-1 pr-2 pb-2 md:pr-3 md:pb-3">{children}</div>
              </div>
            </div>
          </CallsProvider>
        </MeetingProvider>
      </NotificationsProvider>
    </UiShellProvider>
  );
}
