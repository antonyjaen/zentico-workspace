// Shared by server pages and client components (no "use client": server code may call it).

/** "Monday, 23 November 2026 · 09:00 – 09:30 (Europe/Madrid)" in the visitor's language and zone. */
export function formatRange(start: number, end: number, tz: string, locale: string): string {
  const tag = locale === "en" ? "en-US" : "es-ES";
  const day = new Intl.DateTimeFormat(tag, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat(tag, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time.format(start)} – ${time.format(end)} (${tz.replace(/_/g, " ")})`;
}
