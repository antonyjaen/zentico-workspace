// URL state for the contacts app: everything lives in search params on /contacts.

export type ContactsView = { q?: string; book?: string; group?: string; id?: string; edit?: boolean; new?: boolean };

export function contactsHref(view: ContactsView) {
  const p = new URLSearchParams();
  if (view.q) p.set("q", view.q);
  if (view.book) p.set("book", view.book);
  if (view.group) p.set("group", view.group);
  if (view.id) p.set("id", view.id);
  if (view.edit) p.set("edit", "1");
  if (view.new) p.set("new", "1");
  const s = p.toString();
  return s ? `/contacts?${s}` : "/contacts";
}

/** Deterministic two-hue gradient (same recipe as the account avatar). */
export function avatarGradient(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${a}), oklch(0.62 0.18 ${b}))`;
}

export function initials(name: string) {
  // "Antony Jaén (zentico.dev)" → "AJ": drop parenthesized/bracketed suffixes and addresses first.
  const base = name.replace(/\s*[([<][^)\]>]*[)\]>]\s*/g, " ").replace(/\S+@\S+/g, " ").trim() || name.split("@")[0];
  const parts = base.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}
