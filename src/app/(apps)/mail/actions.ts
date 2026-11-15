"use server";

// Shared mail mutations used by the list, the reader, the sidebar and keyboard shortcuts.
// Message actions take an optional `account` (shared mailboxes live in other JMAP accounts);
// it is validated against the session and defaults to the user's own account.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { jmap } from "@/lib/jmap";
import { getMailboxes, resolveAccount, type Mailbox, type MailboxRole } from "@/lib/mail";
import { LABEL_COLOR_NAMES, LABEL_ID, MAX_LABELS, labelKeyword, slugify, type Label, type LabelColor } from "@/lib/mail-labels";
import { getLabels, line, readConfigForUpdate, writeConfig } from "@/lib/mail-settings";

const ID = /^[A-Za-z0-9_-]{1,255}$/;
function cleanIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new Error("Invalid ids");
  for (const id of ids) if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid id");
  return ids;
}

async function patchEmails(ids: string[], patch: Record<string, unknown>, account?: string) {
  const accountId = await resolveAccount(account);
  const update = Object.fromEntries(cleanIds(ids).map((id) => [id, patch]));
  const r = await jmap([["Email/set", { accountId, update }, "s"]]);
  const notUpdated = r.s.notUpdated as Record<string, unknown> | undefined;
  if (notUpdated && Object.keys(notUpdated).length) throw new Error("Some messages could not be updated");
  revalidatePath("/mail", "layout");
}

/** Marks messages read (`seen = true`) or unread. */
export async function setSeen(ids: string[], seen: boolean, account?: string) {
  await patchEmails(ids, { "keywords/$seen": seen ? true : null }, account);
}

/** Stars (flags) or unstars messages. */
export async function setFlagged(ids: string[], flagged: boolean, account?: string) {
  await patchEmails(ids, { "keywords/$flagged": flagged ? true : null }, account);
}

/** Adds or removes a label (custom keyword `zwl_<id>`) on messages. */
export async function setLabel(ids: string[], labelId: string, on: boolean, account?: string) {
  if (typeof labelId !== "string" || !LABEL_ID.test(labelId)) throw new Error("Invalid label");
  await patchEmails(ids, { [`keywords/${labelKeyword(labelId)}`]: on ? true : null }, account);
}

/** Moves messages into exactly one mailbox. */
export async function moveTo(ids: string[], mailboxId: string, account?: string) {
  if (!ID.test(mailboxId)) throw new Error("Invalid mailbox");
  await patchEmails(ids, { mailboxIds: { [mailboxId]: true } }, account);
}

/** Moves messages to the mailbox with a special role (archive, trash, junk, inbox). */
export async function moveToRole(ids: string[], role: Exclude<MailboxRole, null>, account?: string) {
  const accountId = await resolveAccount(account);
  const box = (await getMailboxes(accountId)).find((m) => m.role === role);
  await moveTo(ids, box?.id ?? (await createRoleMailbox(role, accountId)), accountId);
}

const ROLE_NAMES: Partial<Record<string, string>> = { archive: "Archive", junk: "Junk Mail", trash: "Deleted Items" };

/** Accounts don't always come with an Archive (or Junk/Trash) folder; create it on first use. */
async function createRoleMailbox(role: string, accountId: string): Promise<string> {
  const name = ROLE_NAMES[role];
  if (!name) throw new Error(`No ${role} mailbox`);
  const created = await createMailbox(accountId, { name, role });
  if ("error" in created) throw new Error(`Could not create ${role} mailbox: ${created.error}`);
  return created.id;
}

/** Permanently deletes messages (use for items already in Trash/Spam). */
export async function destroyEmails(ids: string[], account?: string) {
  const accountId = await resolveAccount(account);
  await jmap([["Email/set", { accountId, destroy: cleanIds(ids) }, "d"]]);
  revalidatePath("/mail", "layout");
}

/* ------------------------------------------------------------------ folders */

export type FolderResult = { ok: true; id?: string } | { ok: false; error: string; detail?: string };

type SetError = { type?: string; description?: string; properties?: string[] };

/**
 * Mailbox/set create. No explicit nulls; if the server insists on a JSON-LD `@type`
 * (Stalwart does for some objects), retry once with it.
 */
async function createMailbox(
  accountId: string,
  props: Record<string, unknown>,
): Promise<{ id: string } | { error: string; detail?: string }> {
  const attempt = async (p: Record<string, unknown>) => {
    const r = await jmap([["Mailbox/set", { accountId, create: { box: p } }, "m"]]);
    const created = (r.m.created as Record<string, { id: string }> | undefined)?.box;
    const err = (r.m.notCreated as Record<string, SetError> | undefined)?.box;
    return { id: created?.id, err };
  };
  let res = await attempt(props);
  if (!res.id && /@type/i.test(JSON.stringify(res.err ?? ""))) res = await attempt({ "@type": "Mailbox", ...props });
  if (res.id) return { id: res.id };
  return { error: res.err?.type ?? "unknown", detail: res.err?.description };
}

function folderName(v: unknown): string {
  const name = line(v, 100, { required: true });
  if (/[/\\]/.test(name)) throw new Error("invalidName");
  return name;
}

async function folderGuard(fn: () => Promise<FolderResult>): Promise<FolderResult> {
  try {
    return await fn();
  } catch (e) {
    unstable_rethrow(e);
    const msg = e instanceof Error ? e.message : "";
    if (["invalid", "invalidName"].includes(msg)) return { ok: false, error: msg };
    console.error("[mail] folder action failed:", e);
    return { ok: false, error: "server" };
  }
}

const siblingsClash = (boxes: Mailbox[], name: string, parentId: string | null, except?: string) =>
  boxes.some((m) => m.id !== except && (m.parentId ?? null) === parentId && m.name.toLowerCase() === name.toLowerCase());

/** Creates a folder at the top level or under `parentId`. */
export async function createFolder(input: { name: string; parentId?: string | null; account?: string }): Promise<FolderResult> {
  return folderGuard(async () => {
    const accountId = await resolveAccount(input.account);
    const name = folderName(input.name);
    const boxes = await getMailboxes(accountId);
    const parentId = input.parentId && boxes.some((m) => m.id === input.parentId) ? input.parentId : null;
    if (siblingsClash(boxes, name, parentId)) return { ok: false, error: "exists" };
    const res = await createMailbox(accountId, parentId ? { name, parentId } : { name });
    if ("error" in res) return { ok: false, error: res.error, detail: res.detail };
    revalidatePath("/mail", "layout");
    return { ok: true, id: res.id };
  });
}

async function updateMailbox(accountId: string, id: string, patch: Record<string, unknown>): Promise<FolderResult> {
  const r = await jmap([["Mailbox/set", { accountId, update: { [id]: patch } }, "m"]]);
  const err = (r.m.notUpdated as Record<string, SetError> | undefined)?.[id];
  if (err) return { ok: false, error: err.type ?? "unknown", detail: err.description };
  revalidatePath("/mail", "layout");
  return { ok: true, id };
}

async function ownFolder(id: string, account?: string) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid");
  const accountId = await resolveAccount(account);
  const boxes = await getMailboxes(accountId);
  const box = boxes.find((m) => m.id === id);
  if (!box) throw new Error("invalid");
  return { accountId, boxes, box };
}

export async function renameFolder(input: { id: string; name: string; account?: string }): Promise<FolderResult> {
  return folderGuard(async () => {
    const { accountId, boxes, box } = await ownFolder(input.id, input.account);
    if (box.role) return { ok: false, error: "system" };
    const name = folderName(input.name);
    if (siblingsClash(boxes, name, box.parentId, box.id)) return { ok: false, error: "exists" };
    return updateMailbox(accountId, box.id, { name });
  });
}

/** Moves a folder under another one (or to the top level with `parentId: null`). */
export async function moveFolder(input: { id: string; parentId: string | null; account?: string }): Promise<FolderResult> {
  return folderGuard(async () => {
    const { accountId, boxes, box } = await ownFolder(input.id, input.account);
    if (box.role) return { ok: false, error: "system" };
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (!boxes.some((m) => m.id === parentId)) return { ok: false, error: "invalid" };
      // Not into itself or one of its descendants.
      for (let p: string | null = parentId, guard = 0; p && guard < 50; guard++) {
        if (p === box.id) return { ok: false, error: "cycle" };
        p = boxes.find((m) => m.id === p)?.parentId ?? null;
      }
    }
    if (siblingsClash(boxes, box.name, parentId, box.id)) return { ok: false, error: "exists" };
    return updateMailbox(accountId, box.id, { parentId });
  });
}

/**
 * Deletes an empty-of-subfolders folder. Its messages are moved to Trash first (messages that
 * are also in other folders just lose this one), then the mailbox is destroyed.
 */
export async function deleteFolder(input: { id: string; account?: string }): Promise<FolderResult> {
  return folderGuard(async () => {
    const { accountId, boxes, box } = await ownFolder(input.id, input.account);
    if (box.role) return { ok: false, error: "system" };
    if (boxes.some((m) => m.parentId === box.id)) return { ok: false, error: "hasChildren" };

    if (box.totalEmails > 0) {
      const trashId =
        boxes.find((m) => m.role === "trash")?.id ?? (await createRoleMailbox("trash", accountId));
      for (let round = 0; round < 40; round++) {
        const q = await jmap([["Email/query", { accountId, filter: { inMailbox: box.id }, limit: 500 }, "q"]]);
        const ids = (q.q.ids as string[] | undefined) ?? [];
        if (!ids.length) break;
        const update = Object.fromEntries(
          ids.map((id) => [id, { [`mailboxIds/${box.id}`]: null, [`mailboxIds/${trashId}`]: true }]),
        );
        const r = await jmap([["Email/set", { accountId, update }, "s"]]);
        const nu = r.s.notUpdated as Record<string, unknown> | undefined;
        if (nu && Object.keys(nu).length) return { ok: false, error: "notEmpty" };
      }
    }

    const r = await jmap([["Mailbox/set", { accountId, destroy: [box.id], onDestroyRemoveEmails: false }, "d"]]);
    const err = (r.d.notDestroyed as Record<string, SetError> | undefined)?.[box.id];
    if (err) return { ok: false, error: err.type === "mailboxHasEmail" ? "notEmpty" : (err.type ?? "unknown"), detail: err.description };
    revalidatePath("/mail", "layout");
    return { ok: true };
  });
}

/* ------------------------------------------------------------------- labels */

export type LabelResult = { ok: true; label?: Label } | { ok: false; error: string; detail?: string };

async function labelGuard(fn: () => Promise<LabelResult>): Promise<LabelResult> {
  try {
    return await fn();
  } catch (e) {
    unstable_rethrow(e);
    const msg = e instanceof Error ? e.message : "";
    if (["invalid", "unavailable", "unreadable"].includes(msg)) return { ok: false, error: msg };
    console.error("[mail] label action failed:", e);
    return { ok: false, error: "server" };
  }
}

const cleanColor = (c: unknown): LabelColor => (LABEL_COLOR_NAMES.includes(c as LabelColor) ? (c as LabelColor) : "gray");

async function saveLabels(labels: Label[]): Promise<LabelResult | null> {
  const config = await readConfigForUpdate();
  const err = await writeConfig({ ...config, labels }, await getMailboxes(), { activate: false });
  if (err) return { ok: false, error: String(err.type ?? "unknown"), detail: typeof err.description === "string" ? err.description : undefined };
  revalidatePath("/mail", "layout");
  return null;
}

export async function createLabel(input: { name: string; color?: string }): Promise<LabelResult> {
  return labelGuard(async () => {
    const name = line(input?.name, 60, { required: true });
    const { labels } = await readConfigForUpdate();
    const existing = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) return { ok: true, label: existing };
    if (labels.length >= MAX_LABELS) return { ok: false, error: "tooMany" };
    let id = slugify(name);
    for (let i = 2; labels.some((l) => l.id === id); i++) id = `${slugify(name).slice(0, 36)}-${i}`;
    const label: Label = { id, name, color: cleanColor(input.color) };
    return (await saveLabels([...labels, label])) ?? { ok: true, label };
  });
}

/** Renames/recolors a label. The keyword (id) stays the same, so tagged mail keeps it. */
export async function updateLabel(input: { id: string; name?: string; color?: string }): Promise<LabelResult> {
  return labelGuard(async () => {
    const { labels } = await readConfigForUpdate();
    const current = labels.find((l) => l.id === input?.id);
    if (!current) return { ok: false, error: "invalid" };
    const next: Label = {
      ...current,
      name: input.name === undefined ? current.name : line(input.name, 60, { required: true }),
      color: input.color === undefined ? current.color : cleanColor(input.color),
    };
    return (await saveLabels(labels.map((l) => (l.id === current.id ? next : l)))) ?? { ok: true, label: next };
  });
}

/** Deletes a label: removes its keyword from every message, then its definition and filter actions. */
export async function deleteLabel(input: { id: string }): Promise<LabelResult> {
  return labelGuard(async () => {
    if (typeof input?.id !== "string" || !LABEL_ID.test(input.id)) return { ok: false, error: "invalid" };
    const config = await readConfigForUpdate();
    const keyword = labelKeyword(input.id);
    const accountId = await resolveAccount();
    for (let round = 0; round < 40; round++) {
      const q = await jmap([["Email/query", { accountId, filter: { hasKeyword: keyword }, limit: 500 }, "q"]]);
      const ids = (q.q.ids as string[] | undefined) ?? [];
      if (!ids.length) break;
      const update = Object.fromEntries(ids.map((id) => [id, { [`keywords/${keyword}`]: null }]));
      const r = await jmap([["Email/set", { accountId, update }, "s"]]);
      const nu = r.s.notUpdated as Record<string, unknown> | undefined;
      if (nu && Object.keys(nu).length === ids.length) break; // nothing could be changed: don't spin
    }
    // Drop the label from filter rules; rules left without actions are removed.
    const rules = config.rules
      .map((r) => ({ ...r, actions: r.actions.filter((a) => !(a.type === "label" && a.target === input.id)) }))
      .filter((r) => r.actions.length);
    const err = await writeConfig(
      { rules, labels: config.labels.filter((l) => l.id !== input.id) },
      await getMailboxes(),
      { activate: false },
    );
    if (err) return { ok: false, error: String(err.type ?? "unknown") };
    revalidatePath("/mail", "layout");
    return { ok: true };
  });
}

/* ------------------------------------------------------------------- search */

/** Folders and labels for the advanced search form (loaded when it opens). */
export async function getSearchScopes(): Promise<{
  folders: { id: string; name: string; role: MailboxRole; parentId: string | null }[];
  labels: Label[];
}> {
  const [boxes, labels] = await Promise.all([getMailboxes().catch(() => []), getLabels()]);
  return { folders: boxes.map(({ id, name, role, parentId }) => ({ id, name, role, parentId })), labels };
}
