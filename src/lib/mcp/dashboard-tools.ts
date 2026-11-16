// MCP tools for the user's own Dashboard (/dashboard): read it, add / change / remove / move
// widgets, set the theme, undo. Edits only change the user's own UI (and are undoable), so they are
// `selfService`: never held for the in-call / in-dashboard confirmation. Every edit is validated
// strictly (src/app/(apps)/dashboard/model.ts) and published live to the user's open dashboards.
import {
  CUSTOM_HTML_MAX_BYTES,
  DashError,
  DATA_QUERIES,
  GRID_COLS,
  MAX_H,
  MAX_WIDGETS,
  parseOp,
  summarizeDoc,
  WIDGET_TYPES,
  WIDGETS,
  type DashboardDoc,
  type DashOp,
  type Widget,
} from "@/app/(apps)/dashboard/model";
import { editDashboard, getDashboard, undoDashboard, undoCount } from "../dashboard/store";
import { bool, ToolError, type Args } from "./args";
import { appUrl, B, I, S, type JsonSchema, type Tool } from "./kit";

const ID_PROP = S('Widget id, e.g. "w_3fa2c1d4e5b6" (from dashboard_get).');
const CONFIG_PROP: JsonSchema = { type: "object", description: "Widget config; see dashboard_list_widget_types for each type's schema." };

function edit(email: string, ops: unknown[]): { doc: DashboardDoc; added: string[] } {
  try {
    return editDashboard(email, ops.map(parseOp) as DashOp[]);
  } catch (e) {
    if (e instanceof DashError) throw new ToolError(e.message);
    throw e;
  }
}

const brief = (w: Widget) => ({ id: w.id, type: w.type, title: w.title || undefined, x: w.x, y: w.y, w: w.w, h: w.h });

export const DASHBOARD_TOOLS: Tool[] = [
  {
    name: "dashboard_list_widget_types",
    description:
      "Lists the widget types of the user's Zentico dashboard with their config schemas and size limits, the grid rules, and the read-only data queries a custom widget can run. Call it before adding or reconfiguring widgets.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        grid: {
          columns: GRID_COLS,
          rowHeightPx: "about 44 (36 when density is compact)",
          maxWidgets: MAX_WIDGETS,
          maxHeightRows: MAX_H,
          rules:
            "x is the column (0-11), y the row (0 = top), w the width in columns, h the height in rows. Overlapping widgets are pushed down and everything floats up, so you never need to fix gaps. On phones widgets stack in (y, x) order.",
        },
        types: WIDGET_TYPES.map((t) => ({
          type: t,
          description: WIDGETS[t].description,
          size: { minW: WIDGETS[t].minW, minH: WIDGETS[t].minH, defaultW: WIDGETS[t].defW, defaultH: WIDGETS[t].defH },
          config: WIDGETS[t].schema,
        })),
        customWidget: {
          maxBytes: CUSTOM_HTML_MAX_BYTES,
          sandbox:
            "Rendered in an iframe with sandbox=allow-scripts (opaque origin) and CSP default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:. No fetch, no external scripts/fonts/images, no cookies or storage, no popups or forms. Navigating the frame (e.g. clicking a plain link) stops the widget: show information, don't link out.",
          api: "await zentico.query(name, args) → the data object, or throws Error(message). zentico.theme → { dark: boolean }. The document gets the theme CSS variables and a transparent background; keep it compact and readable in light and dark mode.",
          dataQueries: DATA_QUERIES,
        },
        theme: { accent: 'Hex color like "#3b6cf6" (or null for the default)', density: ["comfortable", "compact"], background: ["plain", "muted", "grid"] },
      };
    },
  },
  {
    name: "dashboard_get",
    description: "Returns the user's dashboard: theme and widgets (id, type, title, position, size, config). Custom widget HTML is summarized unless includeHtml=true.",
    inputSchema: { type: "object", properties: { includeHtml: B("Include the full HTML of custom widgets.", false) } },
    async run(args, ctx) {
      const doc = getDashboard(ctx.session.email);
      const out = bool(args, "includeHtml") ? doc : summarizeDoc(doc);
      return { ...out, url: `${appUrl()}/dashboard`, undoSteps: undoCount(ctx.session.email) };
    },
  },
  {
    name: "dashboard_add_widget",
    description:
      "Adds a widget to the user's dashboard. Omit x/y to place it in the first free spot; omit w/h for the type's default size. Applies instantly (live) and can be undone with dashboard_undo.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        type: S("Widget type.", { enum: [...WIDGET_TYPES] }),
        title: S("Title shown on the widget (default: the type's name).", { maxLength: 80 }),
        x: I("Column (0-11).", 0, GRID_COLS - 1),
        y: I("Row (0 = top).", 0, 399),
        w: I("Width in columns.", 1, GRID_COLS),
        h: I("Height in rows.", 1, MAX_H),
        config: CONFIG_PROP,
      },
      required: ["type"],
    },
    async run(args, ctx) {
      const { type, title, x, y, w, h, config } = args;
      const { doc, added } = edit(ctx.session.email, [{ op: "add", widget: { type, title, x, y, w, h, config } }]);
      const widget = doc.widgets.find((wd) => wd.id === added[0])!;
      return { added: brief(widget), version: doc.version };
    },
  },
  {
    name: "dashboard_update_widget",
    description:
      "Changes a widget: title, config (merged into the current config field by field unless replaceConfig=true) and/or position and size. Applies instantly; undo with dashboard_undo.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        title: S("New title (empty string = the type's default name).", { maxLength: 80 }),
        config: CONFIG_PROP,
        replaceConfig: B("Replace the whole config instead of merging.", false),
        x: I("Column (0-11).", 0, GRID_COLS - 1),
        y: I("Row.", 0, 399),
        w: I("Width in columns.", 1, GRID_COLS),
        h: I("Height in rows.", 1, MAX_H),
      },
      required: ["id"],
    },
    async run(args, ctx) {
      const { id, title, config, replaceConfig, x, y, w, h } = args;
      const { doc } = edit(ctx.session.email, [{ op: "update", id, title, config, replaceConfig, x, y, w, h }]);
      const widget = doc.widgets.find((wd) => wd.id === id);
      return { updated: widget ? brief(widget) : null, version: doc.version };
    },
  },
  {
    name: "dashboard_remove_widget",
    description: "Removes a widget from the user's dashboard (undo with dashboard_undo).",
    write: true,
    selfService: true,
    inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
    async run(args, ctx) {
      const { doc } = edit(ctx.session.email, [{ op: "remove", id: args.id }]);
      return { removed: args.id, version: doc.version, widgets: doc.widgets.length };
    },
  },
  {
    name: "dashboard_move_widgets",
    description:
      "Moves and/or resizes several widgets at once (a new layout). Listed widgets keep the given spots; others that collide are pushed down, then everything floats up.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "New positions.",
          maxItems: MAX_WIDGETS,
          items: {
            type: "object",
            properties: { id: ID_PROP, x: I("Column.", 0, GRID_COLS - 1), y: I("Row.", 0, 399), w: I("Width.", 1, GRID_COLS), h: I("Height.", 1, MAX_H) },
            required: ["id", "x", "y"],
          },
        },
      },
      required: ["items"],
    },
    async run(args, ctx) {
      if (!Array.isArray(args.items)) throw new ToolError('"items" must be an array');
      const { doc } = edit(ctx.session.email, [{ op: "move", items: args.items }]);
      return { version: doc.version, layout: doc.widgets.map(brief) };
    },
  },
  {
    name: "dashboard_set_theme",
    description: "Sets the dashboard's look: accent color, density and background. Pass null to reset a field to the default.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        accent: { type: ["string", "null"], description: 'Hex color like "#0f9f8f", or null for the default.' },
        density: { type: ["string", "null"], enum: ["comfortable", "compact", null], description: "Spacing of the grid." },
        background: { type: ["string", "null"], enum: ["plain", "muted", "grid", null], description: "Canvas background." },
      },
    },
    async run(args: Args, ctx) {
      const theme: Record<string, unknown> = {};
      for (const k of ["accent", "density", "background"]) if (k in args) theme[k] = args[k];
      const { doc } = edit(ctx.session.email, [{ op: "theme", theme }]);
      return { theme: doc.theme, version: doc.version };
    },
  },
  {
    name: "dashboard_undo",
    description: "Undoes the last change to the user's dashboard (up to 20 steps back, whoever made the change).",
    write: true,
    selfService: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      const doc = undoDashboard(ctx.session.email);
      if (!doc) throw new ToolError("Nothing to undo");
      return { version: doc.version, undoStepsLeft: undoCount(ctx.session.email), widgets: doc.widgets.map(brief) };
    },
  },
];
