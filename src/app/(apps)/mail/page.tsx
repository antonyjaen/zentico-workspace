import { redirect } from "next/navigation";
import { getMailboxes } from "@/lib/mail";

export default async function MailIndex() {
  const mailboxes = await getMailboxes();
  const inbox = mailboxes.find((m) => m.role === "inbox") ?? mailboxes[0];
  if (!inbox) return null;
  redirect(`/mail/${inbox.id}`);
}
