"use client";

import { Plus, Tag } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { usePopover } from "@/components/usePopover";
import { LABEL_COLORS, type Label } from "@/lib/mail-labels";
import { createLabel } from "./actions";

export function LabelDot({ color, size = 8 }: { color: Label["color"]; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: LABEL_COLORS[color] ?? LABEL_COLORS.gray }}
    />
  );
}

/** Small label chip used on list rows and in the thread header. */
export function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex h-[20px] max-w-[140px] shrink-0 items-center gap-1.5 rounded-md border border-line bg-sheet-muted px-1.5 text-[11.5px] font-medium text-ink-soft">
      <LabelDot color={label.color} size={7} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/**
 * "Label" popover: a checkbox per label (indeterminate when only some of the targets have it)
 * plus a field to create a label and apply it right away.
 */
export function LabelPicker({
  labels,
  stateOf,
  onToggle,
  buttonClassName = "icon-btn h-9 w-9",
  align = "left",
}: {
  labels: Label[];
  stateOf: (id: string) => "all" | "some" | "none";
  onToggle: (id: string, on: boolean) => void;
  buttonClassName?: string;
  align?: "left" | "right";
}) {
  const t = useTranslations("mailActions.labels");
  const { open, toggle, ref } = usePopover();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Labels created here show up before the server re-renders the list.
  const [created, setCreated] = useState<Label[]>([]);
  const all = [...labels, ...created.filter((c) => !labels.some((l) => l.id === c.id))];
  const shown = all.filter((l) => l.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const exact = all.some((l) => l.name.toLowerCase() === filter.trim().toLowerCase());

  useEffect(() => {
    if (!open) {
      setFilter("");
      setError(null);
    }
  }, [open]);

  const create = () => {
    const name = filter.trim();
    if (!name) return;
    start(async () => {
      const r = await createLabel({ name, color: "gray" });
      if (!r.ok || !r.label) {
        setError(r.ok ? t("createFailed") : r.error === "unavailable" ? t("unavailable") : t("createFailed"));
        return;
      }
      setCreated((c) => [...c, r.label!]);
      setFilter("");
      onToggle(r.label.id, true);
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={buttonClassName}
        aria-label={t("label")}
        title={t("label")}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <Tag size={17} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("label")}
          className={`pop absolute top-11 z-50 w-64 p-1.5 ${align === "right" ? "right-0" : "left-0"}`}
          style={{ transformOrigin: align === "right" ? "top right" : "top left" }}
        >
          <p className="px-3 pt-1.5 pb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">{t("labelAs")}</p>
          <input
            autoFocus
            value={filter}
            maxLength={60}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (shown.length === 1 && exact) onToggle(shown[0].id, stateOf(shown[0].id) !== "all");
                else if (!exact) create();
              }
            }}
            placeholder={t("searchOrCreate")}
            className="mx-1 mb-1 h-8 w-[calc(100%-8px)] rounded-md border border-line-strong bg-sheet px-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-mute focus:border-ink"
          />
          <div className="max-h-64 overflow-y-auto">
            {shown.map((l) => (
              <LabelOption key={l.id} label={l} state={stateOf(l.id)} onChange={(on) => onToggle(l.id, on)} />
            ))}
            {!all.length && !filter && <p className="px-3 py-2 text-[13px] text-ink-mute">{t("none")}</p>}
          </div>
          {filter.trim() && !exact && (
            <button
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={create}
              className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-3 py-2 text-left text-[13.5px] text-ink transition-colors hover:bg-hover disabled:opacity-60"
            >
              <Plus size={14} aria-hidden className="text-ink-mute" />
              <span className="truncate">{t("create", { name: filter.trim() })}</span>
            </button>
          )}
          {error && (
            <p role="alert" className="px-3 py-1.5 text-[12.5px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LabelOption({ label, state, onChange }: { label: Label; state: "all" | "some" | "none"; onChange: (on: boolean) => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = state === "some";
  }, [state]);
  return (
    <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink">
      <input
        ref={box}
        type="checkbox"
        role="menuitemcheckbox"
        aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
        className="h-4 w-4 cursor-pointer accent-primary"
        checked={state === "all"}
        onChange={() => onChange(state !== "all")}
      />
      <LabelDot color={label.color} />
      <span className="truncate">{label.name}</span>
    </label>
  );
}
