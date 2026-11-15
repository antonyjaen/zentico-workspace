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
    // Only surface our own validation messages; hide internals.
    return { ok: false, error: e instanceof compose.ComposeError ? e.message : "unexpected" };
  }
}

/** Identities plus the prefill for a `compose` search param value. */
export async function loadCompose(
  value: string,
): Promise<Result<{ identities: Identity[]; prefill: ComposePrefill }>> {
  return run(async () => {
    const parsed = parseCompose(typeof value === "string" ? value : null);
    if (!parsed) throw new compose.ComposeError("Invalid compose mode");
    const [identities, prefill] = await Promise.all([
      compose.getIdentities(),
      compose.getPrefill(parsed.mode, parsed.emailId),
    ]);
    return { identities, prefill };
  });
}

/** Autosaves a draft; returns the new draft id. `final` refreshes mailbox counts. */
export async function saveDraftAction(input: unknown, previousId: string | null, final = false) {
  const r = await run(() => compose.saveDraft(input, previousId));
  if (final) revalidatePath("/mail", "layout");
  return r;
}

export async function discardDraftAction(draftId: string | null) {
  const r = await run(() => compose.discardDraft(draftId));
  revalidatePath("/mail", "layout");
  return r;
}

export async function sendAction(input: unknown, draftId: string | null) {
  const r = await run(() => compose.sendMessage(input, draftId));
  revalidatePath("/mail", "layout");
  return r;
}

export async function suggestContactsAction(query: string): Promise<Address[]> {
  if (typeof query !== "string") return [];
  return compose.suggestContacts(query);
}
