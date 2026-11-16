// Native app installers served from DATA_DIR/downloads (uploaded at release time, not in git).
// Only the names listed here can ever be served.
import { stat } from "node:fs/promises";
import { join } from "node:path";

export type Platform = "windows" | "android" | "ios" | "mac";

export const DOWNLOADS = {
  "zentico-workspace-windows.exe": { platform: "windows", kind: "exe", type: "application/vnd.microsoft.portable-executable" },
  "zentico-workspace-windows.msi": { platform: "windows", kind: "msi", type: "application/x-msi" },
  "zentico-workspace-android.apk": { platform: "android", kind: "apk", type: "application/vnd.android.package-archive" },
} as const satisfies Record<string, { platform: Platform; kind: string; type: string }>;

export type DownloadName = keyof typeof DOWNLOADS;

export const isDownloadName = (v: string): v is DownloadName => Object.hasOwn(DOWNLOADS, v);

export const downloadPath = (name: DownloadName) =>
  join(process.env.DATA_DIR || join(process.cwd(), "data"), "downloads", name);

export type AvailableDownload = { name: DownloadName; platform: Platform; kind: string; size: number };

/** Installers that are actually present on this server. */
export async function availableDownloads(): Promise<AvailableDownload[]> {
  const out: AvailableDownload[] = [];
  for (const name of Object.keys(DOWNLOADS) as DownloadName[]) {
    try {
      const s = await stat(downloadPath(name));
      if (s.isFile()) out.push({ name, platform: DOWNLOADS[name].platform, kind: DOWNLOADS[name].kind, size: s.size });
    } catch {
      // not uploaded
    }
  }
  return out;
}

/** Best guess of the visitor's platform from the User-Agent. */
export function platformFromUA(ua: string | null): Platform | null {
  if (!ua) return null;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/windows/i.test(ua)) return "windows";
  if (/macintosh|mac os x/i.test(ua)) return "mac";
  return null;
}
