"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Density, ReadingPane } from "@/lib/mail-settings";
import { setDisplayPrefs, type ActionResult } from "./actions";
import { Status } from "./ui";

export function DisplayForm({ density, pane }: { density: Density; pane: ReadingPane }) {
  const t = useTranslations("mailSettings.display");
  const router = useRouter();
  const [, start] = useTransition();
  const [prefs, setPrefs] = useState({ density, pane });
  const [result, setResult] = useState<ActionResult | null>(null);

  const change = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    start(async () => {
      const r = await setDisplayPrefs(next);
      setResult(r);
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="space-y-8">
      <Choice
        title={t("density")}
        hint={t("densityHint")}
        name="density"
        value={prefs.density}
        options={[
          { value: "comfortable", label: t("comfortable"), preview: <Lines gap={7} /> },
          { value: "compact", label: t("compact"), preview: <Lines gap={3} /> },
        ]}
        onChange={(v) => change({ density: v as Density })}
      />
      <Choice
        title={t("pane")}
        hint={t("paneHint")}
        name="pane"
        value={prefs.pane}
        options={[
          { value: "none", label: t("paneNone"), preview: <Lines gap={5} /> },
          { value: "right", label: t("paneRight"), preview: <Lines gap={5} split /> },
        ]}
        onChange={(v) => change({ pane: v as ReadingPane })}
      />
      <Status result={result} />
    </div>
  );
}

function Choice({
  title,
  hint,
  name,
  value,
  options,
  onChange,
}: {
  title: string;
  hint: string;
  name: string;
  value: string;
  options: { value: string; label: string; preview: React.ReactNode }[];
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="text-[14px] font-medium text-ink">{title}</legend>
      <p className="mt-0.5 mb-3 text-[13px] text-ink-mute">{hint}</p>
      <div className="grid max-w-md grid-cols-2 gap-3">
        {options.map((o) => (
          <label
            key={o.value}
            className="cursor-pointer rounded-lg border border-line p-3 transition-colors hover:bg-hover has-[:checked]:border-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span className="mb-2.5 block h-14 overflow-hidden rounded-md border border-line bg-sheet-muted p-2">
              {o.preview}
            </span>
            <span className="text-[13px] font-medium text-ink">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Lines({ gap, split = false }: { gap: number; split?: boolean }) {
  return (
    <span className="flex h-full gap-2" aria-hidden>
      <span className="flex flex-1 flex-col" style={{ gap }}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="block h-[3px] shrink-0 rounded-full bg-line-strong" />
        ))}
      </span>
      {split && <span className="block w-2/5 rounded-sm border border-line-strong" />}
    </span>
  );
}
