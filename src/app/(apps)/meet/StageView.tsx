"use client";

// The call's live stage: whiteboards and pinned cards everyone in the call sees and edits, plus the
// controls of the proactive assistant (who runs it, Pause, Undo agent changes). Data and transport
// live in useStage; whiteboards in LiveCanvas.
import {
  Check,
  CheckSquare,
  Gavel,
  ListChecks,
  ListOrdered,
  Loader2,
  Pause,
  PenLine,
  Play,
  Plus,
  Save,
  Shapes,
  Sparkles,
  Square,
  StickyNote,
  Table2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppTheme } from "@/app/(apps)/mail/[mailboxId]/t/[threadId]/MessageFrame";
import { useAgentName } from "@/components/AgentNameProvider";
import { usePopover } from "@/components/usePopover";
import { ASSIST_MODES, STAGE_LIMITS, type AssistMode, type ListEntry, type StageElement, type StageItem, type StageKind, type StageOp } from "./stage-types";
import { StageRequestError, type Stage } from "./useStage";

const LiveCanvas = dynamic(() => import("./LiveCanvas"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-ink-mute">
      <Loader2 size={20} className="animate-spin" aria-hidden />
    </div>
  ),
});

const ICONS: Record<StageKind, typeof Shapes> = {
  board: Shapes,
  notes: StickyNote,
  decisions: Gavel,
  actions: ListChecks,
  agenda: ListOrdered,
  checklist: CheckSquare,
  table: Table2,
};

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export function StageView({
  stage,
  me,
  bridgeConnected,
  onStartListening,
  flash,
  compact,
}: {
  stage: Stage;
  me: string;
  /** The local user's agent bridge is connected (needed to start the assistant). */
  bridgeConnected: boolean;
  /** Turns on "listen to the meeting" (the assistant works from the meeting's speech). */
  onStartListening: () => void;
  flash: (msg: string) => void;
  /** Phone layout: whiteboards are view-only until Edit. */
  compact: boolean;
}) {
  const t = useTranslations("meet");
  const { data, send, assist, save, agentCursor } = stage;
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The item this user just removed for everyone, offered back for a few seconds. */
  const [removed, setRemoved] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!removed) return;
    const id = setTimeout(() => setRemoved(null), 8000);
    return () => clearTimeout(id);
  }, [removed]);
  const addMenu = usePopover<HTMLDivElement>();

  // Follow the shared focus (and newly added items) unless the user picked another tab since.
  const focus = data.focus;
  useEffect(() => {
    if (focus) setSelected(focus);
  }, [focus]);
  const current = data.items.find((i) => i.id === selected) ?? data.items.find((i) => i.id === focus) ?? data.items[0] ?? null;

  const fail = (e: unknown) => flash(e instanceof StageRequestError && e.message ? e.message : t("stageFailed"));
  const run = (ops: Parameters<Stage["send"]>[0]) => send(ops).catch(fail);

  const add = (kind: StageKind) => {
    addMenu.setOpen(false);
    const id = newId();
    const data =
      kind === "notes" ? { markdown: "" } : kind === "table" ? { columns: ["", ""], rows: [["", ""]] } : kind === "board" ? {} : { entries: [] };
    void send([
      { op: "item.add", item: { id, kind, title: t(`stageKind_${kind}`), data } },
      { op: "focus", id },
    ])
      .then(() => setSelected(id))
      .catch(fail);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const out = await save();
      flash(t("stageSaved", { count: out.sharedWith }));
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const agentItems = data.items.some((i) => i.actorKind === "agent");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-sheet,12px)] border border-line bg-sheet">
      <AssistBar stage={stage} me={me} bridgeConnected={bridgeConnected} onStartListening={onStartListening} fail={fail} showUndo={agentItems} />
      {agentCursor && Date.now() - agentCursor.at < 4000 && <DrawingNotice name={agentCursor.name} at={agentCursor.at} />}
      {removed && (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b border-line bg-sheet-muted px-3 py-1.5 text-[12.5px] text-ink-soft">
          <span className="min-w-0 flex-1 truncate">{t("stageRemovedFor", { title: removed.title })}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-ink underline-offset-2 hover:underline"
            onClick={() => {
              const id = removed.id;
              setRemoved(null);
              void send([{ op: "item.restore", id }])
                .then(() => setSelected(id))
                .catch(fail);
            }}
          >
            <Undo2 size={12} aria-hidden />
            {t("stageUndoRemove")}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <div role="tablist" aria-label={t("stage")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {data.items.map((item) => {
            const Icon = ICONS[item.kind];
            const active = current?.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelected(item.id)}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors ${
                  active ? "bg-primary-soft text-ink" : "text-ink-soft hover:bg-hover hover:text-ink"
                }`}
                title={item.actorKind === "agent" ? t("stageByAgent") : undefined}
              >
                <Icon size={14} aria-hidden />
                <span className="max-w-[160px] truncate">{item.title || t(`stageKind_${item.kind}`)}</span>
                {item.actorKind === "agent" && <Sparkles size={11} aria-hidden className="text-ink-mute" />}
              </button>
            );
          })}
        </div>
        <div ref={addMenu.ref} className="relative">
          <button type="button" className="icon-btn" onClick={addMenu.toggle} aria-haspopup="menu" aria-expanded={addMenu.open} aria-label={t("stageAdd")} title={t("stageAdd")}>
            <Plus size={16} aria-hidden />
          </button>
          {addMenu.open && (
            <div role="menu" className="pop absolute top-full right-0 z-20 mt-1 w-52 p-1">
              {(["board", "notes", "decisions", "actions", "agenda", "checklist", "table"] as const).map((k) => {
                const Icon = ICONS[k];
                return (
                  <button
                    key={k}
                    type="button"
                    role="menuitem"
                    onClick={() => add(k)}
                    className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] text-ink-soft hover:bg-hover hover:text-ink"
                  >
                    <Icon size={15} aria-hidden />
                    {t(`stageKind_${k}`)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={() => void doSave()} disabled={saving || !data.items.length} aria-label={t("stageSave")} title={t("stageSaveHint")}>
          {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Save size={16} aria-hidden />}
        </button>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {!data.loaded ? (
          <div className="grid h-full place-items-center text-ink-mute">
            <Loader2 size={20} className="animate-spin" aria-hidden />
          </div>
        ) : !current ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Shapes size={28} aria-hidden className="text-ink-mute" />
            <p className="max-w-sm text-[13.5px] leading-relaxed text-ink-soft">{t("stageEmpty")}</p>
            <button type="button" onClick={() => add("board")} className="btn-secondary h-9 rounded-full border border-line px-4 text-[13px] font-medium text-ink hover:bg-hover">
              {t("stageNewBoard")}
            </button>
          </div>
        ) : (
          <ItemView
            key={current.id}
            item={current}
            stage={stage}
            run={run}
            compact={compact}
            isFocus={focus === current.id}
            fail={fail}
            onRemoved={() => setRemoved({ id: current.id, title: current.title || t(`stageKind_${current.kind}`) })}
          />
        )}
      </div>
    </div>
  );
}

function DrawingNotice({ name, at }: { name: string; at: number }) {
  const t = useTranslations("meet");
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => tick((n) => n + 1), Math.max(0, 4000 - (Date.now() - at)));
    return () => clearTimeout(id);
  }, [at]);
  if (Date.now() - at >= 4000) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-sheet-muted px-3 py-1.5 text-[12.5px] text-ink-soft">
      <PenLine size={13} aria-hidden className="animate-pulse" style={{ color: "var(--color-app-meet)" }} />
      {t("stageAgentDrawing", { name })}
    </div>
  );
}

function AssistBar({
  stage,
  me,
  bridgeConnected,
  onStartListening,
  fail,
  showUndo,
}: {
  stage: Stage;
  me: string;
  bridgeConnected: boolean;
  onStartListening: () => void;
  fail: (e: unknown) => void;
  showUndo: boolean;
}) {
  const t = useTranslations("meet");
  const myAgent = useAgentName();
  const a = stage.data.assist;
  const [choosing, setChoosing] = useState(false);
  const [modes, setModes] = useState<AssistMode[]>(["notes", "decisions", "actions"]);
  const [busy, setBusy] = useState(false);
  const mine = !!a && a.owner === me.toLowerCase();

  const act = async (action: "start" | "pause" | "resume" | "stop") => {
    setBusy(true);
    try {
      await stage.assist(action, action === "start" ? modes : undefined);
      if (action === "start" || action === "resume") onStartListening();
      setChoosing(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const undo = () => void stage.send([{ op: "undoAgent" }]).catch(fail);

  const link = "inline-flex items-center gap-1 font-medium text-ink underline-offset-2 hover:underline disabled:opacity-50";

  if (!a) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-[12.5px] text-ink-soft">
        {choosing ? (
          <>
            <span className="text-ink">{t("stageAssistModes")}</span>
            {ASSIST_MODES.map((m) => (
              <label key={m} className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--color-app-meet)]"
                  checked={modes.includes(m)}
                  onChange={(e) => setModes((cur) => (e.target.checked ? [...cur, m] : cur.filter((x) => x !== m)))}
                />
                {t(`stageMode_${m}`)}
              </label>
            ))}
            <button type="button" className={link} disabled={busy || !modes.length} onClick={() => void act("start")}>
              <Play size={12} aria-hidden />
              {t("stageAssistStart")}
            </button>
            <button type="button" className={link} onClick={() => setChoosing(false)}>
              {t("cancel")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={link} disabled={!bridgeConnected} onClick={() => setChoosing(true)} title={bridgeConnected ? undefined : t("stageAssistNeedsBridge")}>
              <Sparkles size={13} aria-hidden style={{ color: "var(--color-app-meet)" }} />
              {t("stageAssistOffer")}
            </button>
            {!bridgeConnected && <span className="text-ink-mute">{t("stageAssistNeedsBridge")}</span>}
            {showUndo && (
              <button type="button" className={`${link} ml-auto`} onClick={undo}>
                <Undo2 size={12} aria-hidden />
                {t("stageUndoAgent")}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sheet-muted px-3 py-1.5 text-[12.5px] text-ink-soft">
      <span className="flex items-center gap-1.5 text-ink">
        {a.running ? (
          <Loader2 size={13} aria-hidden className="animate-spin" style={{ color: "var(--color-app-meet)" }} />
        ) : (
          <Sparkles size={13} aria-hidden style={{ color: "var(--color-app-meet)" }} />
        )}
        {a.pausedBy
          ? t("stageAssistPaused", { name: a.pausedByName ?? a.pausedBy })
          : mine
            ? t("stageAssistMine", { assistant: myAgent })
            : t("stageAssistBy", { name: a.ownerName, assistant: a.agent })}
      </span>
      {a.running && !a.pausedBy && <span className="text-ink-mute">{t("stageAssistUpdating", { assistant: mine ? myAgent : a.agent })}</span>}
      {a.pausedBy ? (
        mine && (
          <button type="button" className={link} disabled={busy} onClick={() => void act("resume")}>
            <Play size={12} aria-hidden />
            {t("stageAssistResume")}
          </button>
        )
      ) : (
        <button type="button" className={link} disabled={busy} onClick={() => void act("pause")}>
          <Pause size={12} aria-hidden />
          {t("stageAssistPause")}
        </button>
      )}
      {mine && (
        <button type="button" className={link} disabled={busy} onClick={() => void act("stop")}>
          <Square size={11} aria-hidden />
          {t("stageAssistStop")}
        </button>
      )}
      <button type="button" className={`${link} ml-auto`} onClick={undo}>
        <Undo2 size={12} aria-hidden />
        {t("stageUndoAgent")}
      </button>
    </div>
  );
}

function ItemView({
  item,
  stage,
  run,
  compact,
  isFocus,
  fail,
  onRemoved,
}: {
  item: StageItem;
  stage: Stage;
  run: (ops: Parameters<Stage["send"]>[0]) => Promise<unknown>;
  compact: boolean;
  isFocus: boolean;
  fail: (e: unknown) => void;
  onRemoved: () => void;
}) {
  const t = useTranslations("meet");
  const locale = useLocale();
  const theme = useAppTheme() ?? "light";
  const [editing, setEditing] = useState(!compact);

  const remove = () => {
    // Removing is for everyone in the call: ask first unless the item is empty.
    const d = item.data;
    const empty =
      item.kind === "board"
        ? ![...(stage.data.boards[item.id]?.values() ?? [])].some((e) => !e.isDeleted)
        : item.kind === "notes"
          ? !String(d.markdown ?? "").trim()
          : item.kind === "table"
            ? !(Array.isArray(d.rows) ? (d.rows as unknown[][]) : []).some((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim())) &&
              !(Array.isArray(d.columns) ? (d.columns as unknown[]) : []).some((c) => String(c ?? "").trim())
            : !(Array.isArray(d.entries) && d.entries.length);
    if (!empty && !window.confirm(t("stageRemoveConfirm", { title: item.title || t(`stageKind_${item.kind}`) }))) return;
    // run() reports a failure itself and resolves to nothing.
    void run([{ op: "item.remove", id: item.id }]).then((out) => out && onRemoved());
  };

  const header = (
    <div className="flex shrink-0 items-center gap-2 px-3 pt-2 text-[12px] text-ink-mute">
      <span className="min-w-0 flex-1 truncate">{item.actorKind === "agent" ? t("stageByAgent") : null}</span>
      {!isFocus && (
        <button type="button" className="font-medium text-ink-soft hover:text-ink" onClick={() => void run([{ op: "focus", id: item.id }])}>
          {t("stageShowEveryone")}
        </button>
      )}
      {item.kind === "board" && compact && (
        <button type="button" className="font-medium text-ink-soft hover:text-ink" onClick={() => setEditing((e) => !e)}>
          {editing ? t("stageDoneEditing") : t("stageEdit")}
        </button>
      )}
      <button type="button" className="icon-btn !h-7 !w-7" onClick={remove} aria-label={t("stageRemove")} title={t("stageRemove")}>
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  );

  if (item.kind === "board") {
    const elements = stage.data.boards[item.id] ?? EMPTY_BOARD;
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            <LiveCanvas
              elements={elements}
              theme={theme}
              langCode={locale.startsWith("es") ? "es-ES" : "en"}
              viewMode={!editing}
              agentCursor={stage.agentCursor?.board === item.id ? stage.agentCursor : null}
              onSend={(changed) => stage.send([{ op: "el.upsert", board: item.id, elements: changed }])}
            />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {item.kind === "notes" ? (
          <NotesCard item={item} send={stage.send} fail={fail} />
        ) : item.kind === "table" ? (
          <TableCard item={item} run={run} />
        ) : (
          <ListCard item={item} run={run} />
        )}
      </div>
    </div>
  );
}

const EMPTY_BOARD = new Map<string, StageElement>();

function NotesCard({ item, send, fail }: { item: StageItem; send: Stage["send"]; fail: (e: unknown) => void }) {
  const t = useTranslations("meet");
  const text = String(item.data.markdown ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  /** The card's revision the draft started from: saving over a newer one is refused (conflict). */
  const [base, setBase] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = (over: number) => {
    setBusy(true);
    void send([{ op: "item.update", id: item.id, data: { markdown: draft ?? "" }, base: over }])
      .then(() => {
        setDraft(null);
        setConflict(false);
      })
      .catch((e: unknown) => {
        if (e instanceof StageRequestError && e.code === "conflict") setConflict(true);
        else fail(e);
      })
      .finally(() => setBusy(false));
  };
  return draft == null ? (
    <div>
      {text.trim() ? (
        <div className="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink">{text}</div>
      ) : (
        <p className="text-[13.5px] text-ink-mute">{t("stageNotesEmpty")}</p>
      )}
      <button
        type="button"
        className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-soft hover:text-ink"
        onClick={() => {
          setDraft(text);
          setBase(item.rev);
          setConflict(false);
        }}
      >
        <PenLine size={13} aria-hidden />
        {t("stageEdit")}
      </button>
    </div>
  ) : (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // After a conflict the user has seen the newer text above the editor: saving again replaces it.
        save(conflict ? item.rev : base);
      }}
      className="flex flex-col gap-2"
    >
      {conflict && (
        <div role="alert" className="rounded-lg border border-line bg-sheet-muted p-3 text-[13px] text-ink-soft">
          <p className="font-medium text-ink">{t("stageNotesConflict")}</p>
          <div className="mt-2 max-h-40 overflow-y-auto text-[13px] break-words whitespace-pre-wrap text-ink">{text.trim() || t("stageNotesEmpty")}</div>
        </div>
      )}
      <textarea
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
        maxLength={60_000}
        aria-label={t("stageKind_notes")}
        className="w-full resize-y rounded-lg border border-line bg-sheet-muted p-3 font-mono text-[13px] text-ink outline-none focus:border-ink-mute"
      />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary-soft px-3 text-[13px] font-medium text-ink disabled:opacity-50">
          <Check size={14} aria-hidden />
          {conflict ? t("stageNotesReplace") : t("stageDoneEditing")}
        </button>
        <button
          type="button"
          className="h-8 rounded-md px-3 text-[13px] text-ink-soft hover:bg-hover"
          onClick={() => {
            setDraft(null);
            setConflict(false);
          }}
        >
          {conflict ? t("stageNotesKeepTheirs") : t("cancel")}
        </button>
      </div>
    </form>
  );
}

function ListCard({ item, run }: { item: StageItem; run: (ops: Parameters<Stage["send"]>[0]) => Promise<unknown> }) {
  const t = useTranslations("meet");
  const entries = useMemo(() => (Array.isArray(item.data.entries) ? (item.data.entries as ListEntry[]) : []), [item.data.entries]);
  const current = typeof item.data.current === "string" ? item.data.current : null;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const checkable = item.kind !== "decisions";
  // Entry-level changes, applied by the server to the card as it is then: a concurrent change by
  // someone else (or the assistant appending) is never overwritten by this browser's older copy.
  const change = (op: Omit<Extract<StageOp, { op: "entries" }>, "op" | "id">) => run([{ op: "entries", id: item.id, ...op }]);

  return (
    <div>
      {entries.length === 0 && <p className="py-2 text-[13.5px] text-ink-mute">{t("stageListEmpty")}</p>}
      <ul className="flex flex-col">
        {entries.map((e, i) => (
          <li key={e.id} className={`group flex items-start gap-2.5 rounded-md px-1 py-1.5 ${current === e.id ? "bg-primary-soft" : ""}`}>
            {checkable ? (
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-app-meet)]"
                checked={!!e.done}
                aria-label={e.text}
                onChange={(ev) => void change({ set: [{ id: e.id, done: ev.target.checked }] })}
              />
            ) : (
              <span className="mt-0.5 w-5 shrink-0 text-right text-[12px] text-ink-mute tabular-nums">{i + 1}.</span>
            )}
            <span className="min-w-0 flex-1">
              <span className={`block text-[14px] leading-snug break-words ${e.done ? "text-ink-mute line-through" : "text-ink"}`}>{e.text}</span>
              {(e.assignee || e.due) && (
                <span className="block text-[12px] text-ink-mute">{[e.assignee, e.due && t("stageDue", { due: e.due })].filter(Boolean).join(" · ")}</span>
              )}
            </span>
            {item.kind === "agenda" && current !== e.id && (
              <button
                type="button"
                className="text-[12px] font-medium text-ink-soft hover:text-ink [@media(hover:hover)]:hidden [@media(hover:hover)]:group-focus-within:block [@media(hover:hover)]:group-hover:block"
                onClick={() => void change({ current: e.id })}
              >
                {t("stageAgendaNow")}
              </button>
            )}
            <button
              type="button"
              className="icon-btn !h-6 !w-6 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
              onClick={() => void change({ remove: [e.id] })}
              aria-label={t("stageRemoveEntry")}
            >
              <X size={13} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          const text = draft.trim();
          if (!text || entries.length >= STAGE_LIMITS.listEntries) return;
          setDraft("");
          void change({ add: [{ id: newId(), text }] });
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder={t("stageAddEntry")}
          aria-label={t("stageAddEntry")}
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-sheet-muted px-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-mute focus:border-ink-mute"
        />
        <button type="submit" className="icon-btn" disabled={!draft.trim()} aria-label={t("stageAddEntry")}>
          <Plus size={15} aria-hidden />
        </button>
      </form>
    </div>
  );
}

function TableCard({ item, run }: { item: StageItem; run: (ops: Parameters<Stage["send"]>[0]) => Promise<unknown> }) {
  const t = useTranslations("meet");
  const columns = (Array.isArray(item.data.columns) ? (item.data.columns as string[]) : []).slice(0, STAGE_LIMITS.tableCols);
  const rows = (Array.isArray(item.data.rows) ? (item.data.rows as string[][]) : []).slice(0, STAGE_LIMITS.tableRows);
  const width = Math.max(columns.length, ...rows.map((r) => r.length), 1);
  // Cell-level changes, applied by the server to the table as it is then (see ListCard).
  const commit = (op: Omit<Extract<StageOp, { op: "table" }>, "op" | "id">) => void run([{ op: "table", id: item.id, ...op }]);
  const cell = (value: string, onCommit: (v: string) => void, label: string, head = false) => (
    <input
      defaultValue={value}
      key={value}
      aria-label={label}
      maxLength={head ? 80 : 500}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`w-full min-w-[6rem] bg-transparent px-2 py-1.5 text-[13px] outline-none focus:bg-sheet-muted ${head ? "font-medium text-ink" : "text-ink-soft"}`}
    />
  );
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {pad(columns).map((c, i) => (
              <th key={i} className="p-0">
                {cell(c, (v) => commit({ header: [{ col: i, value: v }] }), t("stageColumn", { n: i + 1 }), true)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line/60">
              {pad(r).map((c, ci) => (
                <td key={ci} className="p-0">
                  {cell(c, (v) => commit({ cells: [{ row: ri, col: ci, value: v }] }), t("stageCell", { row: ri + 1, col: ci + 1 }))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex gap-3 text-[13px]">
        <button type="button" className="inline-flex items-center gap-1 font-medium text-ink-soft hover:text-ink disabled:opacity-50" disabled={rows.length >= STAGE_LIMITS.tableRows} onClick={() => commit({ addRow: true })}>
          <Plus size={13} aria-hidden />
          {t("stageAddRow")}
        </button>
        <button type="button" className="inline-flex items-center gap-1 font-medium text-ink-soft hover:text-ink disabled:opacity-50" disabled={width >= STAGE_LIMITS.tableCols} onClick={() => commit({ addColumn: true })}>
          <Plus size={13} aria-hidden />
          {t("stageAddColumn")}
        </button>
      </div>
    </div>
  );
}
