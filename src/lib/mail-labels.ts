// Client-safe label helpers. Labels are custom JMAP keywords (`zwl_<slug>`); their display names
// and colors live in the JSON header of the "zentico-filters" Sieve script (see mail-settings.ts).

export const LABEL_PREFIX = "zwl_";
export const MAX_LABELS = 100;

/** Label slug: lowercase ASCII, digits and dashes (valid inside an IMAP flag / JMAP keyword). */
export const LABEL_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const LABEL_COLORS = {
  gray: "#8a8f98",
  red: "#e5484d",
  orange: "#f76b15",
  amber: "#e2a336",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#3e63dd",
  violet: "#8e4ec6",
  pink: "#d6409f",
} as const;
export type LabelColor = keyof typeof LABEL_COLORS;
export const LABEL_COLOR_NAMES = Object.keys(LABEL_COLORS) as LabelColor[];

export type Label = { id: string; name: string; color: LabelColor };

export const labelKeyword = (id: string) => `${LABEL_PREFIX}${id}`;

/** Label ids present in a keywords map. */
export const labelsOf = (keywords: Record<string, boolean> | undefined) =>
  Object.keys(keywords ?? {})
    .filter((k) => keywords![k] && k.toLowerCase().startsWith(LABEL_PREFIX))
    .map((k) => k.slice(LABEL_PREFIX.length).toLowerCase());

/** Turns a display name into a slug; falls back to a random id for non-Latin names. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s && LABEL_ID.test(s) ? s : `l${Math.random().toString(36).slice(2, 8)}`;
}
