"use server";

// Shared mail mutations used by the list, the reader and keyboard shortcuts.
import { revalidatePath } from "next/cache";
import { CAP, jmap, primaryAccount } from "@/lib/jmap";
import { getMailboxes, type MailboxRole } from "@/lib/mail";

const ID = /^[A-Za-z0-9_-]{1,255}$/;
function cleanIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new Error("Invalid ids");
  for (const id of ids) if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid id");
  return ids;
}

async function patchEmails(ids: string[], patch: Record<string, unknown>) {
  const accountId = await primaryAccount(CAP.mail);
  const update = Object.fromEntries(cleanIds(ids).map((id) => [id, patch]));
  const r = await jmap([["Email/set", { accountId, update }, "s"]]);
  const notUpdated = r.s.notUpdated as Record<string, unknown> | undefined;
  if (notUpdated && Object.keys(notUpdated).length) throw new Error("Some messages could not be updated");
  revalidatePath("/mail", "layout");
}

/** Marks messages read (`seen = true`) or unread. */
export async function setSeen(ids: string[], seen: boolean) {
  await patchEmails(ids, { "keywords/$seen": seen ? true : null });
}

/** Stars (flags) or unstars messages. */
export async function setFlagged(ids: string[], flagged: boolean) {
  await patchEmails(ids, { "keywords/$flagged": flagged ? true : null });
}

/** Moves messages into exactly one mailbox. */
export async function moveTo(ids: string[], mailboxId: string) {
  if (!ID.test(mailboxId)) throw new Error("Invalid mailbox");
  await patchEmails(ids, { mailboxIds: { [mailboxId]: true } });
}

/** Moves messages to the mailbox with a special role (archive, trash, junk, inbox). */
export async function moveToRole(ids: string[], role: Exclude<MailboxRole, null>) {
  const box = (await getMailboxes()).find((m) => m.role === role);
  await moveTo(ids, box?.id ?? (await createRoleMailbox(role)));
}

const ROLE_NAMES: Partial<Record<string, string>> = { archive: "Archive", junk: "Junk Mail", trash: "Deleted Items" };

/** Accounts don't always come with an Archive (or Junk/Trash) folder; create it on first use. */
async function createRoleMailbox(role: string): Promise<string> {
  const name = ROLE_NAMES[role];
  if (!name) throw new Error(`No ${role} mailbox`);
  const accountId = await primaryAccount(CAP.mail);
  const r = await jmap([["Mailbox/set", { accountId, create: { box: { name, role } } }, "m"]]);
  const created = (r.m.created as Record<string, { id: string }> | undefined)?.box;
  if (!created) throw new Error(`Could not create ${role} mailbox: ${JSON.stringify(r.m.notCreated)}`);
  return created.id;
}

/** Permanently deletes messages (use for items already in Trash/Spam). */
export async function destroyEmails(ids: string[]) {
  const accountId = await primaryAccount(CAP.mail);
  await jmap([["Email/set", { accountId, destroy: cleanIds(ids) }, "d"]]);
  revalidatePath("/mail", "layout");
}
