// iCalendar (RFC 5545) invitations and plain MIME mail for booking pages, sent from the owner's
// own mailbox through JMAP (Email/import + EmailSubmission/set) with the owner's booking key.
// Must run inside asHost(). Every user-supplied value is escaped for its context: iCalendar text
// escaping + line folding, RFC 2047 encoded words in headers (no CR/LF can reach a header), and
// HTML escaping in the HTML body.
import { randomUUID } from "node:crypto";
import { requireSession } from "../auth";
import { env } from "../env";
import { CAP, jmap, JmapError } from "../jmap";

/* ------------------------------------------------------------- iCalendar */

const icsText = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n").replace(/[\u0000-\u001f\u007f]/g, "");
/** Parameter values (CN): quoted, so no DQUOTE or control characters may appear. */
const icsParam = (v: string) => `"${v.replace(/["\u0000-\u001f\u007f]/g, "").slice(0, 120)}"`;
const icsDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsAddress = (email: string) => `mailto:${email.replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]/g, "")}`;

/** Folds a content line at 75 octets without splitting a UTF-8 sequence (RFC 5545 §3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch);
    if (bytes + len > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += len;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export type IcsInput = {
  method: "REQUEST" | "CANCEL";
  uid: string;
  sequence: number;
  start: number;
  end: number;
  title: string;
  description: string;
  location: string;
  url?: string;
  organizer: { name: string; email: string };
  attendee: { name: string; email: string };
};

export function buildIcs(e: IcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Zentico//Booking pages//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${icsText(e.uid)}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(e.url ? [`URL:${icsText(e.url)}`] : []),
    `ORGANIZER;CN=${icsParam(e.organizer.name)}:${icsAddress(e.organizer.email)}`,
    `ATTENDEE;CN=${icsParam(e.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${e.method === "CANCEL" ? "DECLINED" : "NEEDS-ACTION"};RSVP=${e.method === "CANCEL" ? "FALSE" : "TRUE"}:${icsAddress(e.attendee.email)}`,
    `STATUS:${e.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------- HTML */

export const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Only http(s) links into this workspace are ever put in an href. */
const safeHref = (url: string) => (/^https?:\/\/[^\s"'<>]+$/.test(url) ? escapeHtml(url) : "#");

export type MailBlock = { kind: "p"; text: string } | { kind: "rows"; rows: [string, string][] } | { kind: "link"; label: string; url: string };

export function renderHtml(heading: string, blocks: MailBlock[]): string {
  const body = blocks
    .map((b) => {
      if (b.kind === "p") return `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(b.text).replace(/\n/g, "<br>")}</p>`;
      if (b.kind === "link") {
        return `<p style="margin:0 0 10px"><a href="${safeHref(b.url)}" style="color:#3b6cf6">${escapeHtml(b.label)}</a></p>`;
      }
      const rows = b.rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#737373;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:4px 0;color:#0a0a0a">${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`,
        )
        .join("");
      return `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;font-size:14px">${rows}</table>`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#0a0a0a"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ebebeb;border-radius:12px;padding:24px"><h1 style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(heading)}</h1>${body}</div></body></html>`;
}

export function renderText(heading: string, blocks: MailBlock[]): string {
  const parts = [heading, ""];
  for (const b of blocks) {
    if (b.kind === "p") parts.push(b.text, "");
    else if (b.kind === "link") parts.push(`${b.label}: ${b.url}`);
    else parts.push(...b.rows.map(([k, v]) => `${k}: ${v}`), "");
  }
  return parts.join("\n").trim() + "\n";
}

/* ------------------------------------------------------------------- MIME */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
/** RFC 2047 encoded word when needed; never lets CR/LF through. */
function headerText(v: string): string {
  const clean = v.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}
const headerAddress = (a: { name: string; email: string }) => {
  const name = a.name.replace(/["\\]/g, "");
  if (!name) return `<${a.email}>`;
  return /^[\x20-\x7e]*$/.test(name) ? `"${headerText(name)}" <${a.email}>` : `${headerText(name)} <${a.email}>`;
};

export type Outgoing = {
  from: { name: string; email: string };
  to: { name: string; email: string };
  subject: string;
  text: string;
  html: string;
  ics?: { method: "REQUEST" | "CANCEL"; content: string };
};

export function buildMime(m: Outgoing): string {
  const outer = `zb-${randomUUID()}`;
  const alt = `za-${randomUUID()}`;
  const domain = m.from.email.split("@")[1] || "localhost";
  const head = [
    `From: ${headerAddress(m.from)}`,
    `To: ${headerAddress(m.to)}`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];
  const part = (type: string, body: string, extra: string[] = []) =>
    [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", b64(body)].join("\r\n");
  const alternatives = [
    part('text/plain; charset="UTF-8"', m.text),
    part('text/html; charset="UTF-8"', m.html),
    ...(m.ics ? [part(`text/calendar; charset="UTF-8"; method=${m.ics.method}`, m.ics.content)] : []),
  ];
  const altBody = [`Content-Type: multipart/alternative; boundary="${alt}"`, "", ...alternatives.map((p) => `--${alt}\r\n${p}`), `--${alt}--`].join("\r\n");
  if (!m.ics) return [...head, altBody].join("\r\n") + "\r\n";
  const file = m.ics.method === "CANCEL" ? "cancel.ics" : "invite.ics";
  const attachment = part(`application/ics; name="${file}"`, m.ics.content, [`Content-Disposition: attachment; filename="${file}"`]);
  return [...head, `Content-Type: multipart/mixed; boundary="${outer}"`, "", `--${outer}`, altBody, `--${outer}`, attachment, `--${outer}--`, ""].join("\r\n");
}

/* --------------------------------------------------------------- sending */

const USING = [CAP.core, CAP.mail, CAP.submission];

type Raw = Record<string, unknown>;

/**
 * Sends a raw message from the current (owner) session: uploads it, imports it into Sent (or, with
 * `keep: false`, destroys it once submitted) and submits it to `rcpt`.
 */
export async function sendRaw(mime: string, rcpt: string[], { keep }: { keep: boolean }): Promise<void> {
  const { accessToken, email } = await requireSession();
  const sres = await fetch(`${env.issuer}/jmap/session`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!sres.ok) throw new JmapError(`JMAP session failed: ${sres.status}`);
  const session = (await sres.json()) as { uploadUrl?: string; primaryAccounts?: Record<string, string> };
  const accountId = session.primaryAccounts?.[CAP.mail];
  if (!accountId || !session.uploadUrl) throw new JmapError("No mail account");

  const up = await fetch(session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "message/rfc822" },
    body: mime,
    cache: "no-store",
  });
  if (!up.ok) throw new JmapError(`Upload failed: ${up.status}`);
  const { blobId } = (await up.json()) as { blobId: string };

  const meta = await jmap(
    [
      ["Mailbox/get", { accountId, properties: ["id", "role"] }, "m"],
      ["Identity/get", { accountId, properties: ["id", "email"] }, "i"],
    ],
    USING,
  );
  const boxes = (meta.m.list as Raw[]) ?? [];
  const box = boxes.find((b) => b.role === "sent") ?? boxes.find((b) => b.role === "drafts") ?? boxes[0];
  const identities = (meta.i.list as Raw[]) ?? [];
  const identity = identities.find((i) => String(i.email).toLowerCase() === email.toLowerCase()) ?? identities[0];
  if (!box || !identity) throw new JmapError("No mailbox or identity to send from");

  const imp = await jmap(
    [["Email/import", { accountId, emails: { m: { blobId, mailboxIds: { [String(box.id)]: true }, keywords: { $seen: true } } } }, "e"]],
    USING,
  );
  const emailId = (imp.e.created as Record<string, { id: string }> | undefined)?.m?.id;
  if (!emailId) throw new JmapError(`Email/import failed: ${JSON.stringify(imp.e.notCreated ?? {}).slice(0, 200)}`);

  const sub = await jmap(
    [
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            s: {
              identityId: String(identity.id),
              emailId,
              envelope: { mailFrom: { email: String(identity.email), parameters: null }, rcptTo: rcpt.map((e) => ({ email: e, parameters: null })) },
            },
          },
          ...(keep ? {} : { onSuccessDestroyEmail: ["#s"] }),
        },
        "s",
      ],
    ],
    USING,
  );
  if (!(sub.s.created as Raw | undefined)?.s) throw new JmapError(`EmailSubmission failed: ${JSON.stringify(sub.s.notCreated ?? {}).slice(0, 200)}`);
}
