"use client";

// Zentico UI everywhere in the workspace: the pages and apps the user added to the rail, and the
// keyboard shortcuts of their keys.json. The data comes from the server render (stored UI, no Drive
// call), is refreshed when the window regains focus, and is pushed by the Dashboard when it changes.
// Shortcuts are ignored while typing (inputs, textareas, contenteditable) and when another handler
// already took the key.
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseKey, type KeyBinding, type UiShell } from "@/lib/ui/schema";

type Ctx = { shell: UiShell; setShell: (s: UiShell) => void; refresh: () => void };
const ShellContext = createContext<Ctx | null>(null);

export const EMPTY_SHELL: UiShell = { pages: [], apps: [], keys: [] };

export function useUiShell(): Ctx {
  return useContext(ShellContext) ?? { shell: EMPTY_SHELL, setShell: () => {}, refresh: () => {} };
}

/** Events the Dashboard listens to (keys.json actions that act on it). */
export const UI_EVENT = "zw-ui-action";
export type UiActionEvent = { action: "claude" | "edit" | "gallery" } | { action: "mod"; mod: string; command: string };

const APP_HREF: Record<string, string> = {
  mail: "/mail",
  calendar: "/calendar",
  chat: "/chat",
  drive: "/drive",
  meet: "/meet",
  contacts: "/contacts",
  dashboard: "/dashboard",
  settings: "/settings",
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** "ctrl+shift+k"-style chord of a keyboard event (letters/digits by physical key, so Alt works on Mac). */
function chordOf(e: KeyboardEvent): string | null {
  let key = "";
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else {
    const map: Record<string, string> = {
      " ": "space",
      "/": "slash",
      "\\": "backslash",
      ",": "comma",
      ".": "period",
      ";": "semicolon",
      "'": "quote",
      "[": "bracketleft",
      "]": "bracketright",
      "-": "minus",
      "=": "equal",
      "`": "backquote",
    };
    key = map[e.key] ?? e.key.toLowerCase();
  }
  if (["control", "shift", "alt", "meta"].includes(key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  return [...mods, key].join("+");
}

/** Normalized binding chords, with "mod" resolved to ctrl or meta for this platform. */
function bindingChords(b: KeyBinding): string[] {
  const parsed = parseKey(b.key);
  if (!("chords" in parsed)) return [];
  const mac = isMac();
  return parsed.chords.map((c) => {
    const parts = c.split("+");
    const key = parts.pop()!;
    const mods = new Set(parts.map((m) => (m === "mod" ? (mac ? "meta" : "ctrl") : m)));
    return [...["ctrl", "alt", "shift", "meta"].filter((m) => mods.has(m)), key].join("+");
  });
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.("[contenteditable=true],[role=textbox]");
}

export function UiShellProvider({ initial, children }: { initial: UiShell; children: ReactNode }) {
  const [shell, setShell] = useState<UiShell>(initial);
  const router = useRouter();
  const pathname = usePathname();
  const pending = useRef<{ chord: string; at: number } | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/ui/shell", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: UiShell | null) => s && Array.isArray(s.pages) && setShell(s))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const bindings = useMemo(() => shell.keys.map((b) => ({ b, chords: bindingChords(b) })).filter((x) => x.chords.length), [shell.keys]);

  useEffect(() => {
    if (!bindings.length) return;
    const run = (b: KeyBinding) => {
      switch (b.action) {
        case "goto": {
          const app = shell.apps.find((a) => a.pageId === b.page);
          router.push(app ? `/x/${app.id}` : `/dashboard/${b.page}`);
          break;
        }
        case "open":
          router.push(b.href ?? APP_HREF[b.app ?? "dashboard"] ?? "/dashboard");
          break;
        default: {
          const detail: UiActionEvent = b.action === "mod" ? { action: "mod", mod: b.mod, command: b.command } : { action: b.action };
          const onStudio = pathname.startsWith("/dashboard") || pathname.startsWith("/x/");
          if (!onStudio && b.action !== "mod") {
            try {
              sessionStorage.setItem("zw-ui-pending", JSON.stringify(detail));
            } catch {}
            router.push("/dashboard");
          } else window.dispatchEvent(new CustomEvent(UI_EVENT, { detail }));
        }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || typing(e.target)) return;
      const chord = chordOf(e);
      if (!chord) return;
      const now = Date.now();
      const prev = pending.current && now - pending.current.at < 1200 ? pending.current.chord : null;
      if (prev) {
        const seq = bindings.find((x) => x.chords.length === 2 && x.chords[0] === prev && x.chords[1] === chord);
        if (seq) {
          pending.current = null;
          e.preventDefault();
          run(seq.b);
          return;
        }
      }
      const single = bindings.find((x) => x.chords.length === 1 && x.chords[0] === chord);
      if (single) {
        pending.current = null;
        e.preventDefault();
        run(single.b);
        return;
      }
      pending.current = bindings.some((x) => x.chords.length === 2 && x.chords[0] === chord) ? { chord, at: now } : null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings, router, pathname, shell.apps]);

  const value = useMemo(() => ({ shell, setShell, refresh }), [shell, refresh]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
