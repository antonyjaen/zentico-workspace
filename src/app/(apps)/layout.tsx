import { AppRail } from "@/components/AppRail";
import { CallsProvider } from "@/components/calls/CallsProvider";
import { MeetingProvider } from "./meet/MeetingProvider";
import { NotificationsProvider } from "@/components/notifications/NotificationsProvider";
import { VersionWatcher } from "@/components/VersionWatcher";
import { TopBar } from "@/components/TopBar";
import { UiShellProvider } from "@/components/UiShell";
import { SideSlot, WorkspaceNotice, WorkspaceUiProvider } from "@/components/WorkspaceUi";
import { SecurityNudge } from "@/components/security/SecurityNudge";
import { requireSession } from "@/lib/auth";
import { getPolicy, statusOf } from "@/lib/security/store";
import { cookies } from "next/headers";
import { shellFromUi, type UiShell } from "@/lib/ui/schema";
import { shellOf } from "@/lib/ui/service";
import { SAFE_COOKIE } from "@/lib/ui/workspace";

export default async function AppsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  // Zentico UI shell + workspace theme, applied server-side (no flash). Safe mode ignores both; a
  // failure here falls back to the defaults so customization can never lock the user out.
  const safe = (await cookies()).get(SAFE_COOKIE)?.value === "1";
  let shell: UiShell = shellFromUi(null, [], safe);
  try {
    shell = shellOf(session.email, safe);
  } catch (e) {
    console.error("[ui] shell:", e instanceof Error ? e.message : e);
  }
  // Two-step verification nudge: recommended when off/unknown, a deadline during the grace period.
  const policy = getPolicy();
  const nudge = {
    show: statusOf(session.sub) !== true,
    deadline: policy.required && policy.enforceAfter > Date.now() ? policy.enforceAfter : null,
  };

  return (
    <UiShellProvider initial={shell}>
      <WorkspaceUiProvider>
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
                {nudge.show && <SecurityNudge deadline={nudge.deadline} />}
                <WorkspaceNotice />
                <div className="flex min-h-0 flex-1 pr-2 pb-2 md:pr-3 md:pb-3">
                  {children}
                  {/* ui.json shell.slots["<app>.side"]: a mod panel next to Mail, Chat, Calendar or Drive. */}
                  <SideSlot />
                </div>
              </div>
            </div>
          </CallsProvider>
        </MeetingProvider>
      </NotificationsProvider>
      </WorkspaceUiProvider>
    </UiShellProvider>
  );
}
