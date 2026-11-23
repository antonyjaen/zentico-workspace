"use client";

import { PhoneOff, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useMeeting } from "./MeetingProvider";
import { PreJoin } from "./PreJoin";
import { voiceChannelOf } from "../chat/shared";
import { meetHref } from "./shared";

const BTN_PRIMARY =
  "inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-ink transition-colors hover:bg-primary-hover";
const BTN_SECONDARY =
  "inline-flex h-10 items-center rounded-lg border border-line px-4 text-[14px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:bg-hover hover:text-ink";

/** The /meet/<room> page: pre-join, the live call (owned by MeetingProvider), or how it ended. */
export function MeetRoom({
  room: roomName,
  name,
  email,
  videoRecording,
}: {
  room: string;
  name: string;
  email: string;
  /** Whether "Video + transcript" recording (LiveKit egress) is available. */
  videoRecording: boolean;
}) {
  const t = useTranslations("meet");
  const meeting = useMeeting();
  const { call, ended } = meeting;
  const router = useRouter();
  // A voice channel's room ("vc-<id>") lives in Chat, not here: open the channel there.
  const vc = voiceChannelOf(roomName);
  useEffect(() => {
    if (vc) router.replace(`/chat?c=${encodeURIComponent(vc)}`);
  }, [vc, router]);
  if (vc) return null;

  if (call?.roomName === roomName) return <CallSlot />;

  if (call) {
    return (
      <Centered icon={<Video size={24} aria-hidden />} message={t("inOtherCall", { room: call.roomName })}>
        <Link href={call.kind === "voice" ? `/chat?c=${voiceChannelOf(call.roomName)}` : meetHref(call.roomName)} className={BTN_PRIMARY}>
          {t("returnToCall")}
        </Link>
        <button type="button" onClick={meeting.leave} className={BTN_SECONDARY}>
          {t("switchCall")}
        </button>
      </Centered>
    );
  }

  if (ended?.roomName === roomName) {
    const message = {
      self: t("leftSelf"),
      duplicate: t("leftDuplicate"),
      ended: t("leftEnded"),
      lost: t("leftLost"),
    }[ended.reason];
    return (
      <Centered icon={<PhoneOff size={24} aria-hidden />} message={message}>
        <button type="button" onClick={meeting.dismissEnded} className={BTN_PRIMARY}>
          {t("rejoin")}
        </button>
        <Link href="/meet" onClick={meeting.dismissEnded} className={BTN_SECONDARY}>
          {t("backToMeet")}
        </Link>
      </Centered>
    );
  }

  return (
    <PreJoin
      room={roomName}
      name={name}
      email={email}
      joining={meeting.joiningRoom === roomName}
      error={meeting.error?.roomName === roomName ? meeting.error.message : null}
      onJoin={(settings) => void meeting.join(roomName, settings, videoRecording)}
    />
  );
}

/** Where the provider's call view is shown while this page is open. */
function CallSlot() {
  const { attachSlot } = useMeeting();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? attachSlot(ref.current) : undefined), [attachSlot]);
  return <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col" />;
}

function Centered({ icon, message, children }: { icon: React.ReactNode; message: string; children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center p-10 text-center">
      <div className="rise max-w-sm">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-line bg-sheet-muted text-ink-soft">
          {icon}
        </span>
        <p className="mt-6 text-[17px] font-medium text-ink">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </div>
  );
}
