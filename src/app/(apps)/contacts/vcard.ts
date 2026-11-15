// Minimal vCard (2.1/3.0/4.0) reader and 3.0 writer for import/export.
// Handles FN, N, EMAIL, TEL, ORG, TITLE, NOTE, ADR, BDAY; everything else is ignored.
import type { Contact, ContactInput, EmailLabel, PhoneLabel } from "@/lib/contacts";

type Prop = { name: string; params: Record<string, string[]>; value: string };

const unescape = (v: string) => v.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** Splits on `sep` unless the separator is backslash-escaped. */
function splitEscaped(v: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === "\\" && i + 1 < v.length) {
      cur += ch + v[++i];
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseLine(line: string): Prop | null {
  // Find the first ':' that is not inside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";");
  const name = rawName.replace(/^[^.]*\./, "").toUpperCase();
  const params: Record<string, string[]> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    // vCard 2.1 allows bare types: TEL;CELL:...
    const key = eq < 0 ? "TYPE" : p.slice(0, eq).toUpperCase();
    const vals = (eq < 0 ? p : p.slice(eq + 1)).replace(/"/g, "").split(",");
    params[key] = [...(params[key] ?? []), ...vals.map((v) => v.toLowerCase())];
  }
  return { name, params, value: line.slice(colon + 1) };
}

const clip = (s: string, n: number) => s.trim().slice(0, n);

export function parseVcards(text: string, addressBookId: string, max = 1000): ContactInput[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: ContactInput[] = [];
  let cur: Prop[] | null = null;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VCARD") cur = [];
    else if (upper === "END:VCARD" && cur) {
      const c = toInput(cur, addressBookId);
      if (c) out.push(c);
      cur = null;
      if (out.length >= max) break;
    } else if (cur) {
      const p = parseLine(line);
      if (p) cur.push(p);
    }
  }
  return out;
}

function toInput(props: Prop[], addressBookId: string): ContactInput | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const all = (n: string) => props.filter((p) => p.name === n);
  const types = (p: Prop) => p.params.TYPE ?? [];

  const n = get("N") ? splitEscaped(get("N")!.value, ";").map(unescape) : [];
  let surname = clip(n[0] ?? "", 200);
  let given = clip([n[1], n[2]].filter(Boolean).join(" "), 200);
  const fn = clip(unescape(get("FN")?.value ?? ""), 200);
  if (!given && !surname && fn) {
    const parts = fn.split(/\s+/);
    surname = parts.length > 1 ? parts.pop()! : "";
    given = parts.join(" ");
  }

  const emails = all("EMAIL")
    .map((p) => {
      const t = types(p);
      const label: EmailLabel = t.includes("work") ? "work" : t.includes("home") ? "home" : "other";
      return { label, value: clip(unescape(p.value).replace(/^mailto:/i, ""), 254) };
    })
    .filter((e) => e.value.includes("@"))
    .slice(0, 10);

  const phones = all("TEL")
    .map((p) => {
      const t = types(p);
      const label: PhoneLabel = t.includes("cell") || t.includes("mobile")
        ? "mobile"
        : t.includes("work")
          ? "work"
          : t.includes("home")
            ? "home"
            : "other";
      return { label, value: clip(unescape(p.value).replace(/^tel:/i, ""), 50) };
    })
    .filter((p) => p.value)
    .slice(0, 10);

  const adr = get("ADR") ? splitEscaped(get("ADR")!.value, ";").map(unescape) : [];
  const bdayRaw = (get("BDAY")?.value ?? "").trim();
  const bday = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(bdayRaw) ?? /^--(\d{2})-?(\d{2})/.exec(bdayRaw);
  const birthday = !bday ? "" : bday.length === 4 ? `${bday[1]}-${bday[2]}-${bday[3]}` : `--${bday[1]}-${bday[2]}`;

  const input: ContactInput = {
    given,
    surname,
    emails,
    phones,
    company: clip(unescape(splitEscaped(get("ORG")?.value ?? "", ";")[0] ?? ""), 200),
    title: clip(unescape(get("TITLE")?.value ?? ""), 200),
    address: {
      street: clip([adr[1], adr[2]].filter(Boolean).join(" "), 300),
      locality: clip(adr[3] ?? "", 200),
      region: clip(adr[4] ?? "", 200),
      postcode: clip(adr[5] ?? "", 40),
      country: clip(adr[6] ?? "", 200),
    },
    birthday,
    notes: clip(unescape(get("NOTE")?.value ?? ""), 5000),
    addressBookId,
  };
  if (!input.given && !input.surname && !emails.length && !phones.length && !input.company) return null;
  return input;
}

// ---------- Writer ----------

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** Folds a content line at 75 characters (RFC 6350 §3.2). */
function fold(line: string): string {
  const chars = Array.from(line);
  if (chars.length <= 75) return line;
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += i === 0 ? 75 : 74) parts.push(chars.slice(i, i + (i === 0 ? 75 : 74)).join(""));
  return parts.join("\r\n ");
}

const EMAIL_TYPE: Record<EmailLabel, string> = { work: ";TYPE=WORK", home: ";TYPE=HOME", other: "" };
const TEL_TYPE: Record<PhoneLabel, string> = { mobile: ";TYPE=CELL", work: ";TYPE=WORK", home: ";TYPE=HOME", other: "" };

export function toVcard(c: Contact): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `UID:${esc(c.uid)}`];
  lines.push(`FN:${esc(c.displayName)}`);
  lines.push(`N:${esc(c.surname)};${esc(c.given)};;;`);
  for (const e of c.emails) lines.push(`EMAIL${EMAIL_TYPE[e.label]}:${esc(e.value)}`);
  for (const p of c.phones) lines.push(`TEL${TEL_TYPE[p.label]}:${esc(p.value)}`);
  if (c.company) lines.push(`ORG:${esc(c.company)}`);
  if (c.title) lines.push(`TITLE:${esc(c.title)}`);
  if (c.address) {
    const a = c.address;
    lines.push(`ADR:;;${[a.street, a.locality, a.region, a.postcode, a.country].map(esc).join(";")}`);
  }
  if (c.birthday) lines.push(`BDAY:${c.birthday}`);
  if (c.notes) lines.push(`NOTE:${esc(c.notes)}`);
  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n");
}
