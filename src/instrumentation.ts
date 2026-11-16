// Server start hook (Next.js instrumentation): resumes background work that must run without an
// open page — the GitHub app's subscription poller (lib/connect/github-app.ts) and the ringing-call
// timeouts (lib/chat/calls.ts). The imports sit inside the NEXT_RUNTIME check so the Edge build
// drops them.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { startIfNeeded } = await import("./lib/connect/github-app");
    startIfNeeded();
    // Calls left ringing by a restart stop (missed) or get their timeout back.
    const { sweepCalls } = await import("./lib/chat/calls");
    sweepCalls();
  }
}
