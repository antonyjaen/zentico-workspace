"use client";

// Shared runtime of a Zentico UI page (Dashboard or rail app) for its blocks and mods: the current
// view, the page selection, confirmations, toasts, navigation, live events and edits.
import { createContext, useContext } from "react";
import type { ModGrant, PointerOp, UiView } from "@/lib/ui/schema";
import type { ChatState, TurnView } from "./model";

export type Selection = { kind: "mail.thread" | "chat.conversation" | "drive.file"; id: string; href?: string; label?: string };
export type LiveEvent = { category: "mail" | "chat" | "calendar"; kind: string; title: string; body: string; ref: string | null; at: number };
export type ConfirmRequest = { modId: string; modName: string; key: string; title: string; detail: string };

export type StudioApi = {
  view: UiView;
  pageId: string;
  editing: boolean;
  dark: boolean;
  /** Gap between blocks in px (theme density). */
  gap: number;
  /** Theme CSS custom properties of theme.json (resolved for the current color scheme), passed to mods. */
  userVars: Record<string, string>;
  chat: ChatState;
  grantOf: (modId: string) => ModGrant | undefined;
  setView: (v: UiView) => void;
  /** Asks the user (once per session per mod and action, unless "always allow"). */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  toast: (text: string) => void;
  openApp: (target: string) => void;
  navigate: (pageId: string) => void;
  selection: Selection | null;
  select: (s: Selection | null) => void;
  subscribeLive: (fn: (e: LiveEvent) => void) => () => void;
  subscribeCommand: (fn: (c: { mod: string; command: string; args?: unknown }) => void) => () => void;
  /** Resolves when the Claude turn of `commandId` finishes. */
  awaitTurn: (commandId: string) => Promise<TurnView>;
  /** Edits ui.json; returns an error message or null. */
  patch: (ops: PointerOp[]) => Promise<string | null>;
  askClaude: (prefill: string, send?: boolean) => void;
};

export const StudioContext = createContext<StudioApi | null>(null);

export function useStudio(): StudioApi {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio outside a Studio");
  return ctx;
}

export const APP_PATHS: Record<string, string> = {
  mail: "/mail",
  calendar: "/calendar",
  chat: "/chat",
  drive: "/drive",
  meet: "/meet",
  contacts: "/contacts",
  dashboard: "/dashboard",
  settings: "/settings",
};

/** A workspace path a page may navigate to (no protocol-relative or scheme URLs). */
export function safePath(target: string): string | null {
  if (APP_PATHS[target]) return APP_PATHS[target];
  if (target.length > 500 || !target.startsWith("/") || target.startsWith("//") || /[\s\\]/.test(target)) return null;
  return target;
}
