"use client";

// Short developer guide for Chat apps and incoming webhooks (with curl examples).
import { BookOpen } from "lucide-react";
import { useTranslations } from "next-intl";

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-sheet-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink-soft">
      {children}
    </pre>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 text-[13.5px] font-semibold text-ink">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{children}</p>;
}

export function ApiGuide({ appUrl }: { appUrl: string }) {
  const t = useTranslations("apps.guide");
  const code = (chunks: React.ReactNode) => <code className="rounded bg-sheet-muted px-1 font-mono text-[12px]">{chunks}</code>;

  const webhookCurl = `curl -X POST '${appUrl}/api/chat/hooks/<id>?key=<key>' \\
  -H 'Content-Type: application/json' \\
  -d '{"text": "Deploy **OK** ✅", "thread": {"key": "deploy-42"}}'`;

  const cardCurl = `curl -X POST '${appUrl}/api/chat/hooks/<id>?key=<key>' \\
  -H 'Content-Type: application/json' \\
  -d '{
  "cardsV2": [{ "cardId": "build", "card": {
    "header": { "title": "Build #42", "subtitle": "main" },
    "sections": [{ "widgets": [
      { "textParagraph": { "text": "<b>Passed</b> in 3m 12s" } },
      { "buttonList": { "buttons": [
        { "text": "Open", "onClick": { "openLink": { "url": "https://ci.example.com/42" } } }
      ] } }
    ] }]
  } }]
}'`;

  const simpleCard = `{ "text": "New lead",
  "cards": [{ "title": "ACME Corp", "subtitle": "Website form",
    "text": "Wants a demo next week",
    "buttons": [{ "text": "Open in CRM", "url": "https://crm.example.com/l/9" }] }] }`;

  const event = `POST <your endpoint>
Content-Type: application/json
X-Zentico-Event: message            # message | slash_command | added_to_space | removed_from_space
X-Zentico-Delivery: 5b1c…
X-Zentico-Signature: t=1763300000,v1=9f2c…   # HMAC-SHA256(secret, "<t>.<raw body>")

{
  "type": "message",
  "eventTime": "2026-11-16T10:00:00.000Z",
  "deliveryId": "5b1c…",
  "bot": { "id": "…", "name": "Deploy bot", "handle": "deploy-bot" },
  "user": { "email": "ana@example.com", "name": "Ana López" },
  "conversation": { "id": "k3j…", "kind": "channel", "name": "releases" },
  "thread": { "root": null },
  "message": { "id": 812, "text": "@deploy-bot status", "argumentText": "status",
               "createdAt": "…", "threadRoot": null },
  "command": { "name": "deploy", "args": "web prod" }      // slash_command only
}`;

  const verify = `import { createHmac, timingSafeEqual } from "node:crypto";

function verify(signatureHeader, rawBody, secret) {
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // replay window
  const expected = createHmac("sha256", secret).update(\`\${parts.t}.\${rawBody}\`).digest("hex");
  return parts.v1?.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}`;

  const reply = `HTTP/1.1 200 OK
Content-Type: application/json

{ "text": "Deploying *web* to prod… 🚀" }`;

  const botApi = `curl -X POST '${appUrl}/api/chat/bots/messages' \\
  -H 'Authorization: Bearer zwbot_…' \\
  -H 'Content-Type: application/json' \\
  -d '{"conversationId": "k3j…", "text": "Deploy finished ✅", "threadRoot": 812}'`;

  return (
    <section id="guide" className="rounded-xl border border-line p-4">
      <div className="flex items-center gap-2">
        <BookOpen size={17} className="text-ink-mute" aria-hidden />
        <h2 className="text-[14.5px] font-semibold text-ink">{t("title")}</h2>
      </div>
      <P>{t("intro")}</P>

      <H>{t("webhooksTitle")}</H>
      <P>{t.rich("webhooksBody", { code })}</P>
      <Code>{webhookCurl}</Code>
      <P>{t("cardsBody")}</P>
      <Code>{cardCurl}</Code>
      <P>{t("simpleCards")}</P>
      <Code>{simpleCard}</Code>

      <H>{t("eventsTitle")}</H>
      <P>{t("eventsBody")}</P>
      <Code>{event}</Code>
      <P>{t("verifyBody")}</P>
      <Code>{verify}</Code>

      <H>{t("replyTitle")}</H>
      <P>{t("replyBody")}</P>
      <Code>{reply}</Code>
      <P>{t.rich("asyncBody", { code })}</P>
      <Code>{botApi}</Code>

      <H>{t("limitsTitle")}</H>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-ink-soft">
        <li>{t("limit1")}</li>
        <li>{t("limit2")}</li>
        <li>{t("limit3")}</li>
        <li>{t("limit4")}</li>
        <li>{t("limit5")}</li>
      </ul>
    </section>
  );
}
