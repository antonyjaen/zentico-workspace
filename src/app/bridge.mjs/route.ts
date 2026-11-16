// Public download of the local bridge (tools/zentico-bridge.mjs), so the setup prompt in
// Settings → Integrations can fetch it with curl. It contains no secrets: the user's token is
// passed to it at run time. Included in the standalone output via outputFileTracingIncludes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-static";

const source = readFileSync(join(process.cwd(), "tools", "zentico-bridge.mjs"), "utf8");
const version = /const VERSION = "([^"]+)"/.exec(source)?.[1] ?? "unknown";

export function GET() {
  return new Response(source, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Disposition": 'inline; filename="zentico-bridge.mjs"',
      "Cache-Control": "public, max-age=300",
      "X-Zentico-Bridge-Version": version,
    },
  });
}
