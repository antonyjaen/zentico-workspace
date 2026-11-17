// Starter content for `Zentico UI/`: the default ui.json / theme.json / keys.json (Home similar to
// the classic dashboard plus a page with the example mods), the migration of a classic sqlite
// dashboard into files, and the built-in library of recommended layouts ("templates"). Client-safe.
import type { DashboardDoc } from "@/app/(apps)/dashboard/model";
import { BUILTIN_MODS } from "./mods";
import { LIBRARY_INFO, LIBRARY_MODS } from "./mods-library";
import { checkUi, KEYS_FILE, THEME_FILE, UI_FILE, type IconName } from "./schema";

type Raw = Record<string, unknown>;
type L = "es" | "en";
const loc = (locale: string): L => (locale === "en" ? "en" : "es");
export const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const c = (component: string, props: Raw = {}, extra: Raw = {}): Raw => ({ type: "component", component, ...(Object.keys(props).length ? { props } : {}), ...extra });
const m = (mod: string, extra: Raw = {}): Raw => ({ type: "mod", mod, ...extra });
const row = (children: Raw[], sizes?: number[], extra: Raw = {}): Raw => ({ type: "row", ...extra, ...(sizes ? { sizes } : {}), children });
const col = (children: Raw[], sizes?: number[], extra: Raw = {}): Raw => ({ type: "column", ...extra, ...(sizes ? { sizes } : {}), children });
const at = (node: Raw, x: number, y: number, w: number, h: number): Raw => ({ ...node, x, y, w, h });

const HINT: Record<L, string> = {
  en: "### Make it yours\n\nThis dashboard is made of files in your Drive (**Zentico UI**). Ask your assistant: *“add a page with my team's channel and this week's calendar”*, *“build a mod that tracks my habits”*.\n\nOr use **Edit** to resize and rearrange, and **Gallery** for ready-made layouts.",
  es: "### Hazlo tuyo\n\nEste dashboard está hecho de archivos en tu Drive (**Zentico UI**). Pídele a tu asistente: *«añade una página con el canal de mi equipo y el calendario de esta semana»*, *«crea un mod que siga mis hábitos»*.\n\nO usa **Editar** para redimensionar y reordenar, y la **Galería** para diseños listos.",
};

/** Home: the classic dashboard as a grid region. */
function homePage(l: L): Raw {
  return {
    id: "home",
    title: l === "en" ? "Home" : "Inicio",
    icon: "house",
    layout: {
      type: "grid",
      children: [
        at(c("agenda", {}, { id: "agenda" }), 0, 0, 4, 8),
        at(c("mail", { mode: "unread" }, { id: "mail" }), 4, 0, 4, 8),
        at(c("chat", { mode: "unread" }, { id: "chat" }), 8, 0, 4, 8),
        at(c("drive", { mode: "recent", limit: 8 }, { id: "files" }), 0, 8, 8, 6),
        at(c("notes", { text: HINT[l] }, { id: "notes" }), 8, 8, 4, 6),
      ],
    },
  };
}

export function defaultFiles(locale: string): Record<string, string> {
  const l = loc(locale);
  const ui = {
    version: 1,
    pages: [
      homePage(l),
      {
        id: "focus",
        title: l === "en" ? "Focus" : "Foco",
        icon: "target",
        layout: row([m("pomodoro", { title: "Pomodoro" }), m("inbox-triage", { title: l === "en" ? "Inbox triage" : "Triaje del correo" })], [2, 3]),
      },
    ],
  };
  return {
    [UI_FILE]: pretty(ui),
    [THEME_FILE]: pretty({ density: "comfortable", background: "plain", font: "system", radius: 12 }),
    [KEYS_FILE]: pretty(defaultKeys()),
    ...modFiles(["pomodoro", "inbox-triage"]),
  };
}

const defaultKeys = () => ({
  bindings: [
    { key: "alt+1", action: "goto", page: "home", description: "Home" },
    { key: "alt+2", action: "goto", page: "focus", description: "Focus" },
    { key: "alt+k", action: "claude", description: "Ask your assistant" },
    { key: "alt+e", action: "edit", description: "Edit layout" },
    { key: "alt+p", action: "mod", mod: "pomodoro", command: "toggle", description: "Start / pause the Pomodoro" },
  ],
});

/** Files of built-in mods, keyed by their path under `Zentico UI/`. */
export function modFiles(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) for (const [name, text] of Object.entries(BUILTIN_MODS[id] ?? LIBRARY_MODS[id] ?? {})) out[`mods/${id}/${name}`] = text;
  return out;
}

/** Files for a user who had a classic (sqlite) dashboard: its widgets become the Home grid. */
export function migratedFiles(doc: DashboardDoc, locale: string): Record<string, string> {
  const base = defaultFiles(locale);
  const ui = JSON.parse(base[UI_FILE]) as { pages: Raw[] };
  ui.pages[0] = {
    ...(ui.pages[0] as Raw),
    layout: {
      type: "grid",
      children: doc.widgets.length
        ? doc.widgets.map((w) => at(c(w.type, w.config, { id: w.id, ...(w.title ? { title: w.title } : {}) }), w.x, w.y, w.w, w.h))
        : [at(c("notes", { text: HINT[loc(locale)] }, { id: "notes" }), 0, 0, 4, 6)],
    },
  };
  const theme: Raw = { density: doc.theme.density ?? "comfortable", background: doc.theme.background ?? "plain", font: "system", radius: 12 };
  if (doc.theme.accent) theme.accent = doc.theme.accent;
  return { ...base, [UI_FILE]: pretty(ui), [THEME_FILE]: pretty(theme) };
}

/* -------------------------------------------------------------- templates */

export type TemplateKind = "layout" | "app" | "mod";
export type Template = {
  id: string;
  kind?: "layout" | "app";
  icon: IconName;
  name: Record<L, string>;
  description: Record<L, string>;
  mods: string[];
  page: (l: L) => Raw;
};

export const TEMPLATES: Template[] = [
  {
    id: "inbox-zero",
    icon: "inbox",
    name: { en: "Inbox Zero", es: "Inbox Zero" },
    description: {
      en: "Mail triage: unread list, a thread reader next to it and one-click actions (read, star, archive, quick replies, assistant drafts).",
      es: "Triaje del correo: lista de no leídos, lector de hilos al lado y acciones en un clic (leído, destacar, archivar, respuestas rápidas, borradores del asistente).",
    },
    mods: ["mail-actions"],
    page: (l) => ({
      title: "Inbox Zero",
      icon: "inbox",
      layout: row(
        [
          c("mail", { mode: "unread", limit: 40, openIn: "reader" }, { title: l === "en" ? "Unread" : "Sin leer" }),
          c("mail.thread", {}, { title: l === "en" ? "Conversation" : "Conversación" }),
          m("mail-actions", { title: l === "en" ? "Actions" : "Acciones" }),
        ],
        [3, 5, 2.4],
      ),
    }),
  },
  {
    id: "meeting-day",
    icon: "calendar-days",
    name: { en: "Meeting day", es: "Día de reuniones" },
    description: {
      en: "Your next meeting front and centre, today's agenda, a notes pad and recent recordings.",
      es: "Tu próxima reunión bien visible, la agenda de hoy, un bloc de notas y las grabaciones recientes.",
    },
    mods: [],
    page: (l) => ({
      title: l === "en" ? "Meeting day" : "Día de reuniones",
      icon: "calendar-days",
      layout: row(
        [
          col([c("meetings.next", {}, { title: l === "en" ? "Next up" : "Lo siguiente" }), c("agenda", { days: 1, limit: 20 }, { title: l === "en" ? "Today" : "Hoy" })], [1, 2.2]),
          col(
            [
              c("notes", { text: l === "en" ? "### Meeting notes\n\n- " : "### Notas de la reunión\n\n- " }, { title: l === "en" ? "Notes" : "Notas" }),
              c("meetings", { upcoming: false, recordings: true, limit: 6 }, { title: l === "en" ? "Recordings" : "Grabaciones" }),
            ],
            [2, 1],
          ),
        ],
        [2, 3],
      ),
    }),
  },
  {
    id: "command-center",
    icon: "gauge",
    name: { en: "Command center", es: "Centro de mando" },
    description: {
      en: "Everything at a glance: unread mail and chat, agenda, recent files, and your assistant on the side.",
      es: "Todo de un vistazo: correo y chat sin leer, agenda, archivos recientes y tu asistente al lado.",
    },
    mods: [],
    page: (l) => ({
      title: l === "en" ? "Command center" : "Centro de mando",
      icon: "gauge",
      layout: row(
        [
          {
            type: "grid",
            children: [
              at(c("mail", { mode: "unread", limit: 10 }), 0, 0, 4, 8),
              at(c("chat", { mode: "unread" }), 4, 0, 4, 8),
              at(c("agenda", { days: 3 }), 8, 0, 4, 8),
              at(c("drive", { mode: "recent", limit: 10 }), 0, 8, 12, 6),
            ],
          },
          c("claude", {}, { title: "Assistant" }),
        ],
        [3, 1.2],
      ),
    }),
  },
  {
    id: "focus",
    icon: "focus",
    name: { en: "Focus", es: "Foco" },
    description: {
      en: "A calm page: Pomodoro with tasks, one Markdown doc from your Drive and your assistant. Spacious and plain.",
      es: "Una página tranquila: Pomodoro con tareas, un documento Markdown de tu Drive y tu asistente. Amplia y sobria.",
    },
    mods: ["pomodoro"],
    page: (l) => ({
      title: l === "en" ? "Focus" : "Foco",
      icon: "focus",
      theme: { density: "spacious", background: "plain" },
      layout: row([m("pomodoro", { title: "Pomodoro" }), c("doc.markdown", {}, { title: l === "en" ? "Document" : "Documento" }), c("claude", {}, { title: "Assistant" })], [2, 3, 2]),
    }),
  },
  {
    id: "team-hub",
    icon: "users",
    name: { en: "Team hub", es: "Equipo" },
    description: {
      en: "Your team's channel with a composer, the week's calendar and a shared Drive folder (pick them on first use).",
      es: "El canal de tu equipo con caja de mensajes, el calendario de la semana y una carpeta compartida de Drive (se eligen al usarla).",
    },
    mods: [],
    page: (l) => ({
      title: l === "en" ? "Team" : "Equipo",
      icon: "users",
      layout: row(
        [
          c("chat.conversation", { composer: true }, { title: l === "en" ? "Channel" : "Canal" }),
          col([c("calendar.week", { days: 5, start: "week" }, { title: l === "en" ? "This week" : "Esta semana" }), c("drive.folder", {}, { title: l === "en" ? "Shared files" : "Archivos compartidos" })], [3, 2]),
        ],
        [2, 3],
      ),
    }),
  },
  {
    id: "project-board",
    icon: "kanban",
    name: { en: "Project board", es: "Tablero de proyecto" },
    description: {
      en: "A kanban board saved in the mod's storage, the project's Markdown doc and its chat conversation.",
      es: "Un kanban guardado en el almacenamiento del mod, el documento Markdown del proyecto y su conversación de chat.",
    },
    mods: ["kanban-links"],
    page: (l) => ({
      title: l === "en" ? "Project" : "Proyecto",
      icon: "kanban",
      layout: row(
        [m("kanban-links", { title: l === "en" ? "Board" : "Tablero" }), col([c("doc.markdown", {}, { title: l === "en" ? "Brief" : "Documento" }), c("chat.conversation", { limit: 20 }, { title: "Chat" })], [1, 1])],
        [3, 2],
      ),
    }),
  },
  {
    id: "manager-weekly",
    icon: "briefcase",
    name: { en: "Manager weekly", es: "Semana del manager" },
    description: {
      en: "The week ahead: calendar grid, this week's meetings, your 1:1 notes from Drive and mail that needs a follow-up.",
      es: "La semana por delante: calendario, reuniones de la semana, tus notas de 1:1 de Drive y correos pendientes de seguimiento.",
    },
    mods: [],
    page: (l) => ({
      title: l === "en" ? "Weekly" : "Semana",
      icon: "briefcase",
      layout: col(
        [
          c("calendar.week", { days: 5, start: "week" }, { title: l === "en" ? "This week" : "Esta semana" }),
          row(
            [
              c("meetings", { upcoming: true, recordings: false, days: 7, limit: 10 }, { title: l === "en" ? "Meetings" : "Reuniones" }),
              c("doc.markdown", {}, { title: l === "en" ? "1:1 notes" : "Notas 1:1" }),
              c("mail", { mode: "search", query: l === "en" ? "follow up" : "seguimiento", limit: 10, openIn: "app" }, { title: l === "en" ? "Follow-ups" : "Seguimientos" }),
            ],
            [1, 1.3, 1],
          ),
        ],
        [3, 2],
      ),
    }),
  },
  {
    id: "clean-minimal",
    icon: "sun",
    name: { en: "Clean minimal", es: "Mínimo" },
    description: {
      en: "Just the essentials: the time, your agenda and a notes pad. Compact and quiet.",
      es: "Solo lo esencial: la hora, tu agenda y un bloc de notas. Compacto y tranquilo.",
    },
    mods: [],
    page: (l) => ({
      title: l === "en" ? "Minimal" : "Mínimo",
      icon: "sun",
      theme: { density: "compact", background: "plain" },
      layout: row(
        [
          col([c("clock", {}, { chrome: "plain" }), c("agenda", { days: 2 }, { title: l === "en" ? "Agenda" : "Agenda" })], [1, 3]),
          c("notes", { text: l === "en" ? "### Notes\n\n" : "### Notas\n\n" }, { title: l === "en" ? "Notes" : "Notas" }),
        ],
        [1, 1.4],
      ),
    }),
  },
];

/* ------------------------------------------------------------------- apps */

const PIPELINE: Record<L, string[]> = { en: ["Lead", "Qualified", "Proposal", "Won"], es: ["Lead", "Cualificado", "Propuesta", "Ganado"] };

/** Recommended apps: pages already converted into their own rail apps (/x/<id>) with sub-pages. */
export const APP_TEMPLATES: Template[] = [
  {
    id: "crm",
    kind: "app",
    icon: "handshake",
    name: { en: "CRM lite", es: "CRM ligero" },
    description: {
      en: "Its own app in the rail: search people, see their recent mail threads, keep notes and a stage per contact, plus a deal pipeline board.",
      es: "Su propia app en la barra: busca personas, mira sus hilos de correo recientes, guarda notas y etapa por contacto, y un tablero de oportunidades.",
    },
    mods: ["crm", "kanban-links"],
    page: (l) => ({
      title: l === "en" ? "Contacts" : "Contactos",
      icon: "users",
      app: {
        name: "CRM",
        icon: "handshake",
        color: "#0f9f8f",
        sections: [
          { id: "pipeline", title: l === "en" ? "Pipeline" : "Oportunidades", icon: "kanban", layout: m("kanban-links", { title: l === "en" ? "Deals" : "Oportunidades", config: { columns: PIPELINE[l] } }) },
        ],
      },
      layout: row([m("crm", { title: l === "en" ? "People" : "Personas" }), c("mail.thread", {}, { title: l === "en" ? "Conversation" : "Conversación" })], [3, 2]),
    }),
  },
  {
    id: "helpdesk",
    kind: "app",
    icon: "headphones",
    name: { en: "Helpdesk", es: "Soporte" },
    description: {
      en: "A shared-inbox app: tickets from a mail query on an assignment board (New, Assigned, Waiting, Done) with the conversation next to it.",
      es: "Una app de bandeja compartida: tickets de una búsqueda de correo en un tablero de asignación (Nuevo, Asignado, En espera, Hecho) con la conversación al lado.",
    },
    mods: ["helpdesk"],
    page: (l) => ({
      title: l === "en" ? "Tickets" : "Tickets",
      icon: "clipboard-list",
      app: {
        name: l === "en" ? "Helpdesk" : "Soporte",
        icon: "headphones",
        color: "#e8590c",
        sections: [
          {
            id: "inbox",
            title: l === "en" ? "Shared inbox" : "Bandeja compartida",
            icon: "inbox",
            layout: row([c("mail", { mode: "search", query: "to:support", limit: 40, openIn: "reader" }, { title: l === "en" ? "Messages" : "Mensajes" }), c("mail.thread", {}, { title: l === "en" ? "Conversation" : "Conversación" })], [2, 3]),
          },
        ],
      },
      layout: row([m("helpdesk", { title: l === "en" ? "Board" : "Tablero", config: { query: "to:support" } }), c("mail.thread", {}, { title: l === "en" ? "Conversation" : "Conversación" })], [3, 2]),
    }),
  },
  {
    id: "projects",
    kind: "app",
    icon: "rocket",
    name: { en: "Projects", es: "Proyectos" },
    description: {
      en: "A project app with a board linked to mail, chat and files, the brief and the team chat, plus Files and Calendar sub-pages.",
      es: "Una app de proyecto con un tablero enlazado a correo, chat y archivos, el documento y el chat del equipo, más subpáginas de Archivos y Calendario.",
    },
    mods: ["kanban-links"],
    page: (l) => ({
      title: l === "en" ? "Board" : "Tablero",
      icon: "kanban",
      app: {
        name: l === "en" ? "Projects" : "Proyectos",
        icon: "rocket",
        color: "#7048e8",
        sections: [
          { id: "files", title: l === "en" ? "Files" : "Archivos", icon: "folder", layout: c("drive.folder", {}, { title: l === "en" ? "Project folder" : "Carpeta del proyecto" }) },
          { id: "calendar", title: l === "en" ? "Calendar" : "Calendario", icon: "calendar-days", layout: c("calendar.week", { days: 5, start: "week" }, { title: l === "en" ? "This week" : "Esta semana" }) },
        ],
      },
      layout: row(
        [
          m("kanban-links", { title: l === "en" ? "Board" : "Tablero" }),
          col([c("doc.markdown", {}, { title: l === "en" ? "Brief" : "Documento" }), c("chat.conversation", { limit: 25 }, { title: "Chat" })], [1, 1]),
        ],
        [3, 2],
      ),
    }),
  },
];

/** Recommended mods (install only; place them yourself or let the assistant do it). */
export const RECOMMENDED_MODS: { id: string; icon: IconName; name: Record<L, string>; description: Record<L, string> }[] = [
  {
    id: "pomodoro",
    icon: "timer",
    name: { en: "Pomodoro + tasks", es: "Pomodoro + tareas" },
    description: { en: "A focus timer with a small task list, saved in the mod's storage.", es: "Un temporizador de foco con una pequeña lista de tareas, guardada en el almacenamiento del mod." },
  },
  {
    id: "inbox-triage",
    icon: "kanban",
    name: { en: "Inbox triage", es: "Triaje del correo" },
    description: { en: "Unread mail as cards: read, star, archive or park for later.", es: "El correo sin leer como tarjetas: leído, destacar, archivar o dejar para luego." },
  },
  {
    id: "mail-actions",
    icon: "zap",
    name: { en: "Mail quick actions", es: "Acciones rápidas de correo" },
    description: { en: "One-click actions and reply drafts for the conversation selected on the page.", es: "Acciones en un clic y borradores de respuesta para la conversación seleccionada en la página." },
  },
  ...Object.entries(LIBRARY_INFO).map(([id, info]) => ({ id, icon: info.icon as IconName, name: info.name, description: info.description })),
];

/** Workspace theme presets (whole app, light + dark, contrast-checked): copy one into theme.json. */
export const THEME_PRESETS: { id: string; name: Record<L, string>; description: Record<L, string>; theme: Raw }[] = [
  {
    id: "calm",
    name: { en: "Calm teal", es: "Turquesa sereno" },
    description: { en: "Soft teal accent, rounder corners, tinted chat bubbles.", es: "Acento turquesa suave, esquinas más redondas y burbujas teñidas." },
    theme: {
      scope: "workspace",
      accent: "#0f7f74",
      radius: 16,
      density: "comfortable",
      font: "system",
      background: "plain",
      light: { canvas: "#f3f7f6", card: "#ffffff", bubbleMine: "#d5eeea" },
      dark: { accent: "#3cc4b3", canvas: "#040807", card: "#0a1110", bubbleMine: "#0f3d37" },
    },
  },
  {
    id: "compact",
    name: { en: "Compact pro", es: "Compacto pro" },
    description: { en: "Denser spacing everywhere and tighter corners: more on screen.", es: "Espaciado más denso en todas partes y esquinas ajustadas: más en pantalla." },
    theme: { scope: "workspace", accent: "#3b6cf6", radius: 6, density: "compact", font: "sans", background: "plain" },
  },
  {
    id: "paper",
    name: { en: "Warm paper", es: "Papel cálido" },
    description: { en: "Warm paper tones with a serif font and a terracotta accent.", es: "Tonos de papel cálido con fuente serif y acento terracota." },
    theme: {
      scope: "workspace",
      accent: "#a8481f",
      radius: 10,
      density: "comfortable",
      font: "serif",
      background: "plain",
      light: { canvas: "#f6f1e7", card: "#fffdf8", ink: "#2b2118", line: "#e6dccb", bubbleMine: "#f3dcc8", bubbleOther: "#efe7da" },
      dark: { accent: "#e08a5c", canvas: "#14110d", card: "#1c1813", ink: "#efe6d8", line: "#2e271f", bubbleMine: "#4a2c1b", bubbleOther: "#2a241d" },
    },
  },
];

export type CatalogEntry = { id: string; kind: TemplateKind; icon: IconName; name: string; description: string; mods: string[] };

/** Everything in the recommended library, localized (gallery and ui_list_templates). */
export function catalog(locale: string): CatalogEntry[] {
  const l = loc(locale);
  return [
    ...TEMPLATES.map((t) => ({ id: t.id, kind: "layout" as const, icon: t.icon, name: t.name[l], description: t.description[l], mods: t.mods })),
    ...APP_TEMPLATES.map((t) => ({ id: t.id, kind: "app" as const, icon: t.icon, name: t.name[l], description: t.description[l], mods: t.mods })),
    ...RECOMMENDED_MODS.map((m) => ({ id: `mod:${m.id}`, kind: "mod" as const, icon: m.icon, name: m.name[l], description: m.description[l], mods: [m.id] })),
  ];
}

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? APP_TEMPLATES.find((t) => t.id === id);

/**
 * Asserts every template (in both languages) and the default files compile without errors when
 * added to the default UI. Called once per process by the server (and in dev on module load), so a
 * broken built-in fails loudly instead of shipping silently.
 */
export function assertBuiltinsValid(): void {
  for (const l of ["es", "en"] as const) {
    const base = defaultFiles(l);
    const r = checkUi(base);
    if (!r.ok) throw new Error(`[ui] default files are invalid (${l}):\n${r.errors.map((e) => `${e.file} ${e.pointer}: ${e.message}`).join("\n")}`);
    const ui = JSON.parse(base[UI_FILE]) as { pages: Raw[] };
    const placed = RECOMMENDED_MODS.map((x) => ({ type: "mod", mod: x.id, title: x.id }));
    const modsPage = { id: "t-mods", title: "Mods", layout: { type: "tabs", children: placed } };
    const all = { ...base, ...modFiles(RECOMMENDED_MODS.map((x) => x.id)), [UI_FILE]: pretty({ ...ui, pages: [...ui.pages, modsPage] }) };
    const rm = checkUi(all);
    if (!rm.ok) throw new Error(`[ui] recommended mods are invalid:\n${rm.errors.map((e) => `${e.file} ${e.pointer}: ${e.message}`).join("\n")}`);
    for (const p of THEME_PRESETS) {
      const rp = checkUi({ ...base, [THEME_FILE]: pretty(p.theme) });
      if (!rp.ok) throw new Error(`[ui] theme preset "${p.id}" is invalid:\n${rp.errors.map((e) => `${e.file} ${e.pointer}: ${e.message}`).join("\n")}`);
    }
    for (const t of [...TEMPLATES, ...APP_TEMPLATES]) {
      const files = { ...base, ...modFiles(t.mods), [UI_FILE]: pretty({ ...ui, pages: [...ui.pages, { id: `t-${t.id}`, ...t.page(l) }] }) };
      const rt = checkUi(files);
      if (!rt.ok) throw new Error(`[ui] template "${t.id}" is invalid (${l}):\n${rt.errors.map((e) => `${e.file} ${e.pointer}: ${e.message}`).join("\n")}`);
    }
  }
}
