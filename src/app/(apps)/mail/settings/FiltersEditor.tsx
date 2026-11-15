"use client";

import { Plus, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FilterRule } from "@/lib/mail-settings";
import { saveFilters, type ActionResult } from "./actions";
import { Status, inputCls, primaryBtn, secondaryBtn } from "./ui";

type Row = FilterRule & { key: number };
type Folder = { id: string; label: string };

const FIELDS: FilterRule["field"][] = ["from", "to", "subject"];
const ACTIONS: FilterRule["action"][] = ["move", "markRead", "star", "delete", "forward"];
const MAX_RULES = 100;

const selectCls =
  "h-9 rounded-md border border-line-strong bg-sheet px-2 text-[14px] text-ink outline-none transition-colors focus:border-ink";

let seq = 0;

export function FiltersEditor({
  rules,
  folders,
  scriptName,
  active,
  otherActive,
  unreadable,
}: {
  rules: FilterRule[];
  folders: Folder[];
  scriptName: string;
  active: { name: string; content: string } | null;
  otherActive: boolean;
  unreadable: boolean;
}) {
  const t = useTranslations("mailSettings.filters");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [rows, setRows] = useState<Row[]>(() => rules.map((r) => ({ ...r, key: seq++ })));

  const update = (key: number, patch: Partial<FilterRule>) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if (patch.action) next.target = patch.action === "move" ? folders[0]?.id : patch.action === "forward" ? "" : undefined;
        return next;
      }),
    );

  const add = () =>
    setRows((rs) => [...rs, { key: seq++, field: "from", value: "", action: "move", target: folders[0]?.id }]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveFilters(rows.map(({ key: _key, ...rule }) => rule));
      setResult(r);
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {otherActive && active && (
        <Notice>{t("otherActive", { name: active.name, ours: scriptName })}</Notice>
      )}
      {unreadable && <Notice>{t("unreadable", { name: scriptName })}</Notice>}

      <form onSubmit={submit} className="space-y-4">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-mute">
            {t("empty")}
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li
                key={r.key}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-[14px] text-ink-soft"
              >
                <span className="w-6 font-mono text-[12px] tabular-nums text-ink-mute">{String(i + 1).padStart(2, "0")}</span>
                <span>{t("if")}</span>
                <select
                  aria-label={t("field")}
                  value={r.field}
                  onChange={(e) => update(r.key, { field: e.target.value as FilterRule["field"] })}
                  className={selectCls}
                >
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {t(`fields.${f}`)}
                    </option>
                  ))}
                </select>
                <span>{t("contains")}</span>
                <input
                  aria-label={t("value")}
                  required
                  maxLength={200}
                  value={r.value}
                  onChange={(e) => update(r.key, { value: e.target.value })}
                  className={`${inputCls} w-auto min-w-[140px] flex-1`}
                />
                <span>→</span>
                <select
                  aria-label={t("action")}
                  value={r.action}
                  onChange={(e) => update(r.key, { action: e.target.value as FilterRule["action"] })}
                  className={selectCls}
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a} disabled={a === "move" && folders.length === 0}>
                      {t(`actions.${a}`)}
                    </option>
                  ))}
                </select>
                {r.action === "move" && (
                  <select
                    aria-label={t("folder")}
                    required
                    value={r.target ?? ""}
                    onChange={(e) => update(r.key, { target: e.target.value })}
                    className={`${selectCls} max-w-[200px]`}
                  >
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                )}
                {r.action === "forward" && (
                  <input
                    type="email"
                    aria-label={t("forwardTo")}
                    placeholder={t("forwardTo")}
                    required
                    maxLength={254}
                    value={r.target ?? ""}
                    onChange={(e) => update(r.key, { target: e.target.value })}
                    className={`${inputCls} w-auto min-w-[180px]`}
                  />
                )}
                <button
                  type="button"
                  className="icon-btn ml-auto h-8 w-8"
                  aria-label={t("remove")}
                  title={t("remove")}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  <X size={15} aria-hidden />
                </button>
              </li>
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2.5 rounded-lg border border-line-strong px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
      <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0 text-amber" />
      <span>{children}</span>
    </p>
  );
}
