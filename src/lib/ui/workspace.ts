// Workspace-wide theme: when theme.json says `"scope": "workspace"`, its accent, radius, font,
// light/dark colors and the shell density are mapped onto the Tailwind tokens of globals.css for the
// whole app shell (every app), not just the Dashboard. Client-safe and pure: the contrast rules
// checkUi() enforces and the CSS the (apps) layout renders server-side (no flash). Only validated
// colors and fixed strings reach the CSS; theme.json `vars` stay Dashboard-only so they can't
// bypass the contrast checks.
import type { ModeOverride, UiTheme } from "./schema";

type Rgb = { r: number; g: number; b: number; a: number };

/** Parses hex (#rgb, #rgba, #rrggbb, #rrggbbaa) and rgb()/rgba() colors; null for anything else. */
export function parseColor(v: string): Rgb | null {
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([0-9.]+%?)[\s,]+([0-9.]+%?)[\s,]+([0-9.]+%?)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const ch = (x: string) => Math.min(255, x.endsWith("%") ? (parseFloat(x) / 100) * 255 : parseFloat(x));
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const out = { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a: Math.min(1, a) };
    return [out.r, out.g, out.b, out.a].every(Number.isFinite) ? out : null;
  }
  return null;
}

const lum = ({ r, g, b }: Rgb) => {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/** WCAG contrast ratio of two opaque colors. */
export const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** sRGB mix, the same math as CSS `color-mix(in srgb, a p%, b)`. */
const mix = (a: Rgb, b: Rgb, p: number): Rgb => ({ r: a.r * p + b.r * (1 - p), g: a.g * p + b.g * (1 - p), b: a.b * p + b.b * (1 - p), a: 1 });

/** The default tokens of globals.css (light / dark). */
export const DEFAULT_TOKENS = {
  light: { canvas: "#fafafa", card: "#ffffff", ink: "#0a0a0a", inkMute: "#737373", accent: "#3b6cf6", bubbleMine: "#dbe6fd", bubbleOther: "#ececec" },
  dark: { canvas: "#000000", card: "#0a0a0a", ink: "#ededed", inkMute: "#737373", accent: "#5b8cff", bubbleMine: "#1e3a8a", bubbleOther: "#262626" },
} as const;

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_MUTED_CONTRAST = 3;
export const MIN_ACCENT_CONTRAST = 3;
/** Share of ink in the derived soft / muted text colors (over the card color). */
const SOFT = 0.75;
const MUTE = 0.55;

/** Mode colors that become workspace tokens (must be opaque hex or rgb() so contrast can be checked). */
export const TOKEN_KEYS = ["accent", "canvas", "card", "ink", "line", "bubbleMine", "bubbleOther"] as const;

export type ContrastIssue = { pointer: string; message: string; expected: string };

/**
 * Readability rules for a workspace-scoped theme, per color scheme: body text on cards, the page
 * background and chat bubbles (4.5:1), secondary text (3:1) and the accent (links, focus; 3:1).
 */
export function contrastIssues(theme: Pick<UiTheme, "accent" | "light" | "dark">): ContrastIssue[] {
  const out: ContrastIssue[] = [];
  for (const mode of ["light", "dark"] as const) {
    const o: ModeOverride = theme[mode];
    const d = DEFAULT_TOKENS[mode];
    const pick = (k: (typeof TOKEN_KEYS)[number], fallback: string, ptr: string) => {
      const raw = (o[k] as string | undefined) ?? (k === "accent" ? theme.accent : undefined);
      const where = o[k] != null ? `/${mode}/${k}` : k === "accent" && theme.accent ? "/accent" : null;
      if (raw == null) return { c: parseColor(fallback)!, where: null as string | null, raw: fallback };
      const c = parseColor(raw);
      if (!c) {
        out.push({ pointer: where ?? ptr, message: `${JSON.stringify(raw)} can't be checked for contrast in a workspace theme`, expected: 'a hex color ("#1f2937") or rgb(…)' });
        return null;
      }
      if (c.a < 1 && k !== "accent" && k !== "line") {
        out.push({ pointer: where ?? ptr, message: `must be opaque in a workspace theme (got ${JSON.stringify(raw)})`, expected: 'a color without alpha, e.g. "#1f2937"' });
        return null;
      }
      return { c, where, raw };
    };
    const card = pick("card", d.card, `/${mode}/card`);
    const canvas = pick("canvas", d.canvas, `/${mode}/canvas`);
    const ink = pick("ink", d.ink, `/${mode}/ink`);
    const accent = pick("accent", d.accent, `/${mode}/accent`);
    const mine = pick("bubbleMine", d.bubbleMine, `/${mode}/bubbleMine`);
    const other = pick("bubbleOther", d.bubbleOther, `/${mode}/bubbleOther`);
    pick("line", "#888888", `/${mode}/line`);
    if (!card || !canvas || !ink) continue;
    const derived = o.ink != null || o.card != null;
    const mute = derived ? mix(ink.c, card.c, MUTE) : parseColor(d.inkMute)!;
    const blame = (...cands: ({ where: string | null } | null)[]) => cands.find((x) => x?.where)?.where ?? `/${mode}`;
    const need = (a: Rgb, b: Rgb, min: number, what: string, ptr: string, fix: string) => {
      const r = contrast(a, b);
      if (r < min) out.push({ pointer: ptr, message: `${mode} mode: ${what} contrast is ${r.toFixed(2)}:1, below ${min}:1 (unreadable)`, expected: fix });
    };
    need(ink.c, card.c, MIN_TEXT_CONTRAST, `text (ink ${ink.raw}) on cards (${card.raw})`, blame(ink, card), "a darker ink on light cards, or a lighter ink on dark cards");
    need(ink.c, canvas.c, MIN_TEXT_CONTRAST, `text (ink ${ink.raw}) on the page background (${canvas.raw})`, blame(canvas, ink), "a canvas closer to the card color");
    need(mute, card.c, MIN_MUTED_CONTRAST, `secondary text on cards (${card.raw})`, blame(card, ink), "more contrast between ink and card");
    if (accent) need(accent.c, card.c, MIN_ACCENT_CONTRAST, `the accent (${accent.raw}) on cards`, blame(accent, card), "a stronger accent for this color scheme (set light.accent / dark.accent)");
    if (mine) need(ink.c, mine.c, MIN_TEXT_CONTRAST, `text on your chat bubbles (${mine.raw})`, blame(mine, ink), "a bubble color closer to the card color");
    if (other) need(ink.c, other.c, MIN_TEXT_CONTRAST, `text on other people's chat bubbles (${other.raw})`, blame(other, ink), "a bubble color closer to the card color");
  }
  return out;
}

const FONT_STACKS: Record<UiTheme["font"], string | null> = {
  system: null,
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
  mono: "var(--font-mono)",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
};

const SAFE = /^[#a-zA-Z0-9(),.%\s/-]{1,100}$/;
const ok = (v: string | undefined): v is string => typeof v === "string" && SAFE.test(v) && !/url|image|expression|attr/i.test(v);

/**
 * CSS that applies a workspace-scoped theme and the shell density to the whole app. Selectors are
 * more specific than globals.css so they win in both color schemes; `.zw-safe` (the settings menu
 * and its "Restore default UI") re-declares the defaults on itself, so it never inherits this.
 */
export function workspaceCss(theme: UiTheme | null, density: "compact" | "comfortable"): string {
  const base: string[] = [];
  if (density === "compact") base.push("--spacing:0.22rem");
  if (theme && theme.scope === "workspace") {
    if (ok(theme.accent)) base.push(`--color-accent:${theme.accent}`);
    if (theme.radius != null && Number.isFinite(theme.radius)) {
      const f = Math.max(0, Math.min(28, theme.radius)) / 12;
      const px = (n: number) => `${Math.round(n * f * 10) / 10}px`;
      base.push(`--radius-sheet:${px(12)}`, `--radius-md:${px(6)}`, `--radius-lg:${px(8)}`, `--radius-xl:${px(12)}`, `--radius-2xl:${px(16)}`);
    }
    const font = FONT_STACKS[theme.font];
    if (font) base.push(`--font-sans:${font}`);
  }
  const mode = (o: ModeOverride | undefined): string => {
    if (!o || theme?.scope !== "workspace") return "";
    const d: string[] = [];
    if (ok(o.accent)) d.push(`--color-accent:${o.accent}`);
    if (ok(o.canvas)) d.push(`--color-canvas:${o.canvas}`);
    if (ok(o.card)) d.push(`--color-sheet:${o.card}`);
    if (ok(o.ink)) d.push(`--color-ink:${o.ink}`, `--color-primary:${o.ink}`, `--color-primary-soft-ink:${o.ink}`);
    if (ok(o.ink) || ok(o.card)) {
      const ink = ok(o.ink) ? o.ink : "var(--color-ink)";
      const card = ok(o.card) ? o.card : "var(--color-sheet)";
      d.push(
        `--color-ink-soft:color-mix(in srgb, ${ink} ${Math.round(SOFT * 100)}%, ${card})`,
        `--color-ink-mute:color-mix(in srgb, ${ink} ${Math.round(MUTE * 100)}%, ${card})`,
        `--color-sheet-muted:color-mix(in srgb, ${ink} 4%, ${card})`,
        `--color-hover:color-mix(in srgb, ${ink} 6%, ${card})`,
        `--color-primary-ink:${card}`,
        `--color-primary-hover:color-mix(in srgb, ${ink} 85%, ${card})`,
      );
    }
    if (ok(o.line)) d.push(`--color-line:${o.line}`, `--color-line-strong:color-mix(in srgb, ${o.line} 70%, var(--color-ink))`);
    if (ok(o.bubbleMine)) d.push(`--color-bubble-mine:${o.bubbleMine}`);
    if (ok(o.bubbleOther)) d.push(`--color-bubble-other:${o.bubbleOther}`);
    if (ok(o.bubbleMine) || ok(o.bubbleOther)) d.push("--color-bubble-link:var(--color-ink)");
    return d.join(";");
  };
  const light = mode(theme?.light);
  const dark = mode(theme?.dark);
  let css = "";
  if (base.length) css += `html:root{${base.join(";")}}`;
  if (light) css += `html:root:not([data-theme="dark"]){${light}}`;
  if (dark) css += `html:root[data-theme="dark"]{${dark}}`;
  // Values are already restricted to SAFE; "<" can never close the <style> element.
  return css.replace(/</g, "");
}

/** Safe mode (per browser): the workspace renders without the user's theme and shell customization. */
export const SAFE_COOKIE = "zw_ui_safe";
/** Fixed page with "Restore default UI" and safe mode, outside the customizable (apps) layout. */
export const SAFE_PATH = "/ui-safe";

export const BUILTIN_HREF: Record<string, string> = {
  mail: "/mail",
  dashboard: "/dashboard",
  chat: "/chat",
  calendar: "/calendar",
  drive: "/drive",
  meet: "/meet",
  contacts: "/contacts",
};

/** Where a rail / home reference ("mail", "app:crm") points. */
export const appHref = (ref: string | null | undefined): string =>
  !ref ? "/mail" : ref.startsWith("app:") ? `/x/${ref.slice(4)}` : (BUILTIN_HREF[ref] ?? "/mail");
