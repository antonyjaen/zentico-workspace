"use client";

import { CalendarCheck, Hash, Lock, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { addTeamPeople, createChannel, createTeam, getTeamMembers, renameTeam, scheduleMeeting, startChat } from "./actions";
import { NAME_MAX, type ChatMessage, type ChatUser, type ConversationDetail, type Person, type TeamSummary } from "./shared";
import { appsAsPeople, Avatar, BTN, BTN_MEET, BTN_PRIMARY, FIELD, Label, Modal, PeoplePicker, useApps, usePeople, useErrorText, useUserName } from "./ui";

function useSubmit() {
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (data: T) => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.ok) done(r.data);
      else setError(errorText(r.error));
    } catch {
      setError(errorText("failed"));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-3 text-[12.5px] text-danger">
      {error}
    </p>
  ) : null;
}

export function NewChatDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("chat");
  const ta = useTranslations("apps");
  const directory = usePeople();
  const apps = useApps();
  const userName = useUserName();
  // Apps can be DM'd or added to the new group too.
  const people = useMemo(() => (directory ? [...(appsAsPeople(apps, userName) ?? []), ...directory] : null), [directory, apps, userName]);
  const [picked, setPicked] = useState<Person[]>([]);
  const [name, setName] = useState("");
  const { busy, error, submit } = useSubmit();
  const group = picked.length > 1;

  const go = () => submit(() => startChat(picked, group && name.trim() ? name.trim() : null), onCreated);

  return (
    <Modal
      title={t("newChat")}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN}>
            {t("cancel")}
          </button>
          <button type="button" onClick={go} disabled={busy || picked.length === 0} className={BTN_PRIMARY}>
            {group ? t("createGroup") : t("startChat")}
          </button>
        </>
      }
    >
      <Label>{t("to")}</Label>
      <PeoplePicker value={picked} onChange={setPicked} people={people} autoFocus placeholder={ta("searchPeopleOrApps")} />
      {group && (
        <div className="mt-4">
          <Label htmlFor="group-name">{t("groupNameOptional")}</Label>
          <input
            id="group-name"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            placeholder={t("groupNamePlaceholder")}
            className={FIELD}
          />
        </div>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-ink-mute">{group ? t("groupHint") : t("dmHint")}</p>
      <ErrorLine error={error} />
    </Modal>
  );
}

export function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (channelId: string) => void }) {
  const t = useTranslations("chat");
  const people = usePeople();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Person[]>([]);
  const { busy, error, submit } = useSubmit();

  return (
    <Modal
      title={t("newTeam")}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN}>
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => submit(() => createTeam(name, description, picked, t("generalChannel")), onCreated)}
            className={BTN_PRIMARY}
          >
            {t("createTeam")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="team-name">{t("teamName")}</Label>
          <input id="team-name" autoFocus value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder={t("teamNamePlaceholder")} />
        </div>
        <div>
          <Label htmlFor="team-desc">{t("descriptionOptional")}</Label>
          <textarea id="team-desc" value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} className={`${FIELD} h-auto py-1.5`} />
        </div>
        <div>
          <Label>{t("members")}</Label>
          <PeoplePicker value={picked} onChange={setPicked} people={people} placeholder={t("searchPeople")} />
          <p className="mt-2 text-[12px] text-ink-mute">{t("teamHint")}</p>
        </div>
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}

export function RenameTeamDialog({ team, onClose, onSaved }: { team: TeamSummary; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("chat");
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description);
  const { busy, error, submit } = useSubmit();
  const save = () => {
    if (!name.trim()) return;
    void submit(() => renameTeam(team.id, name, description), onSaved);
  };

  return (
    <Modal
      title={t("renameTeam")}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN}>
            {t("cancel")}
          </button>
          <button type="button" disabled={busy || !name.trim()} onClick={save} className={BTN_PRIMARY}>
            {t("save")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="team-rename">{t("teamName")}</Label>
          <input
            id="team-rename"
            autoFocus
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className={FIELD}
            placeholder={t("teamNamePlaceholder")}
          />
        </div>
        <div>
          <Label htmlFor="team-rename-desc">{t("descriptionOptional")}</Label>
          <textarea
            id="team-rename-desc"
            value={description}
            maxLength={500}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            className={`${FIELD} h-auto py-1.5`}
          />
        </div>
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}

export function TeamMembersDialog({ team, onClose, onChanged }: { team: TeamSummary; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("chat");
  const people = usePeople();
  const [members, setMembers] = useState<(ChatUser & { role: "owner" | "member" })[] | null>(null);
  const [picked, setPicked] = useState<Person[]>([]);
  const { busy, error, submit } = useSubmit();
  const owner = team.role === "owner";

  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);
  useEffect(() => {
    getTeamMembers(team.id).then((r) => setMembers(r.ok ? r.data : []));
  }, [team.id, version]);

  const emails = useMemo(() => new Set((members ?? []).map((m) => m.email)), [members]);
  const candidates = people ? people.filter((p) => !emails.has(p.email)) : null;

  return (
    <Modal title={t("teamMembersTitle", { name: team.name })} onClose={onClose}>
      {owner && (
        <div className="mb-4">
          <Label>{t("addPeople")}</Label>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <PeoplePicker value={picked} onChange={setPicked} people={candidates} autoFocus placeholder={t("searchPeople")} />
            </div>
            <button
              type="button"
              disabled={busy || picked.length === 0}
              onClick={() =>
                submit(
                  () => addTeamPeople(team.id, picked),
                  () => {
                    setPicked([]);
                    load();
                    onChanged();
                  },
                )
              }
              className={`${BTN_PRIMARY} h-9`}
            >
              {t("add")}
            </button>
          </div>
          <ErrorLine error={error} />
        </div>
      )}
      {members === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-hover" />
          ))}
        </div>
      ) : (
        <ul className="space-y-0.5">
          {members.map((u) => (
            <li key={u.id} className="flex items-center gap-2.5 rounded-md px-1 py-1.5">
              <Avatar name={u.name} email={u.email} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-ink">{u.name}</span>
                <span className="block truncate text-[12px] text-ink-mute">{u.email}</span>
              </span>
              {u.role === "owner" && <span className="shrink-0 rounded border border-line px-1.5 py-px text-[10.5px] text-ink-mute">{t("owner")}</span>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function CreateChannelDialog({ team, onClose, onCreated }: { team: TeamSummary; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("chat");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [members, setMembers] = useState<ChatUser[] | null>(null);
  const [picked, setPicked] = useState<Person[]>([]);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    getTeamMembers(team.id).then((r) => setMembers(r.ok ? r.data : []));
  }, [team.id]);

  const candidates = members ? members.map((u) => ({ email: u.email, name: u.name })) : null;
  const ids = (members ?? []).filter((u) => picked.some((p) => p.email === u.email)).map((u) => u.id);

  return (
    <Modal
      title={t("newChannelIn", { team: team.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN}>
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => submit(() => createChannel(team.id, name, description, isPrivate, isPrivate ? ids : []), onCreated)}
            className={BTN_PRIMARY}
          >
            {t("createChannel")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="channel-name">{t("channelName")}</Label>
          <input id="channel-name" autoFocus value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder={t("channelNamePlaceholder")} />
        </div>
        <div>
          <Label htmlFor="channel-desc">{t("descriptionOptional")}</Label>
          <input id="channel-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} className={FIELD} />
        </div>
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="sr-only">{t("visibility")}</legend>
          {[false, true].map((p) => (
            <label
              key={String(p)}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${isPrivate === p ? "border-ink-mute bg-hover" : "border-line hover:border-line-strong"}`}
            >
              <input type="radio" name="visibility" checked={isPrivate === p} onChange={() => setPrivate(p)} className="sr-only" />
              {p ? <Lock size={16} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden /> : <Hash size={16} className="mt-0.5 shrink-0 text-ink-soft" aria-hidden />}
              <span>
                <span className="block text-[13px] font-medium text-ink">{p ? t("private") : t("public")}</span>
                <span className="block text-[11.5px] leading-snug text-ink-mute">{p ? t("privateHint") : t("publicHint")}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {isPrivate && (
          <div>
            <Label>{t("members")}</Label>
            <PeoplePicker value={picked} onChange={setPicked} people={candidates} placeholder={t("searchTeamMembers")} />
          </div>
        )}
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}

const DURATIONS = [15, 30, 45, 60, 90, 120];
const pad = (n: number) => String(n).padStart(2, "0");

/** Next half hour from now, as local date + time strings. */
function nextSlot(): { date: string; time: string } {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export function ScheduleDialog({
  conversation,
  me,
  onClose,
  onScheduled,
}: {
  conversation: ConversationDetail;
  me: ChatUser;
  onClose: () => void;
  onScheduled: (m: ChatMessage) => void;
}) {
  const t = useTranslations("chat");
  const people = usePeople();
  const slot = useMemo(nextSlot, []);
  const [title, setTitle] = useState(
    conversation.kind === "dm" ? t("meetingWith", { name: conversation.name }) : conversation.kind === "channel" ? `#${conversation.name}` : conversation.name,
  );
  const [date, setDate] = useState(slot.date);
  const [time, setTime] = useState(slot.time);
  const [duration, setDuration] = useState(30);
  const [description, setDescription] = useState("");
  const [attendees, setAttendees] = useState<Person[]>(() =>
    conversation.members.filter((m) => m.id !== me.id).map((m) => ({ email: m.email, name: m.name })),
  );
  const { busy, error, submit } = useSubmit();
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const go = () =>
    submit(
      () => scheduleMeeting(conversation.id, { title, date, time, durationMin: duration, description, timeZone, attendees }),
      onScheduled,
    );

  return (
    <Modal
      title={t("scheduleTitle")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto hidden items-center gap-1.5 text-[12px] text-ink-mute sm:flex">
            <CalendarCheck size={13} aria-hidden />
            {t("scheduleFooter")}
          </span>
          <button type="button" onClick={onClose} className={BTN}>
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={go}
            disabled={busy || !title.trim() || !date || !time}
            className={BTN_MEET}
            style={{ background: "var(--color-app-meet)" }}
          >
            <Video size={14} aria-hidden />
            {busy ? t("scheduling") : t("scheduleAction")}
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div>
          <Label htmlFor="mt-title">{t("meetingTitle")}</Label>
          <input id="mt-title" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className={FIELD} required />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1.3fr_1fr_1fr]">
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="mt-date">{t("date")}</Label>
            <input id="mt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} required />
          </div>
          <div>
            <Label htmlFor="mt-time">{t("startTime")}</Label>
            <input id="mt-time" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} className={FIELD} required />
          </div>
          <div>
            <Label htmlFor="mt-duration">{t("duration")}</Label>
            <select id="mt-duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={FIELD}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? t("minutes", { count: d }) : t("hours", { count: d / 60 })}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-[11.5px] text-ink-mute">{t("timeZoneNote", { tz: timeZone })}</p>
        <div>
          <Label>{t("attendees")}</Label>
          <PeoplePicker value={attendees} onChange={setAttendees} people={people} allowFree placeholder={t("addAttendees")} />
        </div>
        <div>
          <Label htmlFor="mt-desc">{t("descriptionOptional")}</Label>
          <textarea id="mt-desc" value={description} maxLength={5000} rows={3} onChange={(e) => setDescription(e.target.value)} className={`${FIELD} h-auto py-1.5`} />
        </div>
        <button type="submit" hidden />
      </form>
      <ErrorLine error={error} />
    </Modal>
  );
}
