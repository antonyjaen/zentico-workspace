"use client";

// Drive cards in messages: files/folders posted from Drive (meta.drive) and team links to Drive
// or Docs pasted in the text. Each viewer resolves them with their own rights (batched, cached).
import { Check, Download, ExternalLink, Link2, Loader2, Lock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "@/app/(apps)/drive/FileIcon";
import { formatSize } from "@/app/(apps)/drive/shared";
import { requestDriveAccess, resolveDriveCards } from "./drive-actions";
import { driveDownloadHref, driveLinksIn, driveOpenHref, type ChatMessage, type ChatUser, type DriveCardData, type DriveRef } from "./shared";
import { BTN, useErrorText } from "./ui";

type Target = { url: string } | { accountId: string | null; fileId: string };
const keyOf = (t: Target) => ("url" in t ? `u:${t.url}` : `r:${t.accountId ?? ""}:${t.fileId}`);

// Results per target, shared by every message on the page. "No access" answers expire quickly
// so a grant (or a request that got answered) shows up without a reload.
const NO_ACCESS_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<DriveCardData | null> }>();
let queue: { target: Target; resolve: (v: DriveCardData | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += 40) {
    const chunk = batch.slice(i, i + 40);
    resolveDriveCards(chunk.map((q) => q.target))
      .then((r) => chunk.forEach((q, j) => q.resolve(r.ok ? (r.data[j] ?? null) : null)))
      .catch(() => chunk.forEach((q) => q.resolve(null)));
  }
}

function resolveCard(target: Target): Promise<DriveCardData | null> {
  const key = keyOf(target);
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = new Promise<DriveCardData | null>((resolve) => {
    queue.push({ target, resolve });
    timer ??= setTimeout(flush, 25);
  });
  const entry = { at: Date.now(), value };
  cache.set(key, entry);
  value.then((v) => {
    // Failures retry on the next render; "no access" after a short while.
    if (v === null) cache.delete(key);
    else if (!v.ok) setTimeout(() => cache.get(key) === entry && cache.delete(key), NO_ACCESS_TTL_MS);
  });
  return value;
}

function useResolved(targets: Target[]): (DriveCardData | null | undefined)[] {
  const keys = targets.map(keyOf).join("\n");
  const [state, setState] = useState<{ keys: string; values: (DriveCardData | null | undefined)[] }>({ keys: "", values: [] });
  useEffect(() => {
    let live = true;
    const list = keys ? keys.split("\n") : [];
    if (!list.length) return;
    Promise.all(targets.map(resolveCard)).then((values) => live && setState({ keys, values }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` identifies `targets`
  }, [keys]);
  return state.keys === keys ? state.values : targets.map(() => undefined);
}

/** Drive cards of a message: posted Drive items, then unfurled links from the text. */
export function DriveCards({ m, me, canInteract }: { m: ChatMessage; me: ChatUser; canInteract: boolean }) {
  const refs = useMemo(() => m.meta?.drive ?? [], [m.meta]);
  const links = useMemo(
    () => (m.body ? driveLinksIn(m.body, typeof window === "undefined" ? undefined : window.location.host) : []),
    [m.body],
  );
  const targets = useMemo<Target[]>(
    () => [...refs.map((r) => ({ accountId: r.accountId, fileId: r.fileId })), ...links.map((url) => ({ url }))],
    [refs, links],
  );
  const resolved = useResolved(targets);
  if (!targets.length) return null;

  // A link to something already posted as a card in the same message isn't repeated.
  const seen = new Set(refs.map((r) => `${r.accountId}:${r.fileId}`));
  const canRequest = canInteract && !!m.author && m.author.id !== me.id;
  return (
    <div className="mt-1.5 space-y-1.5">
      {targets.map((target, i) => {
        const data = resolved[i];
        const stored = i < refs.length ? refs[i] : null;
        if (!stored) {
          // Link: nothing until resolved; unknown/failed links stay plain links.
          if (!data) return null;
          if (data.ok) {
            const k = `${data.ref.accountId}:${data.ref.fileId}`;
            if (seen.has(k)) return null;
            seen.add(k);
          }
        }
        const key = keyOf(target);
        if (data && !data.ok)
          return <NoAccessCard key={key} name={stored?.name ?? null} sender={m.author?.name ?? null} messageId={m.id} target={target} canRequest={canRequest} />;
        const ref = data?.ok ? data.ref : stored!;
        return <DriveFileCard key={key} driveRef={ref} mine={data?.ok ? data.mine : m.author?.id === me.id} />;
      })}
    </div>
  );
}

export function DriveFileCard({ driveRef, mine }: { driveRef: DriveRef; mine: boolean }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const open = driveOpenHref(driveRef);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${open}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  const owner = mine ? t("drive.ownerYou") : (driveRef.owner ?? "");
  const item = { name: driveRef.name, isFolder: driveRef.isFolder, type: driveRef.mediaType };
  return (
    <div className="max-w-md overflow-hidden rounded-lg border border-line">
      <a href={open} target="_blank" rel="noopener" className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-hover">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-sheet-muted">
          <FileIcon item={item} size={19} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink" title={driveRef.name}>
            {driveRef.name}
          </span>
          <span className="block truncate text-[12px] text-ink-mute">
            {driveRef.isFolder ? t("drive.folder") : formatSize(driveRef.size, locale)}
            {owner && ` · ${t("drive.owner", { name: owner })}`}
          </span>
        </span>
      </a>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-sheet-muted px-3 py-2">
        <a href={open} target="_blank" rel="noopener" className={BTN}>
          <ExternalLink size={13} aria-hidden />
          {t("drive.open")}
        </a>
        {!driveRef.isFolder && (
          <a href={driveDownloadHref(driveRef)} download={driveRef.name} className={BTN}>
            <Download size={13} aria-hidden />
            {t("download")}
          </a>
        )}
        <button type="button" onClick={copy} className={BTN} aria-live="polite">
          {copied ? <Check size={13} aria-hidden /> : <Link2 size={13} aria-hidden />}
          {copied ? t("drive.copied") : t("drive.copyLink")}
        </button>
      </div>
    </div>
  );
}

function NoAccessCard({
  name,
  sender,
  messageId,
  target,
  canRequest,
}: {
  name: string | null;
  sender: string | null;
  messageId: number;
  target: Target;
  canRequest: boolean;
}) {
  const t = useTranslations("chat");
  const errorText = useErrorText();
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    setState("busy");
    setError(null);
    const r = await requestDriveAccess(messageId, target).catch(() => ({ ok: false as const, error: "failed" }));
    if (r.ok) setState("sent");
    else {
      setState("idle");
      setError(errorText(r.error));
    }
  };
  return (
    <div className="max-w-md overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-sheet-muted text-ink-mute">
          <Lock size={17} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink">{name ?? t("drive.noAccessTitle")}</span>
          <span className="block text-[12px] text-ink-mute">{t("drive.noAccessHint")}</span>
        </span>
      </div>
      {canRequest && (
        <div className="flex items-center gap-2 border-t border-line bg-sheet-muted px-3 py-2">
          {state === "sent" ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-soft">
              <Check size={13} aria-hidden />
              {t("drive.requestSent", { name: sender ?? t("someone") })}
            </span>
          ) : (
            <button type="button" onClick={request} disabled={state === "busy"} className={BTN}>
              {state === "busy" && <Loader2 size={13} className="animate-spin" aria-hidden />}
              {t("drive.requestAccess")}
            </button>
          )}
          {error && <span className="text-[12px] text-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}
