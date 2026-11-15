import { FileText } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { createDocument } from "./actions";
import { KIND_ICON, Notice } from "./ui";
import { collaboraUrl, docKind, recentDocuments, userFiles, type DocKind, type FileNode } from "@/lib/wopi";

const KINDS: DocKind[] = ["text", "spreadsheet", "presentation"];

function formatSize(bytes: number) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export default async function DocsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const t = await getTranslations("docs");
  const format = await getFormatter();

  if (!collaboraUrl()) {
    return (
      <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
        <Notice title={t("notConfigured")} hint={t("notConfiguredHint")} />
      </main>
    );
  }

  let docs: FileNode[] | null = null;
  try {
    const user = await userFiles();
    if (user) docs = await recentDocuments(user.client);
  } catch (e) {
    unstable_rethrow(e);
  }

  return (
    <main className="sheet flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
          <header className="rise">
            <h1 className="text-[24px] font-semibold tracking-tight text-ink">{t("title")}</h1>
            <p className="mt-1 text-[14px] text-ink-mute">{t("subtitle")}</p>
          </header>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {KINDS.map((kind) => {
              const Icon = KIND_ICON[kind];
              return (
                <form key={kind} action={createDocument}>
                  <input type="hidden" name="kind" value={kind} />
                  <button
                    type="submit"
                    disabled={!docs}
                    className="group flex w-full items-center gap-3 rounded-lg border border-line bg-sheet px-4 py-3.5 text-left transition-colors duration-150 hover:border-line-strong hover:bg-hover disabled:pointer-events-none disabled:opacity-60"
                  >
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-sheet-muted"
                      style={{ color: "var(--color-app-docs)" }}
                    >
                      <Icon size={18} aria-hidden />
                    </span>
                    <span className="text-[14px] font-medium text-ink">{t(`create.${kind}`)}</span>
                  </button>
                </form>
              );
            })}
          </div>

          {sp.error === "create" && (
            <p role="alert" className="mt-4 text-[13.5px] text-danger">
              {t("createFailed")}
            </p>
          )}

          <h2 className="mt-10 mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink-mute">
            {t("recent")}
          </h2>

          {!docs ? (
            <Notice title={t("unavailable")} hint={t("unavailableHint")} />
          ) : docs.length === 0 ? (
            <Notice icon={FileText} title={t("empty")} hint={t("emptyHint")} />
          ) : (
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="hidden grid-cols-[1fr_180px_90px] gap-4 border-b border-line bg-sheet-muted px-4 py-2 text-[12px] font-medium text-ink-mute sm:grid">
                <span>{t("name")}</span>
                <span>{t("modified")}</span>
                <span className="text-right">{t("size")}</span>
              </div>
              <ul>
                {docs.map((d) => {
                  const kind = docKind(d.name) ?? "text";
                  const Icon = KIND_ICON[kind];
                  const modified = d.modified ? new Date(d.modified) : null;
                  return (
                    <li key={d.id} className="border-b border-line last:border-b-0">
                      <Link
                        href={`/docs/edit/${encodeURIComponent(d.id)}`}
                        className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5 transition-colors hover:bg-hover sm:grid-cols-[1fr_180px_90px]"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <Icon size={17} aria-hidden className="shrink-0" style={{ color: "var(--color-app-docs)" }} />
                          <span className="truncate text-[14px] text-ink">{d.name}</span>
                          <span className="sr-only">{t(`kind.${kind}`)}</span>
                        </span>
                        <span className="text-[13px] text-ink-mute">
                          {modified && !Number.isNaN(modified.getTime())
                            ? format.dateTime(modified, { dateStyle: "medium", timeStyle: "short" })
                            : "—"}
                        </span>
                        <span className="hidden text-right font-mono text-[12px] tabular-nums text-ink-mute sm:block">
                          {formatSize(d.size)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
