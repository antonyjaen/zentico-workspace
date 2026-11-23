"use server";

// Server actions backing the composer. All inputs are validated in src/lib/mail-compose.ts.
import { revalidatePath } from "next/cache";
import { parseCompose } from "../hrefs";
import * as compose from "@/lib/mail-compose";
import type { Address, ComposePrefill, Identity } from "@/lib/mail-compose";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (!(e instanceof compose.ComposeError)) console.error("[compose]", e instanceof Error ? e.message : e);
    // Only surface our own validation messages; hide internals.
    return { ok: false, error: e instanceof compose.ComposeError ? e.message : "unexpected" };
  }
}

/** `?account=` from the client: a string or nothing (validated by resolveAccount in lib). */
const accountArg = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Identities plus the prefill for a `compose` search param value. `account` is the mailbox account
 * being viewed (the original message is read from it).
 */
export async function loadCompose(
  value: string,
  account?: string | null,
): Promise<Result<{ identities: Identity[]; prefill: ComposePrefill }>> {
  return run(async () => {
    const parsed = parseCompose(typeof value === "string" ? value : null);
    if (!parsed) throw new compose.ComposeError("Invalid compose mode");
    const [identities, prefill] = await Promise.all([
      compose.getIdentities(),
      compose.getPrefill(parsed.mode, parsed.emailId, accountArg(account)),
    ]);
    return { identities, prefill };
  });
}

/**
 * Autosaves a draft (in the identity's account); returns the new draft id. `final` refreshes
 * mailbox counts. `previousAccount`: the account the previous draft version lives in.
 */
export async function saveDraftAction(input: unknown, previousId: string | null, final = false, previousAccount?: string | null) {
  const r = await run(() => compose.saveDraft(input, previousId, accountArg(previousAccount)));
  if (final) revalidatePath("/mail", "layout");
  return r;
}

export async function discardDraftAction(draftId: string | null, account?: string | null) {
  const r = await run(() => compose.discardDraft(draftId, accountArg(account)));
  revalidatePath("/mail", "layout");
  return r;
}

export async function sendAction(input: unknown, draftId: string | null, draftAccount?: string | null) {
  const r = await run(() => compose.sendMessage(input, draftId, accountArg(draftAccount)));
  revalidatePath("/mail", "layout");
  return r;
}

export async function suggestContactsAction(query: string): Promise<Address[]> {
  if (typeof query !== "string") return [];
  return compose.suggestContacts(query);
}
