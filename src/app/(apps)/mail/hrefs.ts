// Shared URL contracts between mail features (list, reader, composer).

/** Thread reader for a conversation opened from a mailbox (or "search"). */
export const threadHref = (mailboxId: string, threadId: string) => `/mail/${mailboxId}/t/${threadId}`;

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

/**
 * The composer is a floating panel mounted in the mail layout and driven by the `compose`
 * search param: `?compose=new`, `?compose=reply:<emailId>`, `?compose=draft:<emailId>`, ...
 * Pass the current path so the panel opens on top of what the user is looking at.
 */
export function composeHref(currentPath: string, mode: ComposeMode, emailId?: string) {
  const url = new URL(currentPath, "http://x");
  url.searchParams.set("compose", emailId ? `${mode}:${emailId}` : mode);
  return url.pathname + url.search;
}

export function parseCompose(value: string | null | undefined): { mode: ComposeMode; emailId?: string } | null {
  if (!value) return null;
  const [mode, emailId] = value.split(":") as [ComposeMode, string | undefined];
  if (!["new", "reply", "replyAll", "forward", "draft"].includes(mode)) return null;
  if (mode !== "new" && !emailId) return null;
  return { mode, emailId };
}
