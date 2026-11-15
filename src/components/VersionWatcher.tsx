"use client";

import { RotateCw } from "lucide-react";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

/**
 * After a deploy, tabs that stay open keep the old bundle, whose server actions no longer exist
 * on the server and fail silently. Detect the new build and offer a reload.
 */
export function VersionWatcher() {
  const locale = useLocale();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!BUILD) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const { build } = (await r.json()) as { build?: string };
        if (build && build !== BUILD) setStale(true);
      } catch {
        /* offline or signed out: try again later */
      }
    };
    const id = setInterval(check, 5 * 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!stale) return null;
  const es = locale === "es";
  return (
    <div role="status" className="pop fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 px-4 py-2.5 text-[13.5px]">
      <span className="text-ink-soft">{es ? "Hay una versión nueva de Zentico Workspace." : "A new version of Zentico Workspace is available."}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-ink hover:bg-primary-hover"
      >
        <RotateCw size={14} aria-hidden />
        {es ? "Recargar" : "Reload"}
      </button>
    </div>
  );
}
