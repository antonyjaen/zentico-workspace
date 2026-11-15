"use client";

import { Loader2, Search, User, Users, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shareAction, sharingAction, type SharingData } from "./actions";
import { FileIcon } from "./FileIcon";
import type { Item, PrincipalOption, ShareRole } from "./shared";

const ROLES: ShareRole[] = ["viewer", "editor", "manager"];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Share a file or folder with people and groups (RFC 9670 shareWith grants). */
export function ShareDialog({ item, onClose, onChanged }: { item: Item; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("drive");
  const [data, setData] = useState<SharingData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PrincipalOption | null>(null);
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await sharingAction(item.id, item.accountId);
    if (r.ok) setData(r.data);
    else setFailed(true);
  }, [item.id, item.accountId]);

  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [load, onClose]);

  const granted = useMemo(() => new Set((data?.grants ?? []).map((g) => g.principalId)), [data]);
  const matches = useMemo(() => {
    if (!data?.principals || !query.trim() || picked) return [];
    const needle = fold(query.trim());
    return data.principals
      .filter((p) => !granted.has(p.id) && (fold(p.name).includes(needle) || (p.email && fold(p.email).includes(needle))))
      .slice(0, 8);
  }, [data, query, picked, granted]);

  const errorText = (code: string) =>
    t.has(`errors.${code}`) ? t(`errors.${code}` as "errors.failed") : t("errors.failed");

  const apply = async (principalId: string, next: ShareRole | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await shareAction(item.id, principalId, next, item.accountId);
      if (!r.ok) {
        setError(errorText(r.error));
        return false;
      }
      await load();
      onChanged();
      return true;
    } catch {
      setError(t("errors.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!picked) return;
    if (await apply(picked.id, role)) {
      setPicked(null);
      setQuery("");
      inputRef.current?.focus();
    }
  };

  const canShare = !!data?.canShare;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("share.title", { name: item.name })}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="pop flex max-h-[80dvh] w-full max-w-lg flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
          <FileIcon item={item} />
          <h2 className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">{t("share.title", { name: item.name })}</h2>
          <button type="button" onClick={onClose} className="icon-btn h-8 w-8" aria-label={t("close")}>
            <X size={16} aria-hidden />
          </button>
        </div>

        {failed ? (
          <p className="p-8 text-center text-[13.5px] text-danger">{t("errors.failed")}</p>
        ) : !data ? (
          <div className="grid h-48 place-items-center">
            <Loader2 size={20} className="animate-spin text-ink-mute" aria-label={t("loading")} />
          </div>
        ) : !data.supported ? (
          <div className="p-8 text-center">
            <p className="text-[14px] font-medium text-ink">{t("share.unavailable")}</p>
            <p className="mt-1.5 text-[13px] text-ink-mute">{t("share.unavailableHint")}</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {canShare && (
              <div className="border-b border-line p-4">
                {data.principals ? (
                  <div className="relative">
                    <div className="flex gap-2">
                      <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-sheet px-2.5 transition-colors focus-within:border-line-strong">
                        <Search size={15} className="shrink-0 text-ink-mute" aria-hidden />
                        <span className="sr-only">{t("share.addPeople")}</span>
                        {picked && (
                          <span className="flex max-w-[60%] shrink-0 items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-[12.5px] text-ink">
                            <span className="truncate">{picked.name}</span>
                            <button type="button" onClick={() => setPicked(null)} className="text-ink-mute hover:text-ink" aria-label={t("share.clearPick")}>
                              <X size={12} aria-hidden />
                            </button>
                          </span>
                        )}
                        <input
                          ref={inputRef}
                          autoFocus
                          value={picked ? "" : query}
                          onChange={(e) => (setPicked(null), setQuery(e.target.value))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (picked) void add();
                              else if (matches[0]) setPicked(matches[0]);
                            }
                          }}
                          placeholder={picked ? "" : t("share.addPeople")}
                          maxLength={200}
                          autoComplete="off"
                          role="combobox"
                          aria-expanded={matches.length > 0}
                          aria-controls="share-matches"
                          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-ink-mute focus:outline-none"
                        />
                      </label>
                      <RoleSelect value={role} onChange={setRole} disabled={busy} />
                      <button
                        type="button"
                        onClick={add}
                        disabled={!picked || busy}
                        className="h-9 shrink-0 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink hover:bg-primary-hover disabled:opacity-50"
                      >
                        {t("share.add")}
                      </button>
                    </div>
                    {matches.length > 0 && (
                      <ul id="share-matches" role="listbox" className="pop absolute top-full right-0 left-0 z-10 mt-1 max-h-64 overflow-y-auto p-1">
                        {matches.map((p) => (
                          <li key={p.id} role="option" aria-selected={false}>
                            <button
                              type="button"
                              onClick={() => (setPicked(p), inputRef.current?.focus())}
                              className="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-hover"
                            >
                              <PrincipalIcon type={p.type} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13.5px] text-ink">{p.name}</span>
                                {p.email && <span className="block truncate text-[12px] text-ink-mute">{p.email}</span>}
                              </span>
                              {p.type === "group" && <span className="shrink-0 text-[11.5px] text-ink-mute">{t("share.group")}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {query.trim() && !picked && matches.length === 0 && (
                      <p className="mt-2 text-[12.5px] text-ink-mute">{t("share.noMatches")}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-ink-mute">{t("share.noDirectory")}</p>
                )}
              </div>
            )}

            <div className="p-2">
              <p className="px-2 pt-2 pb-1 text-[12px] font-medium text-ink-mute">{t("share.withAccess")}</p>
              {data.grants.length === 0 ? (
                <p className="px-2 py-3 text-[13px] text-ink-mute">{t("share.notShared")}</p>
              ) : (
                <ul>
                  {data.grants.map((g) => (
                    <li key={g.principalId} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                      <PrincipalIcon type={g.type} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-ink">{g.name}</span>
                        {g.email && <span className="block truncate text-[12px] text-ink-mute">{g.email}</span>}
                      </span>
                      {canShare ? (
                        <>
                          <RoleSelect value={g.role} onChange={(r) => void apply(g.principalId, r)} disabled={busy} />
                          <button
                            type="button"
                            onClick={() => void apply(g.principalId, null)}
                            disabled={busy}
                            className="icon-btn h-8 w-8"
                            aria-label={t("share.remove", { name: g.name })}
                            title={t("share.remove", { name: g.name })}
                          >
                            <X size={14} aria-hidden />
                          </button>
                        </>
                      ) : (
                        <span className="text-[12.5px] text-ink-mute">{t(`share.${g.role}`)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          <span className="mr-auto min-w-0 truncate text-[12.5px]" role={error ? "alert" : undefined}>
            {error ? <span className="text-danger">{error}</span> : busy ? <Loader2 size={14} className="animate-spin text-ink-mute" aria-label={t("working")} /> : null}
          </span>
          <button type="button" onClick={onClose} className="h-8 rounded-md border border-line px-3 text-[13px] font-medium text-ink-soft hover:border-line-strong hover:bg-hover hover:text-ink">
            {t("done")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleSelect({ value, onChange, disabled }: { value: ShareRole; onChange: (r: ShareRole) => void; disabled?: boolean }) {
  const t = useTranslations("drive");
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ShareRole)}
      aria-label={t("share.role")}
      className="h-9 shrink-0 rounded-md border border-line bg-sheet px-2 text-[13px] text-ink-soft focus:border-line-strong focus:outline-none disabled:opacity-60"
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {t(`share.${r}`)}
        </option>
      ))}
    </select>
  );
}

function PrincipalIcon({ type }: { type: string }) {
  const Icon = type === "group" ? Users : User;
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sheet-muted text-ink-mute">
      <Icon size={15} aria-hidden />
    </span>
  );
}
