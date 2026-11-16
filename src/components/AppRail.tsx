"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import type { UiShell, UiShellApp } from "@/lib/ui/schema";
import { APPS, RAIL_APPS } from "./apps";
import { ChatUnreadBadge } from "./ChatUnreadBadge";
import { LogoMark } from "./Logo";
import { uiIcon } from "./uiIcons";
import { useUiShell } from "./UiShell";

const ITEM = "group flex w-full flex-col items-center gap-1 py-1.5 text-[11px] font-medium text-ink-mute transition-colors hover:text-ink aria-[current=page]:text-ink";
const ICON_BOX = "relative grid h-8 w-12 place-items-center rounded-lg transition-colors duration-150 group-hover:bg-hover group-aria-[current=page]:bg-primary-soft";

/** Rail apps (Zentico UI pages turned into apps): reorder / hide write ui.json through /api/ui. */
async function patchApps(shell: UiShell, ops: { pageId: string; key: "order" | "hidden"; value: number | boolean }[]) {
  const body = {
    action: "patch",
    ops: ops.map((o) => ({ op: "set", pointer: `/pages/${shell.pages.findIndex((p) => p.id === o.pageId)}/app/${o.key}`, value: o.value })),
  };
  if (body.ops.some((o) => o.pointer.includes("/-1/"))) return false;
  const res = await fetch("/api/ui", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return !!res?.ok;
}

function AppMenu({ app, apps, x, y, onClose }: { app: UiShellApp; apps: UiShellApp[]; x: number; y: number; onClose: () => void }) {
  const t = useTranslations("dashboard.rail");
  const { shell, refresh } = useUiShell();
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const i = apps.findIndex((a) => a.id === app.id);
  const move = async (to: number) => {
    const next = [...apps];
    const [it] = next.splice(i, 1);
    next.splice(to, 0, it);
    await patchApps(shell, next.map((a, k) => ({ pageId: a.pageId, key: "order" as const, value: k * 10 })));
    refresh();
  };
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        onClose();
        fn();
      }}
      className="flex w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-hover disabled:opacity-40"
    >
      {label}
    </button>
  );
  return (
    <div role="menu" className="pop fixed z-50 w-48 p-1" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {item(t("moveUp"), () => void move(i - 1), i <= 0)}
      {item(t("moveDown"), () => void move(i + 1), i >= apps.length - 1)}
      {item(t("hide"), () => void patchApps(shell, [{ pageId: app.pageId, key: "hidden", value: true }]).then(refresh))}
    </div>
  );
}

export function AppRail() {
  const t = useTranslations("apps");
  const pathname = usePathname();
  const { shell } = useUiShell();
  const [menu, setMenu] = useState<{ app: UiShellApp; x: number; y: number } | null>(null);
  // ui.json shell.rail: order (built-ins and "app:<path>" custom apps), hidden, labels.
  const { order, hidden, labels } = shell.prefs.rail;
  const visible = shell.apps.filter((a) => !a.hidden && !hidden.includes(`app:${a.id}`));
  const placed = new Set(order.filter((r) => r.startsWith("app:")).map((r) => r.slice(4)));
  const apps = visible.filter((a) => !placed.has(a.id));
  const pinned = shell.pages.filter((p) => p.pinned && !shell.apps.some((a) => a.pageId === p.id));
  const builtin = (id: string) => APPS.find((a) => a.id === id);
  const head: ({ kind: "builtin"; app: (typeof APPS)[number] } | { kind: "app"; app: UiShellApp })[] = [];
  for (const ref of order) {
    if (hidden.includes(ref)) continue;
    const b = !ref.startsWith("app:") ? builtin(ref) : undefined;
    const a = ref.startsWith("app:") ? visible.find((x) => x.id === ref.slice(4)) : undefined;
    if (b) head.push({ kind: "builtin", app: b });
    else if (a) head.push({ kind: "app", app: a });
  }
  for (const b of RAIL_APPS) if (!order.includes(b.id) && !hidden.includes(b.id)) head.push({ kind: "builtin", app: b });
  const label = (text: string) => (labels ? <span className="max-w-[64px] truncate">{text}</span> : <span className="sr-only">{text}</span>);

  const customLink = (a: UiShellApp) => {
    const Icon = uiIcon(a.icon);
    const href = `/x/${a.id}`;
    const active = pathname === href || pathname.startsWith(`${href}/`);
    const style: CSSProperties | undefined = active ? { color: a.color ?? "var(--color-accent)" } : undefined;
    return (
      <Link
        key={`a-${a.id}`}
        href={href}
        aria-current={active ? "page" : undefined}
        className={ITEM}
        title={a.name}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ app: a, x: e.clientX, y: e.clientY });
        }}
      >
        <span className={ICON_BOX}>
          <Icon size={19} strokeWidth={active ? 2.2 : 1.8} style={style} aria-hidden />
        </span>
        {label(a.name)}
      </Link>
    );
  };

  return (
    <nav aria-label={t("launcher")} className="hidden w-[72px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto py-3 md:flex">
      <Link href="/" className="mb-4 rounded-lg p-1" aria-label="Zentico Workspace">
        <LogoMark size={30} />
      </Link>
      {head.map((entry) => {
        if (entry.kind === "app") return customLink(entry.app);
        const { id, href, icon: Icon, color, match = [] } = entry.app;
        // Pinned dashboard pages get their own entry: the Dashboard entry isn't "current" on them.
        const onPinned = pinned.some((p) => pathname === `/dashboard/${p.id}`);
        const active = [href, ...match].some((p) => pathname === p || pathname.startsWith(`${p}/`)) && !(id === "dashboard" && onPinned);
        return (
          <Link key={id} href={href} aria-current={active ? "page" : undefined} className={ITEM} title={t(id)}>
            <span className={ICON_BOX}>
              {id === "chat" && <ChatUnreadBadge />}
              <Icon size={19} strokeWidth={active ? 2.2 : 1.8} style={active ? { color } : undefined} aria-hidden />
            </span>
            {label(t(id))}
          </Link>
        );
      })}
      {(pinned.length > 0 || apps.length > 0) && <span aria-hidden className="my-1.5 h-px w-8 bg-line" />}
      {pinned.map((p) => {
        const Icon = uiIcon(p.icon);
        const href = `/dashboard/${p.id}`;
        const active = pathname === href;
        return (
          <Link key={`p-${p.id}`} href={href} aria-current={active ? "page" : undefined} className={ITEM} title={p.title}>
            <span className={ICON_BOX}>
              <Icon size={19} strokeWidth={active ? 2.2 : 1.8} style={active ? { color: "var(--color-accent)" } : undefined} aria-hidden />
            </span>
            {label(p.title)}
          </Link>
        );
      })}
      {apps.map(customLink)}
      {menu && <AppMenu app={menu.app} apps={apps} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </nav>
  );
}
