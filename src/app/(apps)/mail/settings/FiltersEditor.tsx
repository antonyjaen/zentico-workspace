"use client";

import { ArrowDown, ArrowUp, Plus, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { LABEL_COLORS, type Label } from "@/lib/mail-labels";
import type { ConditionField, FilterAction, FilterCondition, FilterRule } from "@/lib/mail-settings";
import { saveFilters, type ActionResult } from "./actions";
import { Status, inputCls, primaryBtn, secondaryBtn } from "./ui";

type Row = FilterRule & { key: number };
type Folder = { id: string; label: string };

const FIELDS: ConditionField[] = ["from", "to", "subject", "listId", "hasAttachment", "sizeOver"];
const ACTIONS: FilterAction["type"][] = ["move", "label", "markRead", "star", "forward", "delete"];
const MAX_RULES = 100;
const MAX_CONDITIONS = 10;

const selectCls =
  "h-9 rounded-md border border-line-strong bg-sheet px-2 text-[14px] text-ink outline-none transition-colors focus:border-ink";

let seq = 0;

export function FiltersEditor({
  rules,
  labels,
  folders,
  scriptName,
  active,
  otherActive,
  unreadable,
  prefill,
}: {
  rules: FilterRule[];
  labels: Label[];
  folders: Folder[];
  scriptName: string;
  active: { name: string; content: string } | null;
  otherActive: boolean;
  unreadable: boolean;
  /** Starts a new rule from a message ("Filter messages like this"). */
  prefill?: { from?: string; listId?: string; subject?: string } | null;
}) {
  const t = useTranslations("mailSettings.filters");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const newRef = useRef<HTMLLIElement>(null);

  const defaultAction = (): FilterAction =>
    labels.length ? { type: "label", target: labels[0].id } : folders.length ? { type: "move", target: folders[0].id } : { type: "markRead" };

  const [rows, setRows] = useState<Row[]>(() => {
    const base = rules.map((r) => ({ ...r, key: seq++ }));
    const conds: FilterCondition[] = [];
    if (prefill?.from) conds.push({ field: "from", op: "contains", value: prefill.from });
    if (prefill?.listId) conds.push({ field: "listId", op: "contains", value: prefill.listId });
    if (prefill?.subject) conds.push({ field: "subject", op: "contains", value: prefill.subject });
    if (!conds.length || base.length >= MAX_RULES) return base;
    const action = defaultAction();
    return [...base, { key: seq++, name: "", enabled: true, match: "all", conditions: conds, actions: [action], stop: action.type === "move" }];
  });
  const prefilledKey = useRef(prefill && rows.length > rules.length ? rows[rows.length - 1].key : null);

  useEffect(() => {
    if (prefilledKey.current != null) newRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const patchRule = (key: number, fn: (r: Row) => Row) => setRows((rs) => rs.map((r) => (r.key === key ? fn(r) : r)));

  const move = (key: number, delta: number) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const add = () =>
    setRows((rs) => [
      ...rs,
      {
        key: seq++,
        name: "",
        enabled: true,
        match: "all",
        conditions: [{ field: "from", op: "contains", value: "" }],
        actions: [defaultAction()],
        stop: false,
      },
    ]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveFilters(rows.map(({ key: _key, ...rule }) => rule));
      setResult(r);
      if (r.ok) {
        prefilledKey.current = null;
        router.replace("/mail/settings?tab=filters", { scroll: false });
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-6">
      {otherActive && active && <Notice>{t("otherActive", { name: active.name, ours: scriptName })}</Notice>}
      {unreadable && <Notice>{t("unreadable", { name: scriptName })}</Notice>}

      <form onSubmit={submit} className="space-y-4">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-mute">
            {t("empty")}
          </p>
        ) : (
          <ol className="space-y-3">
            {rows.map((r, i) => (
              <RuleCard
                key={r.key}
                ref={r.key === prefilledKey.current ? newRef : undefined}
                rule={r}
                index={i}
                count={rows.length}
                isNew={r.key === prefilledKey.current}
                folders={folders}
                labels={labels}
                onChange={(fn) => patchRule(r.key, fn)}
                onMove={(d) => move(r.key, d)}
                onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              />
            ))}
          </ol>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={secondaryBtn} onClick={add} disabled={rows.length >= MAX_RULES}>
            <Plus size={15} aria-hidden />
            {t("add")}
          </button>
          <button type="submit" disabled={pending} className={primaryBtn}>
            {t("save")}
          </button>
          <Status result={result} />
        </div>
        <p className="text-[12.5px] text-ink-mute">{t("orderHint")}</p>
      </form>

      <details className="group rounded-lg border border-line">
        <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-medium text-ink-soft transition-colors hover:text-ink">
          {t("raw")}
          {active && <span className="ml-2 font-mono text-[12px] text-ink-mute">{active.name}</span>}
        </summary>
        <pre className="max-h-[420px] overflow-auto border-t border-line bg-sheet-muted px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre text-ink-soft">
          {active ? active.content : t("noActive")}
        </pre>
      </details>
    </div>
  );
}

function RuleCard({
  ref,
  rule: r,
  index,
  count,
  isNew,
  folders,
  labels,
  onChange,
  onMove,
  onRemove,
}: {
  ref?: React.Ref<HTMLLIElement>;
  rule: Row;
  index: number;
  count: number;
  isNew: boolean;
  folders: Folder[];
  labels: Label[];
  onChange: (fn: (r: Row) => Row) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("mailSettings.filters");

  const setCond = (i: number, patch: Partial<FilterCondition>) =>
    onChange((x) => ({
      ...x,
      conditions: x.conditions.map((c, j) => {
        if (j !== i) return c;
        const next = { ...c, ...patch };
        if (patch.field && patch.field !== c.field) {
          if (patch.field === "hasAttachment") return { field: patch.field };
          if (patch.field === "sizeOver") return { field: patch.field, value: "5M" };
          if (c.field === "hasAttachment" || c.field === "sizeOver") return { field: patch.field, op: "contains", value: "" };
        }
        return next;
      }),
    }));

  const setAction = (i: number, type: FilterAction["type"], target?: string) =>
    onChange((x) => ({
      ...x,
      actions: x.actions.map((a, j) => {
        if (j !== i) return a;
        if (type !== a.type) {
          const t2 = type === "move" ? folders[0]?.id : type === "label" ? labels[0]?.id : type === "forward" ? "" : undefined;
          return t2 === undefined ? { type } : { type, target: t2 };
        }
        return target === undefined ? a : { type, target };
      }),
    }));

  const usedTypes = new Set(r.actions.filter((a) => a.type !== "label").map((a) => a.type));
  const nextType = ACTIONS.find((a) => !usedTypes.has(a) && (a !== "move" || folders.length) && (a !== "label" || labels.length));

  return (
    <li
      ref={ref}
      className={`rounded-lg border px-3 py-3 text-[14px] text-ink-soft transition-opacity ${
        isNew ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : "border-line"
      } ${r.enabled ? "" : "opacity-60"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 font-mono text-[12px] tabular-nums text-ink-mute">{String(index + 1).padStart(2, "0")}</span>
        <input
          aria-label={t("name")}
          placeholder={t("namePlaceholder")}
          maxLength={80}
          value={r.name}
          onChange={(e) => onChange((x) => ({ ...x, name: e.target.value }))}
          className={`${inputCls} w-auto min-w-[160px] flex-1`}
        />
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={r.enabled}
            onChange={(e) => onChange((x) => ({ ...x, enabled: e.target.checked }))}
          />
          {t("enabled")}
        </label>
        <div className="ml-auto flex items-center">
          <IconBtn label={t("moveUp")} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={15} aria-hidden />
          </IconBtn>
          <IconBtn label={t("moveDown")} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown size={15} aria-hidden />
          </IconBtn>
          <IconBtn label={t("remove")} onClick={onRemove}>
            <X size={15} aria-hidden />
          </IconBtn>
        </div>
      </div>

      <div className="mt-3 space-y-2 pl-8">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-medium text-ink">{t("if")}</span>
          {r.conditions.length > 1 && (
            <>
              <select
                aria-label={t("match")}
                value={r.match}
                onChange={(e) => onChange((x) => ({ ...x, match: e.target.value === "any" ? "any" : "all" }))}
                className={selectCls}
              >
                <option value="all">{t("matchAll")}</option>
                <option value="any">{t("matchAny")}</option>
              </select>
              <span>{t("ofThese")}</span>
            </>
          )}
        </div>
        {r.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("field")}
              value={c.field}
              onChange={(e) => setCond(i, { field: e.target.value as ConditionField })}
              className={selectCls}
            >
              {FIELDS.map((f) => (
                <option key={f} value={f}>
                  {t(`fields.${f}`)}
                </option>
              ))}
            </select>
            {c.field === "hasAttachment" ? null : c.field === "sizeOver" ? (
              <SizeInput value={c.value ?? "5M"} onChange={(value) => setCond(i, { value })} />
            ) : (
              <>
                <select
                  aria-label={t("operator")}
                  value={c.op ?? "contains"}
                  onChange={(e) => setCond(i, { op: e.target.value === "notContains" ? "notContains" : "contains" })}
                  className={selectCls}
                >
                  <option value="contains">{t("contains")}</option>
                  <option value="notContains">{t("notContains")}</option>
                </select>
                <input
                  aria-label={t("value")}
                  placeholder={t("value")}
                  required
                  maxLength={200}
                  value={c.value ?? ""}
                  onChange={(e) => setCond(i, { value: e.target.value })}
                  className={`${inputCls} w-auto min-w-[140px] flex-1`}
                />
              </>
            )}
            {r.conditions.length > 1 && (
              <IconBtn label={t("removeCondition")} onClick={() => onChange((x) => ({ ...x, conditions: x.conditions.filter((_, j) => j !== i) }))}>
                <X size={14} aria-hidden />
              </IconBtn>
            )}
          </div>
        ))}
        {r.conditions.length < MAX_CONDITIONS && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[13px] text-ink-mute transition-colors hover:text-ink"
            onClick={() => onChange((x) => ({ ...x, conditions: [...x.conditions, { field: "subject", op: "contains", value: "" }] }))}
          >
            <Plus size={13} aria-hidden />
            {t("addCondition")}
          </button>
        )}

        <div className="pt-2 text-[13px] font-medium text-ink">{t("then")}</div>
        {r.actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("action")}
              value={a.type}
              onChange={(e) => setAction(i, e.target.value as FilterAction["type"])}
              className={selectCls}
            >
              {ACTIONS.map((type) => (
                <option
                  key={type}
                  value={type}
                  disabled={
                    (type !== a.type && type !== "label" && usedTypes.has(type)) ||
                    (type === "move" && !folders.length) ||
                    (type === "label" && !labels.length)
                  }
                >
                  {t(`actions.${type}`)}
                </option>
              ))}
            </select>
            {a.type === "move" && (
              <select
                aria-label={t("folder")}
                required
                value={a.target ?? ""}
                onChange={(e) => setAction(i, "move", e.target.value)}
                className={`${selectCls} max-w-[240px]`}
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
            {a.type === "label" && (
              <select
                aria-label={t("label")}
                required
                value={a.target ?? ""}
                onChange={(e) => setAction(i, "label", e.target.value)}
                className={`${selectCls} max-w-[240px]`}
              >
                {labels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            {a.type === "label" && a.target && (
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: LABEL_COLORS[labels.find((l) => l.id === a.target)?.color ?? "gray"] }}
              />
            )}
            {a.type === "forward" && (
              <input
                type="email"
                aria-label={t("forwardTo")}
                placeholder={t("forwardTo")}
                required
                maxLength={254}
                value={a.target ?? ""}
                onChange={(e) => setAction(i, "forward", e.target.value)}
                className={`${inputCls} w-auto min-w-[200px]`}
              />
            )}
            {r.actions.length > 1 && (
              <IconBtn label={t("removeAction")} onClick={() => onChange((x) => ({ ...x, actions: x.actions.filter((_, j) => j !== i) }))}>
                <X size={14} aria-hidden />
              </IconBtn>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-4">
          {nextType && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[13px] text-ink-mute transition-colors hover:text-ink"
              onClick={() =>
                onChange((x) => ({
                  ...x,
                  actions: [
                    ...x.actions,
                    nextType === "move"
                      ? { type: "move", target: folders[0]?.id }
                      : nextType === "label"
                        ? { type: "label", target: labels[0]?.id }
                        : nextType === "forward"
                          ? { type: "forward", target: "" }
                          : { type: nextType },
                  ],
                }))
              }
            >
              <Plus size={13} aria-hidden />
              {t("addAction")}
            </button>
          )}
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={r.stop}
              onChange={(e) => onChange((x) => ({ ...x, stop: e.target.checked }))}
            />
            {t("stop")}
          </label>
        </div>

        <p className="rounded-md bg-sheet-muted px-3 py-2 text-[12.5px] leading-relaxed text-ink-mute">
          <RuleSummary rule={r} folders={folders} labels={labels} />
        </p>
      </div>
    </li>
  );
}

/** Plain-language description of what the rule does (the "test by description" preview). */
function RuleSummary({ rule: r, folders, labels }: { rule: FilterRule; folders: Folder[]; labels: Label[] }) {
  const t = useTranslations("mailSettings.filters.summary");
  const conds = r.conditions.map((c) => {
    if (c.field === "hasAttachment") return t("hasAttachment");
    if (c.field === "sizeOver") return t("sizeOver", { size: formatSize(c.value ?? "") });
    return t(c.op === "notContains" ? "notContains" : "contains", { field: t(`fields.${c.field}`), value: c.value || "…" });
  });
  const acts = r.actions.map((a) => {
    switch (a.type) {
      case "move":
        return t("move", { folder: folders.find((f) => f.id === a.target)?.label ?? "…" });
      case "label":
        return t("label", { label: labels.find((l) => l.id === a.target)?.name ?? "…" });
      case "forward":
        return t("forward", { address: a.target || "…" });
      default:
        return t(a.type);
    }
  });
  const joiner = r.match === "any" ? t("or") : t("and");
  const text = t("sentence", { conditions: conds.join(joiner), actions: acts.join(", ") });
  return (
    <>
      {!r.enabled && <strong className="mr-1 font-medium">{t("disabled")}</strong>}
      {text}
      {r.stop && ` ${t("stop")}`}
    </>
  );
}

const formatSize = (v: string) => (v.endsWith("M") ? `${v.slice(0, -1)} MB` : `${v.slice(0, -1)} KB`);

function SizeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations("mailSettings.filters");
  const unit = value.endsWith("K") ? "K" : "M";
  const num = value.replace(/[KM]$/, "");
  return (
    <span className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        max={999999}
        required
        aria-label={t("size")}
        value={num}
        onChange={(e) => onChange(`${Math.max(1, Math.min(999999, Number.parseInt(e.target.value, 10) || 1))}${unit}`)}
        className={`${inputCls} w-24`}
      />
      <select aria-label={t("unit")} value={unit} onChange={(e) => onChange(`${num || 1}${e.target.value}`)} className={selectCls}>
        <option value="K">KB</option>
        <option value="M">MB</option>
      </select>
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="icon-btn h-8 w-8 disabled:opacity-35" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2.5 rounded-lg border border-line-strong px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
      <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0 text-amber" />
      <span>{children}</span>
    </p>
  );
}
