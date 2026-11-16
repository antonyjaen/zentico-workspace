"use client";

// Renders a Zentico UI layout tree: row / column splits with draggable dividers (new sizes are
// written back to ui.json), tabs, scrolling stacks, 12-column grid regions (drag and resize in edit
// mode) and leaf cards (built-in components and mods). On narrow screens splits stack vertically.
import { BarChart3, CalendarDays, Clock, Code2, FileText, Folder, HardDrive, Link2, Mail, MailOpen, MessageSquare, MoreHorizontal, Pencil, RotateCw, Sparkles, StickyNote, Terminal, Trash2, Video, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { uiIcon } from "@/components/uiIcons";
import { usePopover } from "@/components/usePopover";
import { COMPONENTS, minSizeOf, type PointerOp, type UiContainer, type UiNode } from "@/lib/ui/schema";
import { LeafBody } from "./blocks";
import { Grid } from "./Grid";
import { useStudio } from "./studio-context";

const COMPONENT_ICONS: Record<string, LucideIcon> = {
  agenda: CalendarDays,
  mail: Mail,
  chat: MessageSquare,
  drive: HardDrive,
  meetings: Video,
  notes: StickyNote,
  links: Link2,
  clock: Clock,
  chart: BarChart3,
  custom: Code2,
  "mail.thread": MailOpen,
  "chat.conversation": MessageSquare,
  "calendar.week": CalendarDays,
  "drive.folder": Folder,
  "doc.markdown": FileText,
  "meetings.next": Video,
  claude: Sparkles,
};

/** Converts a compiled node back into ui.json form (drops runtime fields). */
export function toRaw(n: UiNode): Record<string, unknown> {
  const { key: _k, ptr: _p, ...rest } = n as UiNode & Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  for (const k of ["x", "y", "w", "h", "height", "id", "title"]) if (out[k] === undefined) delete out[k];
  if ("children" in n) out.children = n.children.map(toRaw);
  if (n.type === "component" && n.chrome === "card") delete out.chrome;
  if (n.type === "mod" && n.chrome === "card") delete out.chrome;
  return out;
}

export const parentPtr = (ptr: string) => ptr.replace(/\/children\/\d+$/, "");
const indexOf = (ptr: string) => Number(/\/children\/(\d+)$/.exec(ptr)?.[1] ?? -1);

export function useNodeTitle() {
  const t = useTranslations("dashboard");
  const studio = useStudio();
  return (n: UiNode) => {
    if (n.title) return n.title;
    if (n.type === "component") return t(`types.${n.component.replace(".", "_")}`);
    if (n.type === "mod") return studio.view.ui?.mods[n.mod]?.name ?? n.mod;
    return "";
  };
}

/* -------------------------------------------------------------------- card */

function CardMenu({ node, parent, onRefresh, onConfigure }: { node: UiNode; parent: UiContainer | null; onRefresh: () => void; onConfigure?: () => void }) {
  const t = useTranslations("dashboard.menu");
  const studio = useStudio();
  const title = useNodeTitle()(node);
  const { open, toggle, setOpen, ref } = usePopover();
  const mod = node.type === "mod" ? studio.view.ui?.mods[node.mod] : undefined;
  const item = (icon: ReactNode, label: string, fn: () => void, danger = false) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        fn();
      }}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${danger ? "text-danger" : "text-ink"}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button type="button" className="icon-btn !h-7 !w-7" aria-label={t("label")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="pop absolute top-8 right-0 z-30 w-64 p-1">
          {item(<Sparkles size={14} aria-hidden />, t("ask"), () =>
            studio.askClaude(t("askPrefill", { name: title, page: studio.pageId, ptr: node.ptr, what: node.type === "mod" ? `mods/${node.mod}/` : node.type === "component" ? node.component : node.type })),
          )}
          {onConfigure && item(<Pencil size={14} aria-hidden />, t("configure"), onConfigure)}
          {item(<RotateCw size={14} aria-hidden />, t("refresh"), onRefresh)}
          {mod?.commands.map((c) => item(<Terminal size={14} aria-hidden />, c.title, () => window.dispatchEvent(new CustomEvent("zw-ui-action", { detail: { action: "mod", mod: mod.id, command: c.id } }))))}
          {mod && item(<Sparkles size={14} aria-hidden />, t("publishMod"), () => window.dispatchEvent(new CustomEvent("zw-ui-publish", { detail: { kind: "mod", id: mod.id, name: mod.name, description: mod.description } })))}
          {parent && parent.children.length > 1 && item(<Trash2 size={14} aria-hidden />, t("remove"), () => void removeNode(studio, node, parent), true)}
        </div>
      )}
    </div>
  );
}

async function removeNode(studio: ReturnType<typeof useStudio>, node: UiNode, parent: UiContainer) {
  const i = indexOf(node.ptr);
  const ops: PointerOp[] = [{ op: "remove", pointer: node.ptr }];
  if (parent.type === "row" || parent.type === "column") ops.push({ op: "set", pointer: `${parent.ptr}/sizes`, value: parent.sizes.filter((_s, k) => k !== i).map((s) => Math.round(s * 100) / 100) });
  if (parent.type === "tabs") ops.push({ op: "set", pointer: `${parent.ptr}/active`, value: 0 });
  const err = await studio.patch(ops);
  if (err) studio.toast(err);
}

function Card({
  node,
  parent,
  dragHandle,
  resizeHandle,
  fill = true,
}: {
  node: Extract<UiNode, { type: "component" | "mod" }>;
  parent: UiContainer | null;
  dragHandle?: (e: React.PointerEvent) => void;
  resizeHandle?: ReactNode;
  fill?: boolean;
}) {
  const studio = useStudio();
  const titleOf = useNodeTitle();
  const [refresh, setRefresh] = useState(0);
  const title = titleOf(node);
  const mod = node.type === "mod" ? studio.view.ui?.mods[node.mod] : undefined;
  const Icon = node.type === "mod" ? uiIcon(mod?.icon) : (COMPONENT_ICONS[node.component] ?? Sparkles);
  const legacy = node.type === "component" && !!COMPONENTS[node.component]?.widget;
  const configure = legacy ? () => window.dispatchEvent(new CustomEvent("zw-ui-configure", { detail: { ptr: node.ptr } })) : undefined;
  const body = (
    <div className={`min-h-0 flex-1 overflow-y-auto ${node.chrome === "plain" ? "" : node.type === "mod" ? "" : "px-1.5 pb-2"} ${studio.editing ? "pointer-events-none select-none" : ""}`}>
      <LeafBody node={node} refreshKey={refresh} title={title} />
    </div>
  );
  if (node.chrome === "plain" && !studio.editing) return <div className={`relative flex ${fill ? "h-full" : ""} flex-col overflow-hidden`}>{body}</div>;
  return (
    <article
      className={`relative flex ${fill ? "h-full" : ""} flex-col overflow-hidden rounded-[var(--ui-radius)] border bg-[var(--ui-card)] ${studio.editing ? "border-line-strong" : "border-line"}`}
      aria-label={title}
    >
      <header onPointerDown={dragHandle} className={`flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3 ${dragHandle && studio.editing ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}>
        <Icon size={14} aria-hidden className="shrink-0 text-[var(--dash-accent)]" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{title}</h3>
        {studio.editing && parent && parent.children.length > 1 && (
          <button type="button" className="icon-btn !h-7 !w-7" aria-label={title} title={title} onClick={() => void removeNode(studio, node, parent)}>
            <Trash2 size={14} aria-hidden />
          </button>
        )}
        <CardMenu node={node} parent={parent} onRefresh={() => setRefresh((r) => r + 1)} onConfigure={configure} />
      </header>
      {body}
      {resizeHandle}
    </article>
  );
}

/* ------------------------------------------------------------------- split */

const MIN_PCT = 8;

function Split({ node, narrow }: { node: Extract<UiNode, { type: "row" | "column" }>; narrow: boolean }) {
  const studio = useStudio();
  const box = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState(node.sizes);
  const drag = useRef<{ i: number; start: number; total: number; base: number[]; id: number } | null>(null);
  const key = node.sizes.join(",");
  useEffect(() => setSizes(node.sizes), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const horizontal = node.type === "row" && !narrow;

  if (narrow) {
    return (
      <div className="flex flex-col gap-[var(--ui-gap)]">
        {node.children.map((c) => (
          <div key={c.key} className={c.type === "component" || c.type === "mod" ? "h-[420px]" : ""}>
            <NodeView node={c} parent={node} narrow />
          </div>
        ))}
      </div>
    );
  }

  const onDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0 || !box.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = box.current.getBoundingClientRect();
    drag.current = { i, start: horizontal ? e.clientX : e.clientY, total: horizontal ? r.width : r.height, base: sizes, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const delta = (((horizontal ? e.clientX : e.clientY) - d.start) / Math.max(1, d.total)) * 100;
    const a = d.base[d.i] + delta;
    const b = d.base[d.i + 1] - delta;
    if (a < MIN_PCT || b < MIN_PCT) return;
    setSizes(d.base.map((s, k) => (k === d.i ? a : k === d.i + 1 ? b : s)));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (sizes.join(",") === d.base.join(",")) return;
    void studio.patch([{ op: "set", pointer: `${node.ptr}/sizes`, value: sizes.map((s) => Math.round(s * 100) / 100) }]).then((err) => {
      if (err) {
        setSizes(node.sizes);
        studio.toast(err);
      }
    });
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[e.key];
    if (!step) return;
    e.preventDefault();
    const a = sizes[i] + step;
    const b = sizes[i + 1] - step;
    if (a < MIN_PCT || b < MIN_PCT) return;
    const next = sizes.map((s, k) => (k === i ? a : k === i + 1 ? b : s));
    setSizes(next);
    void studio.patch([{ op: "set", pointer: `${node.ptr}/sizes`, value: next.map((s) => Math.round(s * 100) / 100) }]);
  };

  return (
    <div ref={box} className={`flex h-full min-h-0 w-full min-w-0 ${horizontal ? "flex-row" : "flex-col"}`}>
      {node.children.map((c, i) => (
        <div key={c.key} className="contents">
          <div className="min-h-0 min-w-0" style={{ flex: `${sizes[i]} 1 0%` } as CSSProperties}>
            <NodeView node={c} parent={node} narrow={false} />
          </div>
          {i < node.children.length - 1 && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              aria-valuenow={Math.round(sizes[i])}
              onPointerDown={(e) => onDown(e, i)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={(e) => onKey(e, i)}
              className={`group relative shrink-0 touch-none outline-none ${horizontal ? "w-[var(--ui-gap)] cursor-col-resize" : "h-[var(--ui-gap)] cursor-row-resize"}`}
            >
              <span
                aria-hidden
                className={`absolute rounded-full bg-transparent transition-colors group-hover:bg-line-strong group-focus-visible:bg-[var(--dash-accent)] ${horizontal ? "inset-y-6 left-1/2 w-[3px] -translate-x-1/2" : "inset-x-6 top-1/2 h-[3px] -translate-y-1/2"}`}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- tabs */

function Tabs({ node, narrow }: { node: Extract<UiNode, { type: "tabs" }>; narrow: boolean }) {
  const titleOf = useNodeTitle();
  const [active, setActive] = useState(node.active);
  const i = Math.min(active, node.children.length - 1);
  const child = node.children[i];
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto">
        {node.children.map((c, k) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={k === i}
            onClick={() => setActive(k)}
            className="h-8 shrink-0 rounded-lg px-3 text-[13px] font-medium text-ink-mute transition-colors hover:bg-hover hover:text-ink aria-selected:bg-[var(--ui-card)] aria-selected:text-ink aria-selected:shadow-[inset_0_0_0_1px_var(--color-line)]"
          >
            {titleOf(c)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className={narrow && (child.type === "component" || child.type === "mod") ? "h-[420px]" : "min-h-0 flex-1"}>
        <NodeView key={child.key} node={child.type === "component" || child.type === "mod" ? { ...child, title: child.title } : child} parent={node} narrow={narrow} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- stack */

function Stack({ node, narrow }: { node: Extract<UiNode, { type: "stack" }>; narrow: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" style={{ gap: node.gap }}>
      {node.children.map((c) => (
        <div key={c.key} className="shrink-0" style={{ height: c.height ?? 320 }}>
          <NodeView node={c} parent={node} narrow={narrow} />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- grid */

function GridRegion({ node }: { node: Extract<UiNode, { type: "grid" }> }) {
  const studio = useStudio();
  const items = node.children.map((c) => ({ id: c.key, x: c.x ?? 0, y: c.y ?? 0, w: c.w ?? 4, h: c.h ?? 6, ...minSizeOf(c) }));
  const byKey = new Map(node.children.map((c) => [c.key, c]));
  const gap = studio.gap;
  return (
    <div className="h-full overflow-y-auto">
      <Grid
        widgets={items}
        editing={studio.editing}
        row={node.rowHeight}
        gap={gap}
        onCommit={(changed) => {
          const ops: PointerOp[] = [];
          for (const b of changed) {
            const c = byKey.get(b.id);
            if (!c) continue;
            for (const k of ["x", "y", "w", "h"] as const) ops.push({ op: "set", pointer: `${c.ptr}/${k}`, value: b[k] });
          }
          if (ops.length) void studio.patch(ops).then((e) => e && studio.toast(e));
        }}
        renderCard={(b, opts) => {
          const c = byKey.get(b.id)!;
          if (c.type === "component" || c.type === "mod") {
            return <Card node={c} parent={node} dragHandle={opts.desktop ? opts.dragHandle : undefined} resizeHandle={opts.resizeHandle} />;
          }
          return (
            <div className="relative h-full" onPointerDown={studio.editing ? opts.dragHandle : undefined}>
              <NodeView node={c} parent={node} narrow={!opts.desktop} />
              {opts.resizeHandle}
            </div>
          );
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- node */

export function NodeView({ node, parent, narrow }: { node: UiNode; parent: UiContainer | null; narrow: boolean }) {
  switch (node.type) {
    case "row":
    case "column":
      return <Split node={node} narrow={narrow} />;
    case "tabs":
      return <Tabs node={node} narrow={narrow} />;
    case "stack":
      return <Stack node={node} narrow={narrow} />;
    case "grid":
      return <GridRegion node={node} />;
    default:
      return <Card node={node} parent={parent} />;
  }
}
