import { getTranslations } from "next-intl/server";
import { notFound, unstable_rethrow } from "next/navigation";
import { threadHref } from "../../../hrefs";
import { ThreadView } from "./ThreadClient";
import { getSession } from "@/lib/auth";
import { getMailboxes, type Mailbox } from "@/lib/mail";
import { getThread, type ReadMessage } from "@/lib/mail-read";

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ mailboxId: string; threadId: string }>;
  searchParams: Promise<{ images?: string }>;
}) {
  const { mailboxId, threadId } = await params;
  const allowImages = (await searchParams).images === "1";
  const t = await getTranslations("mailRead");
  const tf = await getTranslations("mail.folders");

  let messages: ReadMessage[] | null;
  let mailboxes: Mailbox[];
  try {
    [messages, mailboxes] = await Promise.all([getThread(threadId, { allowRemoteImages: allowImages }), getMailboxes()]);
  } catch (e) {
    unstable_rethrow(e);
    return <p className="p-8 text-[15px] text-ink-soft">{t("error")}</p>;
  }
  if (!messages?.length) notFound();

  const session = await getSession();
  const me = session?.email.toLowerCase() ?? null;
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const hidden = new Set(mailboxes.filter((m) => m.role === "sent" || m.role === "drafts").map((m) => m.id));

  // Move actions target the messages in the mailbox the thread was opened from; from search,
  // everything except the user's own sent messages and drafts.
  const inScope = messages.filter((m) =>
    mailbox ? m.mailboxIds[mailbox.id] : !Object.keys(m.mailboxIds).every((id) => hidden.has(id)),
  );
  const actionIds = (inScope.length ? inScope : messages).map((m) => m.id);
  const unreadIds = messages.filter((m) => !m.keywords.$seen && !m.keywords.$draft).map((m) => m.id);
  const latest = messages[messages.length - 1];
  const basePath = threadHref(mailboxId, threadId);
  const currentPath = allowImages ? `${basePath}?images=1` : basePath;
  const anyRemote = !allowImages && messages.some((m) => m.hasRemoteImages);
  const subject = latest.subject || messages.find((m) => m.subject)?.subject || t("noSubject");

  // Mailbox chips: every folder the conversation lives in (the open one first), minus Drafts.
  const label = (m: Mailbox) => (m.role && tf.has(m.role) ? tf(m.role) : m.name);
  const boxIds = new Set(messages.flatMap((m) => Object.keys(m.mailboxIds).filter((id) => m.mailboxIds[id])));
  const labels = mailboxes
    .filter((m) => boxIds.has(m.id) && m.role !== "drafts")
    .sort((a, b) => Number(b.id === mailboxId) - Number(a.id === mailboxId))
    .map(label);

  return (
    <ThreadView
      key={threadId}
      messages={messages}
      me={me}
      backHref={mailbox ? `/mail/${mailbox.id}` : mailboxId === "search" ? null : "/mail"}
      role={mailbox?.role ?? null}
      actionIds={actionIds}
      unreadIds={unreadIds}
      currentPath={currentPath}
      imagesHref={anyRemote ? `${basePath}?images=1` : null}
      subject={subject}
      labels={labels}
    />
  );
}
