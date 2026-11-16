// Runs the Android Gradle wrapper on any OS: `node gradle.mjs assembleDebug`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("./android/", import.meta.url));
const win = process.platform === "win32";
// Absolute path: some shells (NoDefaultCurrentDirectoryInExePath) don't look in the cwd.
const r = spawnSync(join(cwd, win ? "gradlew.bat" : "gradlew"), process.argv.slice(2), { cwd, stdio: "inherit", shell: win });
process.exit(r.status ?? 1);
