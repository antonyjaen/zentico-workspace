// Validates what apps and webhooks post: { text, cards | cardsV2 } (a subset of Google Chat's
// formats) → a message body plus normalized cards. Unknown widgets are dropped; links must be
// http(s). Server-only (pure functions).
import { BODY_MAX, type BotCard, type CardButton } from "@/app/(apps)/chat/shared";

export const MAX_CARDS = 5;
const MAX_SECTIONS = 10;
const MAX_BUTTONS = 10;
const TITLE_MAX = 200;
const TEXT_MAX = 4000;
const URL_MAX = 2000;

export class CardError extends Error {}

// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim().slice(0, max);
  return s || undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Google Chat card text is a small HTML subset: turn it into our Markdown-lite. */
function htmlToMarkdown(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|strong)>/gi, "**")
    .replace(/<\/?(i|em)>/gi, "_")
    .replace(/<\/?(s|strike|del)>/gi, "~~")
    .replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => `[${label.replace(/<[^>]+>/g, "")}](${href})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "");
}

function cardText(v: unknown): string | undefined {
  const s = clean(v, TEXT_MAX * 2);
  return s ? clean(htmlToMarkdown(s), TEXT_MAX) : undefined;
}

function safeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > URL_MAX) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function button(text: unknown, url: unknown): CardButton | null {
  const label = clean(text, 80);
  const href = safeUrl(url);
  return label && href ? { text: label, url: href } : null;
}

/** onClick.openLink.url (cardsV2 / legacy). */
const openLink = (b: Record<string, unknown> | null) => obj(obj(obj(b?.onClick)?.openLink))?.url ?? obj(b?.onClick)?.url ?? b?.url;

/** Our own simple format: { title, subtitle, text, buttons: [{ text, url }] } or with sections. */
function simpleCard(c: Record<string, unknown>): BotCard {
  const sections: BotCard["sections"] = [];
  const top = { text: cardText(c.text), buttons: arr(c.buttons).map((b) => button(obj(b)?.text, obj(b)?.url)).filter((b): b is CardButton => !!b) };
  if (top.text || top.buttons.length) sections.push({ ...(top.text ? { text: top.text } : {}), ...(top.buttons.length ? { buttons: top.buttons.slice(0, MAX_BUTTONS) } : {}) });
  for (const s of arr(c.sections)) {
    const so = obj(s);
    if (!so) continue;
    const buttons = arr(so.buttons).map((b) => button(obj(b)?.text, obj(b)?.url)).filter((b): b is CardButton => !!b).slice(0, MAX_BUTTONS);
    const section = { header: clean(so.header, TITLE_MAX), text: cardText(so.text), buttons };
    if (section.header || section.text || buttons.length) sections.push(compact(section));
  }
  return { title: clean(c.title, TITLE_MAX), subtitle: clean(c.subtitle, TITLE_MAX), sections };
}

function compact(s: { header?: string; text?: string; buttons?: CardButton[] }) {
  return {
    ...(s.header ? { header: s.header } : {}),
    ...(s.text ? { text: s.text } : {}),
    ...(s.buttons?.length ? { buttons: s.buttons } : {}),
  };
}

/** Google Chat widgets (cardsV2 and legacy cards) → text and link buttons. */
function widgetsToSection(widgets: unknown[], header?: string) {
  const texts: string[] = [];
  const buttons: CardButton[] = [];
  for (const w of widgets) {
    const wo = obj(w);
    if (!wo) continue;
    const para = obj(wo.textParagraph);
    if (para) {
      const t = cardText(para.text);
      if (t) texts.push(t);
    }
    const kv = obj(wo.decoratedText) ?? obj(wo.keyValue);
    if (kv) {
      const parts = [cardText(kv.topLabel), cardText(kv.text ?? kv.content), cardText(kv.bottomLabel)].filter(Boolean);
      if (parts.length) texts.push(parts.join(" · "));
      const b = obj(kv.button);
      const bt = b && button(b.text ?? obj(b.textButton)?.text, openLink(b) ?? openLink(obj(b.textButton)));
      if (bt) buttons.push(bt);
    }
    // cardsV2: { buttonList: { buttons: [{ text, onClick: { openLink: { url } } }] } }
    for (const b of arr(obj(wo.buttonList)?.buttons)) {
      const bo = obj(b);
      const bt = bo && button(bo.text, openLink(bo));
      if (bt) buttons.push(bt);
    }
    // legacy: { buttons: [{ textButton: { text, onClick: { openLink: { url } } } }] }
    for (const b of arr(wo.buttons)) {
      const tb = obj(obj(b)?.textButton);
      const bt = tb && button(tb.text, openLink(tb));
      if (bt) buttons.push(bt);
    }
  }
  const text = texts.join("\n").slice(0, TEXT_MAX);
  return compact({ header, text: text || undefined, buttons: buttons.slice(0, MAX_BUTTONS) });
}

function googleCard(c: Record<string, unknown>): BotCard {
  const header = obj(c.header);
  const sections: BotCard["sections"] = [];
  for (const s of arr(c.sections).slice(0, MAX_SECTIONS)) {
    const so = obj(s);
    if (!so) continue;
    const section = widgetsToSection(arr(so.widgets), clean(so.header, TITLE_MAX));
    if (Object.keys(section).length) sections.push(section);
  }
  return { title: clean(header?.title, TITLE_MAX), subtitle: clean(header?.subtitle, TITLE_MAX), sections };
}

const isGoogleCard = (c: Record<string, unknown>) => !!obj(c.header) || arr(c.sections).some((s) => Array.isArray(obj(s)?.widgets));

/** Normalizes `cards` (ours or Google's legacy) and `cardsV2` ([{ cardId, card }]). */
export function parseCards(input: { cards?: unknown; cardsV2?: unknown }): BotCard[] {
  const raw: Record<string, unknown>[] = [];
  for (const c of arr(input.cardsV2)) {
    const card = obj(obj(c)?.card);
    if (card) raw.push(card);
  }
  for (const c of arr(input.cards)) {
    const co = obj(c);
    if (co) raw.push(co);
  }
  if (raw.length > MAX_CARDS) throw new CardError("tooManyCards");
  const out: BotCard[] = [];
  for (const c of raw) {
    const card = isGoogleCard(c) ? googleCard(c) : simpleCard(c);
    if (card.title || card.subtitle || card.sections.length) out.push(dropEmpty(card));
  }
  return out;
}

function dropEmpty(c: BotCard): BotCard {
  return { ...(c.title ? { title: c.title } : {}), ...(c.subtitle ? { subtitle: c.subtitle } : {}), sections: c.sections.slice(0, MAX_SECTIONS) };
}

/** A whole app/webhook message: text (≤ BODY_MAX) and cards. Throws CardError("empty"/"tooLong"/…). */
export function parseBotMessage(input: unknown): { body: string; cards: BotCard[] } {
  const o = obj(input);
  if (!o) throw new CardError("invalid");
  if (o.text != null && typeof o.text !== "string") throw new CardError("invalid");
  const text = typeof o.text === "string" ? o.text.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > BODY_MAX) throw new CardError("tooLong");
  const cards = parseCards(o);
  if (!text && !cards.length) throw new CardError("empty");
  return { body: text, cards };
}

/** Plain-text rendering of cards (previews, MCP, Claude context). */
export function cardsToText(cards: BotCard[] | undefined): string {
  if (!cards?.length) return "";
  return cards
    .map((c) =>
      [
        [c.title, c.subtitle].filter(Boolean).join(" — "),
        ...c.sections.map((s) => [s.header, s.text, ...(s.buttons ?? []).map((b) => `[${b.text}](${b.url})`)].filter(Boolean).join("\n")),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}
