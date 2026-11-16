// Legacy MCP tools for the user's Dashboard, kept working on top of Zentico UI (the dashboard is
// now built from files in the user's Drive folder "Zentico UI/", see ui-tools.ts and AGENTS.md).
// "Widgets" are the components placed in a page's grid region (the first `grid` node of the page);
// ids are node ids. Every edit is a validated, undoable write of ui.json / theme.json, published
// live to the user's open dashboards; edits only change the user's own UI, so they are
// `selfService` (never held for the in-call / in-dashboard confirmation).
import { DATA_QUERIES } from "@/app/(apps)/dashboard/model";
import { randomBytes } from "node:crypto";
import {
  COMPONENT_NAMES,
  COMPONENTS,
  findSpot,
  formatErrors,
  getAtPointer,
  GRID_COLUMNS,
  isColor,
  normalizeBoxes,
  summarizeUi,
  THEME_FILE,
  UI_FILE,
  walk,
  type PointerOp,
  type UiNode,
  type UiPage,
} from "../ui/schema";
import { patchUi, syncUi, undoUi, UiServiceError, writeUiFiles } from "../ui/service";
import { getUiState } from "../ui/store";
import { ToolError, type Args } from "./args";
import { appUrl, B, I, S, type JsonSchema, type Tool, type ToolContext } from "./kit";

type Raw = Record<string, unknown>;

const ID_PROP = S('Widget (layout node) id, from dashboard_get, e.g. "agenda" or "w_3fa2c1d4e5b6".');
const PAGE_PROP = S("Dashboard page id (default: the first page).");
const CONFIG_PROP: JsonSchema = { type: "object", description: "Component props; see dashboard_list_widget_types / ui_list_components for each type's schema." };

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UiServiceError) throw new ToolError(e.errors.length ? `${e.message}:\n${formatErrors(e.errors)}` : e.message);
    throw e;
  }
}

/** Synced state: compiled UI, raw ui.json and the signature to edit against. */
async function load(ctx: ToolContext) {
  const view = await guard(() => syncUi(ctx.session));
  if (view.errors.length) throw new ToolError(`The UI files have errors; fix them first (ui_check):\n${formatErrors(view.errors)}`);
  const row = getUiState(ctx.session.email);
  if (!row?.compiled || !row.files) throw new ToolError("The dashboard is not available yet");
  return { ui: row.compiled, raw: JSON.parse(row.files[UI_FILE]) as Raw, sig: view.sig, files: row.files };
}

function pageOf(ui: { pages: UiPage[] }, id: unknown): UiPage {
  if (id == null || id === "") return ui.pages[0];
  const p = ui.pages.find((x) => x.id === id);
  if (!p) throw new ToolError(`No page "${String(id)}" (pages: ${ui.pages.map((x) => x.id).join(", ")})`);
  return p;
}

function gridOf(page: UiPage): Extract<UiNode, { type: "grid" }> {
  let grid: Extract<UiNode, { type: "grid" }> | null = null;
  walk(page.layout, (n) => {
    if (!grid && n.type === "grid") grid = n;
  });
  if (!grid) throw new ToolError(`Page "${page.id}" has no grid region; edit its layout in ui.json with ui_write_file / ui_edit_file (see ui_get_guide)`);
  return grid;
}

function findNode(ui: { pages: UiPage[] }, id: string): { node: UiNode; parent: UiNode | null; page: UiPage } {
  for (const page of ui.pages) {
    let hit: { node: UiNode; parent: UiNode | null } | null = null;
    walk(page.layout, (n, parent) => {
      if (!hit && n.id === id) hit = { node: n, parent };
    });
    if (hit) return { ...(hit as { node: UiNode; parent: UiNode | null }), page };
  }
  throw new ToolError(`No widget with id "${id}" (dashboard_get lists them)`);
}

const brief = (n: UiNode) => ({ id: n.id ?? n.key, type: n.type === "component" ? n.component : n.type === "mod" ? `mod:${n.mod}` : n.type, title: n.title, x: n.x, y: n.y, w: n.w, h: n.h });

/** Re-lays out a grid's raw children (pinned ids keep their spot) and returns the pointer ops. */
function relayout(grid: Extract<UiNode, { type: "grid" }>, rawChildren: Raw[], pinned: string[]): PointerOp[] {
  const boxes = rawChildren.map((c, i) => {
    const node = grid.children[i];
    const comp = typeof c.component === "string" ? COMPONENTS[c.component] : undefined;
    return { id: String(c.id ?? node?.key ?? i), x: Number(c.x ?? 0), y: Number(c.y ?? 0), w: Number(c.w ?? 4), h: Number(c.h ?? 6), minW: comp?.size.minW ?? 2, minH: comp?.size.minH ?? 2 };
  });
  const placed = normalizeBoxes(boxes, pinned);
  const children = rawChildren.map((c, i) => ({ ...c, x: placed[i].x, y: placed[i].y, w: placed[i].w, h: placed[i].h }));
  return [{ op: "set", pointer: `${grid.ptr}/children`, value: children }];
}

const newId = () => `w_${randomBytes(6).toString("hex")}`;

async function apply(ctx: ToolContext, sig: string, ops: PointerOp[]) {
  return guard(() => patchUi(ctx.session, sig, ops));
}

export const DASHBOARD_TOOLS: Tool[] = [
  {
    name: "dashboard_list_widget_types",
    description:
      "Lists the component types usable as dashboard widgets with their props schemas and sizes. The dashboard is now built from files (Zentico UI): for anything beyond simple grid widgets read ui_get_guide.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        note: "The Dashboard is defined by files in the user's Drive folder \"Zentico UI/\". These legacy tools edit the first grid region of a page; for splits, tabs, pages, rail apps, themes, shortcuts and mods use ui_get_guide + ui_write_file.",
        grid: { columns: GRID_COLUMNS, rules: "x = column (0-11), y = row, w = width in columns, h = height in rows (~44 px). Overlaps are pushed down, everything floats up." },
        types: COMPONENT_NAMES.map((name) => ({ type: name, description: COMPONENTS[name].description, size: COMPONENTS[name].size, config: COMPONENTS[name].props })),
        dataQueries: DATA_QUERIES,
        theme: { accent: 'CSS color like "#3b6cf6" (or null)', density: ["compact", "comfortable", "spacious"], background: ["plain", "muted", "grid", "dots"] },
      };
    },
  },
  {
    name: "dashboard_get",
    description: "Returns the user's dashboard: pages with their layout trees (widgets = components and mods with ids, grid positions), mods, theme and the files folder.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      const view = await guard(() => syncUi(ctx.session));
      return { ...summarizeUi(view.ui), theme: view.ui?.theme, errors: view.errors.length ? formatErrors(view.errors) : undefined, url: `${appUrl()}/dashboard`, undoSteps: view.undo };
    },
  },
  {
    name: "dashboard_add_widget",
    description: "Adds a component to the grid region of a page (default: the first page). Omit x/y for the first free spot and w/h for the default size. Applies live; undo with dashboard_undo.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        type: S("Component name.", { enum: COMPONENT_NAMES }),
        title: S("Card title.", { maxLength: 80 }),
        page: PAGE_PROP,
        x: I("Column (0-11).", 0, GRID_COLUMNS - 1),
        y: I("Row.", 0, 399),
        w: I("Width in columns.", 1, GRID_COLUMNS),
        h: I("Height in rows.", 1, 40),
        config: CONFIG_PROP,
      },
      required: ["type"],
    },
    async run(args, ctx) {
      const type = String(args.type ?? "");
      const spec = COMPONENTS[type];
      if (!spec) throw new ToolError(`"type" must be one of: ${COMPONENT_NAMES.join(", ")}`);
      const { ui, raw, sig } = await load(ctx);
      const grid = gridOf(pageOf(ui, args.page));
      const rawChildren = ((getAtPointer(raw, `${grid.ptr}/children`) as Raw[]) ?? []).slice();
      const w = Math.max(spec.size.minW, Math.min(GRID_COLUMNS, Number(args.w ?? spec.size.w)));
      const h = Math.max(spec.size.minH, Math.min(40, Number(args.h ?? spec.size.h)));
      const spot = args.x != null && args.y != null ? { x: Number(args.x), y: Number(args.y) } : findSpot(grid.children.map((c) => ({ x: c.x ?? 0, y: c.y ?? 0, w: c.w ?? 1, h: c.h ?? 1 })), w, h);
      const id = newId();
      const node: Raw = { type: "component", id, component: type, ...(args.title ? { title: String(args.title) } : {}), ...(args.config ? { props: args.config } : {}), x: spot.x, y: spot.y, w, h };
      const view = await apply(ctx, sig, relayout(grid, [...rawChildren, node], [id]));
      return { added: { id, type, ...spot, w, h }, version: view.sig };
    },
  },
  {
    name: "dashboard_update_widget",
    description: "Changes a widget (any layout node with an id): title, config (merged into its props unless replaceConfig=true) and/or grid position and size. Applies live; undo with dashboard_undo.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROP,
        title: S("New title (empty = default).", { maxLength: 80 }),
        config: CONFIG_PROP,
        replaceConfig: B("Replace the whole config instead of merging.", false),
        x: I("Column (0-11).", 0, GRID_COLUMNS - 1),
        y: I("Row.", 0, 399),
        w: I("Width in columns.", 1, GRID_COLUMNS),
        h: I("Height in rows.", 1, 40),
      },
      required: ["id"],
    },
    async run(args, ctx) {
      const { ui, raw, sig } = await load(ctx);
      const { node, parent } = findNode(ui, String(args.id ?? ""));
      const cur = { ...(getAtPointer(raw, node.ptr) as Raw) };
      if (args.title != null) {
        if (args.title === "") delete cur.title;
        else cur.title = String(args.title);
      }
      if (args.config != null) {
        if (typeof args.config !== "object" || Array.isArray(args.config)) throw new ToolError('"config" must be an object');
        const key = node.type === "mod" ? "config" : "props";
        cur[key] = args.replaceConfig === true ? args.config : { ...((cur[key] as Raw) ?? {}), ...(args.config as Raw) };
      }
      const moved = ["x", "y", "w", "h"].some((k) => args[k] != null);
      if (moved && parent?.type !== "grid") throw new ToolError("x/y/w/h only apply to widgets in a grid region");
      for (const k of ["x", "y", "w", "h"]) if (args[k] != null) cur[k] = Number(args[k]);
      let ops: PointerOp[] = [{ op: "set", pointer: node.ptr, value: cur }];
      if (moved && parent?.type === "grid") {
        const rawChildren = ((getAtPointer(raw, `${parent.ptr}/children`) as Raw[]) ?? []).map((c, i) => (`${parent.ptr}/children/${i}` === node.ptr ? cur : c));
        ops = relayout(parent, rawChildren, [String(cur.id ?? node.key)]);
      }
      const view = await apply(ctx, sig, ops);
      return { updated: brief(findNode(view.ui!, String(args.id)).node), version: view.sig };
    },
  },
  {
    name: "dashboard_remove_widget",
    description: "Removes a widget (layout node) from the dashboard. Undo with dashboard_undo.",
    write: true,
    selfService: true,
    inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
    async run(args, ctx) {
      const { ui, raw, sig } = await load(ctx);
      const { node, parent } = findNode(ui, String(args.id ?? ""));
      if (!parent || !("children" in parent)) throw new ToolError("That is a page's root layout; change the page in ui.json instead");
      if (parent.children.length <= 1) throw new ToolError(`It is the only child of a "${parent.type}"; edit the layout in ui.json instead`);
      const rest = ((getAtPointer(raw, `${parent.ptr}/children`) as Raw[]) ?? []).filter((_c, i) => `${parent.ptr}/children/${i}` !== node.ptr);
      const ops: PointerOp[] =
        parent.type === "grid"
          ? relayout({ ...parent, children: parent.children.filter((c) => c !== node) }, rest, [])
          : [
              { op: "remove", pointer: node.ptr },
              ...((parent.type === "row" || parent.type === "column") && getAtPointer(raw, `${parent.ptr}/sizes`) ? [{ op: "remove" as const, pointer: `${parent.ptr}/sizes` }] : []),
            ];
      const view = await apply(ctx, sig, ops);
      return { removed: args.id, version: view.sig };
    },
  },
  {
    name: "dashboard_move_widgets",
    description: "Moves and/or resizes several widgets of one grid region at once. Listed widgets keep the given spots; others that collide are pushed down, then everything floats up.",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 60,
          items: { type: "object", properties: { id: ID_PROP, x: I("Column.", 0, GRID_COLUMNS - 1), y: I("Row.", 0, 399), w: I("Width.", 1, GRID_COLUMNS), h: I("Height.", 1, 40) }, required: ["id", "x", "y"] },
        },
      },
      required: ["items"],
    },
    async run(args, ctx) {
      if (!Array.isArray(args.items) || !args.items.length) throw new ToolError('"items" must be a non-empty array');
      const { ui, raw, sig } = await load(ctx);
      const items = args.items as Args[];
      const first = findNode(ui, String(items[0].id ?? ""));
      const grid = first.parent;
      if (grid?.type !== "grid") throw new ToolError("Only widgets in a grid region can be moved this way");
      const rawChildren = ((getAtPointer(raw, `${grid.ptr}/children`) as Raw[]) ?? []).map((c) => ({ ...c }));
      const pinned: string[] = [];
      for (const it of items) {
        const hit = findNode(ui, String(it.id ?? ""));
        if (hit.parent !== grid) throw new ToolError(`"${String(it.id)}" is not in the same grid region`);
        const i = grid.children.indexOf(hit.node);
        for (const k of ["x", "y", "w", "h"]) if (it[k] != null) rawChildren[i][k] = Number(it[k]);
        pinned.push(String(rawChildren[i].id ?? hit.node.key));
      }
      const view = await apply(ctx, sig, relayout(grid, rawChildren, pinned));
      const page = view.ui?.pages.find((p) => p.id === first.page.id);
      return { version: view.sig, layout: page ? gridOf(page).children.map(brief) : [] };
    },
  },
  {
    name: "dashboard_set_theme",
    description: "Sets the dashboard's look in theme.json: accent color, density and background. Pass null to reset a field. For more (radius, font, light/dark overrides, CSS variables) edit theme.json (see ui_get_guide).",
    write: true,
    selfService: true,
    inputSchema: {
      type: "object",
      properties: {
        accent: { type: ["string", "null"], description: 'CSS color like "#0f9f8f", or null for the default.' },
        density: { type: ["string", "null"], enum: ["compact", "comfortable", "spacious", null] },
        background: { type: ["string", "null"], enum: ["plain", "muted", "grid", "dots", null] },
      },
    },
    async run(args, ctx) {
      const { files } = await load(ctx);
      let theme: Raw = {};
      try {
        theme = JSON.parse(files[THEME_FILE] ?? "{}") as Raw;
      } catch {
        theme = {};
      }
      if ("accent" in args && args.accent !== null && !isColor(args.accent)) throw new ToolError('"accent" must be a CSS color like "#3b6cf6"');
      for (const k of ["accent", "density", "background"]) {
        if (!(k in args)) continue;
        if (args[k] === null) delete theme[k];
        else theme[k] = args[k];
      }
      const { check } = await guard(() => writeUiFiles(ctx.session, { [THEME_FILE]: `${JSON.stringify(theme, null, 2)}\n` }, { reason: "theme" }));
      if (!check.ok) throw new ToolError(`theme.json is now invalid:\n${formatErrors(check.errors)}`);
      return { theme };
    },
  },
  {
    name: "dashboard_undo",
    description: "Undoes the last change to the user's Zentico UI files (up to 20 steps back, whoever made the change).",
    write: true,
    selfService: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      const view = await guard(() => undoUi(ctx.session));
      if (!view) throw new ToolError("Nothing to undo");
      return { undoStepsLeft: view.undo, ui: summarizeUi(view.ui) };
    },
  },
];
