"use client";

// The top bar's gear menu. It is the guaranteed way back from any customization: always rendered
// (ui.json can't hide it, checkUi rejects trying), drawn in fixed default tokens (`zw-safe`, so a
// theme can't make it unreadable), and it always offers "Restore default UI", safe mode and the
// built-in apps hidden from the rail.
import { Blocks, LifeBuoy, RotateCcw, Settings, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { BUILTIN_HREF, SAFE_PATH } from "@/lib/ui/workspace";
import { openCustomize, useUiShell } from "./UiShell";
import { usePopover } from "./usePopover";
import { useWorkspaceUi } from "./WorkspaceUi";

const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-ink-soft transition-colors hover:bg-hover hover:text-ink";

export function SettingsMenu() {
  const t = useTranslations("dashboard.workspace");
  const ta = useTranslations("apps");
  const { open, toggle, setOpen, ref } = usePopover();
  const { shell } = useUiShell();
  const ws = useWorkspaceUi();
  const [busy, setBusy] = useState(false);
  const hidden = shell.prefs.rail.hidden.filter((h) => BUILTIN_HREF[h]);

  return (
    <div ref={ref} className="zw-safe relative">
      <button type="button" className="icon-btn" aria-label={t("settingsMenu")} title={t("settingsMenu")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <Settings size={19} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-12 z-[90] w-72 p-1.5">
          <Link href="/mail/settings" onClick={() => setOpen(false)} className={item} role="menuitem">
            <Settings size={16} aria-hidden /> {t("mailSettings")}
          </Link>
          <Link href="/settings/apps" onClick={() => setOpen(false)} className={item} role="menuitem">
            <Blocks size={16} aria-hidden /> {t("appSettings")}
          </Link>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              openCustomize();
            }}
          >
            <Sparkles size={16} aria-hidden />
            <span className="flex-1">{t("customize")}</span>
            <span className="kbd !w-auto">{t("customizeHint")}</span>
          </button>
          {hidden.length > 0 && (
            <div className="border-t border-line px-3 pt-2 pb-1">
              <p className="text-[12px] text-ink-mute">{t("hiddenApps")}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {hidden.map((h) => (
                  <Link key={h} href={BUILTIN_HREF[h]} onClick={() => setOpen(false)} className="rounded-md border border-line px-2 py-0.5 text-[12.5px] text-ink-soft hover:bg-hover hover:text-ink">
                    {ta(h)}
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              className={`${item} disabled:opacity-50`}
              onClick={async () => {
                if (!window.confirm(t("restoreConfirm"))) return;
                setBusy(true);
                const ok = ws ? await ws.restore() : false;
                setBusy(false);
                setOpen(false);
                if (!ws || !ok) window.location.href = SAFE_PATH;
              }}
            >
              <RotateCcw size={16} aria-hidden /> {t("restore")}
            </button>
            <a href={SAFE_PATH} className={item} role="menuitem">
              <LifeBuoy size={16} aria-hidden /> {t("safeMode")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
