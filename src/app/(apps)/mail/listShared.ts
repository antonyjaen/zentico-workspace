// Client-safe helpers shared by the mail list and the folder nav.
import type { Mailbox, MailboxRole } from "@/lib/mail";

export const DENSITY_COOKIE = "zw_density";
export type Density = "comfortable" | "compact";
export const parseDensity = (value: string | undefined): Density =>
  value === "compact" ? "compact" : "comfortable";

/** Drag payload type and the window event the nav fires when rows are dropped on a folder. */
export const DRAG_MIME = "application/x-zentico-mail";
export const DROP_EVENT = "zentico:mail-drop";
export type DropDetail = { keys: string[]; mailboxId: string };

export type MailboxLite = Pick<Mailbox, "id" | "name" | "role" | "parentId"> & { unreadEmails?: number };

/** Mailboxes in display order (input order kept per level) with their nesting depth. */
export function mailboxTree<T extends { id: string; parentId: string | null }>(
  mailboxes: T[],
): { mailbox: T; depth: number }[] {
  const ids = new Set(mailboxes.map((m) => m.id));
  const children = new Map<string | null, T[]>();
  for (const m of mailboxes) {
    const parent = m.parentId && ids.has(m.parentId) ? m.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), m]);
  }
  const out: { mailbox: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const m of children.get(parent) ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ mailbox: m, depth });
      walk(m.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export type { MailboxRole };
