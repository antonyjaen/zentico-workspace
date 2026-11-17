// Excalidraw element building shared by the Drive whiteboard tools (whiteboard_*) and the live
// meeting stage (meeting_whiteboard_*): simple skeletons (shapes with labels, text, arrows bound to
// shapes) → full Excalidraw elements, small patches, and a compact summary for agents. Server-only.
import { ToolError, type Args } from "../mcp/args";

export type WbElement = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
};

export const SHAPES = ["rectangle", "ellipse", "diamond"] as const;
export const WB_TYPES = [...SHAPES, "text", "arrow", "line"] as const;

export const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
export const rnd = () => Math.floor(Math.random() * 2 ** 31);
export const newElementId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|[a-z]{3,20})$/;

export function baseElement(type: string, x: number, y: number, width: number, height: number, style: Args): WbElement {
  const color = (k: string, def: string) => (typeof style[k] === "string" && COLOR.test(style[k] as string) ? (style[k] as string) : def);
  return {
    id: newElementId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: color("strokeColor", "#1e1e1e"),
    backgroundColor: color("backgroundColor", "transparent"),
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" || type === "diamond" ? { type: 3 } : type === "arrow" || type === "line" ? { type: 2 } : null,
    seed: rnd(),
    version: 1,
    versionNonce: rnd(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

const textSize = (text: string, fontSize: number) => {
  const lines = text.split("\n");
  return { width: Math.max(10, Math.max(...lines.map((l) => l.length)) * fontSize * 0.6), height: lines.length * fontSize * 1.25 };
};

export function textElement(text: string, x: number, y: number, fontSize: number, style: Args, containerId: string | null): WbElement {
  const { width, height } = textSize(text, fontSize);
  return {
    ...baseElement("text", containerId ? x - width / 2 : x, containerId ? y - height / 2 : y, width, height, { strokeColor: style.strokeColor }),
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  };
}

/** Where the segment from the box's center toward (tx, ty) leaves the box. */
export function edgePoint(el: WbElement, tx: number, ty: number): [number, number] {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const scale = Math.min(dx ? el.width / 2 / Math.abs(dx) : Infinity, dy ? el.height / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * Math.min(scale, 1), cy + dy * Math.min(scale, 1)];
}

export const labelOf = (el: WbElement, byId: Map<string, WbElement>) => {
  const bound = (el.boundElements as { id: string; type: string }[] | null) ?? [];
  const t = bound.map((b) => byId.get(b.id)).find((b) => b && b.type === "text" && !b.isDeleted);
  return t ? String(t.text ?? "") : undefined;
};

/** Marks an element as changed the way Excalidraw does (so reconciling peers take it). */
export function bump(el: WbElement): WbElement {
  el.version = num(el.version, 1) + 1;
  el.versionNonce = rnd();
  el.updated = Date.now();
  return el;
}

/** JSON schema of one element skeleton (shared by both tool families). */
export const SKELETON_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...WB_TYPES] },
    ref: { type: "string", description: "Your name for this element, to connect arrows to it." },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    text: { type: "string", description: "Text of a text element." },
    label: { type: "string", description: "Text inside a shape (or on an arrow)." },
    fontSize: { type: "number" },
    from: { type: "string", description: "Arrow start: element id or ref." },
    to: { type: "string", description: "Arrow end: element id or ref." },
    endX: { type: "number" },
    endY: { type: "number" },
    strokeColor: { type: "string", description: 'e.g. "#1971c2".' },
    backgroundColor: { type: "string", description: 'e.g. "#a5d8ff" or "transparent".' },
  },
  required: ["type"],
} as const;

/**
 * Builds Excalidraw elements from skeletons next to the `existing` ones. Elements without x/y are
 * laid out in a row below the drawing; arrows bind to existing ids or same-call refs. Returns the
 * new elements in drawing order (shapes with their labels first, arrows last), the existing
 * elements that changed (arrow bindings), and ref → id.
 */
export function buildElements(
  skeletons: unknown[],
  existing: WbElement[],
): { added: WbElement[]; touched: WbElement[]; refs: Map<string, WbElement> } {
  const live = existing.filter((e) => e && !e.isDeleted);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const refs = new Map<string, WbElement>();
  const added: WbElement[] = [];
  const touched = new Map<string, WbElement>();
  const bottom = live.length ? Math.max(...live.map((e) => num(e.y, 0) + num(e.height, 0))) : 0;
  const left = live.length ? Math.min(...live.map((e) => num(e.x, 0))) : 0;
  let cursorX = left;
  const rowY = live.length ? bottom + 80 : 0;
  const place = (w: number) => {
    const x = cursorX;
    cursorX += w + 60;
    return x;
  };
  const arrows: { input: Args; el: WbElement }[] = [];

  for (const [i, raw] of skeletons.entries()) {
    const e = (raw && typeof raw === "object" ? raw : {}) as Args;
    const type = String(e.type ?? "");
    if (!(WB_TYPES as readonly string[]).includes(type)) throw new ToolError(`elements[${i}].type must be one of ${WB_TYPES.join(", ")}`);
    const textOf = (k: string) => (typeof e[k] === "string" ? (e[k] as string).slice(0, 2000) : "");
    const fontSize = Math.min(Math.max(num(e.fontSize, 20), 8), 120);
    let el: WbElement;
    if (type === "text") {
      const text = textOf("text") || textOf("label");
      if (!text) throw new ToolError(`elements[${i}] (text) needs "text"`);
      const t = textElement(text, 0, 0, fontSize, e, null);
      t.x = num(e.x, NaN);
      t.y = num(e.y, NaN);
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) [t.x, t.y] = [place(t.width), rowY];
      el = t;
      added.push(el);
    } else if (type === "arrow" || type === "line") {
      el = baseElement(type, num(e.x, 0), num(e.y, 0), 0, 0, e);
      Object.assign(el, {
        points: [
          [0, 0],
          [0, 0],
        ],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: type === "arrow" ? "arrow" : null,
        elbowed: false,
      });
      arrows.push({ input: e, el });
    } else {
      const dw = type === "rectangle" ? 200 : 160;
      const dh = type === "diamond" ? 100 : 80;
      const w = Math.min(Math.max(num(e.width, dw), 10), 5000);
      const h = Math.min(Math.max(num(e.height, dh), 10), 5000);
      const x = num(e.x, NaN);
      const y = num(e.y, NaN);
      el = baseElement(type, Number.isFinite(x) ? x : place(w), Number.isFinite(y) ? y : rowY, w, h, e);
      added.push(el);
      const label = textOf("label") || textOf("text");
      if (label) {
        const t = textElement(label, el.x + w / 2, el.y + h / 2, fontSize, e, el.id);
        el.boundElements = [{ type: "text", id: t.id }];
        added.push(t);
      }
    }
    const ref = typeof e.ref === "string" ? e.ref.trim() : "";
    if (ref) refs.set(ref, el);
  }

  // Arrows: connect to existing elements (by id) or new ones (by ref), edge to edge.
  for (const { input, el } of arrows) {
    const target = (k: string) => {
      const v = typeof input[k] === "string" ? (input[k] as string).trim() : "";
      if (!v) return null;
      const hit = refs.get(v) ?? byId.get(v);
      if (!hit || hit.isDeleted) throw new ToolError(`Arrow ${k} "${v}" is not an element id or ref`);
      return hit;
    };
    const a = target("from");
    const b = target("to");
    const ac: [number, number] = a ? [a.x + a.width / 2, a.y + a.height / 2] : [num(input.x, NaN), num(input.y, NaN)];
    const bc: [number, number] = b ? [b.x + b.width / 2, b.y + b.height / 2] : [num(input.endX, NaN), num(input.endY, NaN)];
    if (![...ac, ...bc].every(Number.isFinite)) throw new ToolError("Each arrow/line needs from/to elements or x, y, endX, endY");
    const start = a ? edgePoint(a, bc[0], bc[1]) : ac;
    const end = b ? edgePoint(b, ac[0], ac[1]) : bc;
    Object.assign(el, {
      x: start[0],
      y: start[1],
      width: Math.abs(end[0] - start[0]),
      height: Math.abs(end[1] - start[1]),
      points: [
        [0, 0],
        [end[0] - start[0], end[1] - start[1]],
      ],
      startBinding: a ? { elementId: a.id, focus: 0, gap: 4 } : null,
      endBinding: b ? { elementId: b.id, focus: 0, gap: 4 } : null,
    });
    added.push(el);
    for (const s of [a, b]) {
      if (!s) continue;
      const bound = ((s.boundElements as { id: string; type: string }[] | null) ?? []).filter((x) => x.id !== el.id);
      s.boundElements = [...bound, { type: "arrow", id: el.id }];
      if (byId.has(s.id)) touched.set(s.id, bump(s));
    }
    const label = typeof input.label === "string" ? input.label.slice(0, 500) : "";
    if (label) {
      const t = textElement(label, (start[0] + end[0]) / 2, (start[1] + end[1]) / 2, 16, input, el.id);
      el.boundElements = [{ type: "text", id: t.id }];
      added.push(t);
    }
  }
  return { added, touched: [...touched.values()], refs };
}

/** A small change to one element (and its bound label). Returns every element that changed. */
export function patchElement(
  el: WbElement,
  patch: { text?: string; x?: number; y?: number; w?: number; h?: number; stroke?: string; fill?: string },
  byId: Map<string, WbElement>,
): WbElement[] {
  const changed = new Map<string, WbElement>();
  const dx = typeof patch.x === "number" && Number.isFinite(patch.x) ? patch.x - el.x : 0;
  const dy = typeof patch.y === "number" && Number.isFinite(patch.y) ? patch.y - el.y : 0;
  if (dx || dy) {
    el.x += dx;
    el.y += dy;
  }
  if (typeof patch.w === "number" && patch.w >= 10 && patch.w <= 5000) el.width = patch.w;
  if (typeof patch.h === "number" && patch.h >= 10 && patch.h <= 5000) el.height = patch.h;
  if (typeof patch.stroke === "string" && COLOR.test(patch.stroke)) el.strokeColor = patch.stroke;
  if (typeof patch.fill === "string" && COLOR.test(patch.fill)) el.backgroundColor = patch.fill;
  changed.set(el.id, el);

  const bound = (el.boundElements as { id: string; type: string }[] | null) ?? [];
  let label = bound.map((b) => byId.get(b.id)).find((b) => b && b.type === "text" && !b.isDeleted) ?? null;
  if (typeof patch.text === "string") {
    const text = patch.text.slice(0, 2000);
    if (el.type === "text") {
      Object.assign(el, { text, originalText: text, ...textSize(text, num(el.fontSize, 20)) });
    } else if (label) {
      Object.assign(label, { text, originalText: text, ...textSize(text, num(label.fontSize, 20)) });
      changed.set(label.id, label);
    } else if (text) {
      label = textElement(text, el.x + el.width / 2, el.y + el.height / 2, 20, {}, el.id);
      el.boundElements = [...bound, { type: "text", id: label.id }];
      changed.set(label.id, label);
    }
  }
  // Keep a bound label centered in its container.
  if (label && el.type !== "text" && el.type !== "arrow" && el.type !== "line") {
    label.x = el.x + el.width / 2 - label.width / 2;
    label.y = el.y + el.height / 2 - label.height / 2;
    changed.set(label.id, label);
  }
  for (const c of changed.values()) bump(c);
  return [...changed.values()];
}

/** Compact view of a drawing for agents: ids, types, text, box and arrow endpoints. */
export function summarizeElements(elements: WbElement[]) {
  const live = elements.filter((e) => e && !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const r = Math.round;
  return live
    .filter((e) => !(e.type === "text" && e.containerId && byId.has(String(e.containerId))))
    .map((e) => {
      const sb = e.startBinding as { elementId?: string } | null | undefined;
      const eb = e.endBinding as { elementId?: string } | null | undefined;
      return {
        id: e.id,
        type: e.type,
        x: r(num(e.x, 0)),
        y: r(num(e.y, 0)),
        width: r(num(e.width, 0)),
        height: r(num(e.height, 0)),
        text: e.type === "text" ? String(e.text ?? "") : labelOf(e, byId),
        from: sb?.elementId,
        to: eb?.elementId,
        color: e.strokeColor !== "#1e1e1e" ? e.strokeColor : undefined,
        fill: e.backgroundColor && e.backgroundColor !== "transparent" ? e.backgroundColor : undefined,
      };
    });
}
