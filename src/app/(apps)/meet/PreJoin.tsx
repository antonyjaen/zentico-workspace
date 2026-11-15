"use client";

import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { ArrowLeft, Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Avatar, VideoView } from "./media";

export type JoinSettings = { audio: boolean; video: boolean; audioDeviceId?: string; videoDeviceId?: string };

/** Outcome of asking the browser for one kind of device. */
type Access = "pending" | "ok" | "denied" | "missing" | "busy" | "insecure" | "error";

function classify(e: unknown): Access {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "error";
}

async function probe(constraints: MediaStreamConstraints): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  stream.getTracks().forEach((t) => t.stop());
}

export const SELECT =
  "h-9 w-full min-w-0 truncate rounded-lg border border-line bg-sheet px-2.5 text-[13px] text-ink-soft outline-none transition-colors hover:border-line-strong focus:border-ink-mute disabled:opacity-50";

export function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    setDevices(list.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"));
  }, []);
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices) return;
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [enabled, refresh]);
  return {
    mics: devices.filter((d) => d.kind === "audioinput"),
    cams: devices.filter((d) => d.kind === "videoinput"),
    refresh,
  };
}

export function PreJoin({
  room,
  name,
  email,
  joining,
  error,
  onJoin,
}: {
  room: string;
  name: string;
  email: string;
  joining: boolean;
  error: string | null;
  onJoin: (s: JoinSettings) => void;
}) {
  const t = useTranslations("meet");
  const [audioAccess, setAudioAccess] = useState<Access>("pending");
  const [videoAccess, setVideoAccess] = useState<Access>("pending");
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [micId, setMicId] = useState("");
  const [camId, setCamId] = useState("");
  const [preview, setPreview] = useState<LocalVideoTrack | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const probed = audioAccess !== "pending" && videoAccess !== "pending";
  const { mics, cams } = useDevices(probed);

  // Ask for camera + mic once (one combined prompt); fall back to each kind to learn which failed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setAudioAccess("insecure");
        setVideoAccess("insecure");
        return;
      }
      try {
        await probe({ audio: true, video: true });
        if (!cancelled) {
          setAudioAccess("ok");
          setVideoAccess("ok");
        }
        return;
      } catch {
        // fall through to per-kind probes
      }
      const [a, v] = await Promise.all([
        probe({ audio: true }).then(() => "ok" as const, classify),
        probe({ video: true }).then(() => "ok" as const, classify),
      ]);
      if (cancelled) return;
      setAudioAccess(a);
      setVideoAccess(v);
      if (a !== "ok") setAudioOn(false);
      if (v !== "ok") setVideoOn(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Camera preview follows the toggle and the selected device; always stopped on change/unmount.
  useEffect(() => {
    if (!videoOn || videoAccess !== "ok") return;
    let cancelled = false;
    let track: LocalVideoTrack | null = null;
    setPreviewFailed(false);
    createLocalVideoTrack({ deviceId: camId || undefined, resolution: { width: 1280, height: 720 } })
      .then((created) => {
        if (cancelled) return created.stop();
        track = created;
        setPreview(created);
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
      track?.stop();
      setPreview(null);
    };
  }, [videoOn, videoAccess, camId]);

  const notice = (() => {
    if (audioAccess === "insecure") return t("insecureContext");
    if (audioAccess === "denied" || videoAccess === "denied") return t("permissionDenied");
    if (audioAccess === "missing" && videoAccess === "missing") return t("noDevices");
    if (videoAccess === "missing") return t("noCamera");
    if (audioAccess === "missing") return t("noMic");
    if (audioAccess === "busy" || videoAccess === "busy" || previewFailed) return t("deviceBusy");
    return null;
  })();

  const toggleBtn = (on: boolean) =>
    `grid h-11 w-11 place-items-center rounded-full border transition-colors duration-150 disabled:opacity-40 ${
      on ? "border-white/30 bg-black/40 text-white hover:bg-black/60" : "border-transparent bg-danger text-white hover:opacity-90"
    }`;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="px-4 pt-3">
        <Link href="/meet" className="icon-btn" aria-label={t("backToMeet")}>
          <ArrowLeft size={18} aria-hidden />
        </Link>
      </div>
      <div className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-8 px-6 pb-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="rise">
          <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-[#0a0a0a]">
            {preview && videoOn ? (
              <VideoView track={preview} mirror />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <div className="flex flex-col items-center gap-3">
                  <Avatar name={name} seed={email} size={88} />
                  <span className="text-[13px] text-white/70">
                    {!probed ? t("startingCamera") : videoOn && videoAccess === "ok" ? t("startingCamera") : t("cameraOff")}
                  </span>
                </div>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-center gap-3 pb-4">
              <button
                type="button"
                className={toggleBtn(audioOn)}
                onClick={() => setAudioOn((v) => !v)}
                disabled={audioAccess !== "ok"}
                aria-pressed={audioOn}
                aria-label={audioOn ? t("turnOffMic") : t("turnOnMic")}
                title={audioOn ? t("turnOffMic") : t("turnOnMic")}
              >
                {audioOn ? <Mic size={18} aria-hidden /> : <MicOff size={18} aria-hidden />}
              </button>
              <button
                type="button"
                className={toggleBtn(videoOn)}
                onClick={() => setVideoOn((v) => !v)}
                disabled={videoAccess !== "ok"}
                aria-pressed={videoOn}
                aria-label={videoOn ? t("turnOffCamera") : t("turnOnCamera")}
                title={videoOn ? t("turnOffCamera") : t("turnOnCamera")}
              >
                {videoOn ? <Video size={18} aria-hidden /> : <VideoOff size={18} aria-hidden />}
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex min-w-0 items-center gap-2">
              <Mic size={15} aria-hidden className="shrink-0 text-ink-mute" />
              <span className="sr-only">{t("microphone")}</span>
              <select value={micId} onChange={(e) => setMicId(e.target.value)} disabled={audioAccess !== "ok" || !mics.length} className={SELECT}>
                <option value="">{t("defaultDevice")}</option>
                {mics.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t("micN", { n: i + 1 })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 items-center gap-2">
              <Video size={15} aria-hidden className="shrink-0 text-ink-mute" />
              <span className="sr-only">{t("camera")}</span>
              <select value={camId} onChange={(e) => setCamId(e.target.value)} disabled={videoAccess !== "ok" || !cams.length} className={SELECT}>
                <option value="">{t("defaultDevice")}</option>
                {cams.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t("cameraN", { n: i + 1 })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {notice && (
            <p role="status" className="mt-3 rounded-lg border border-line bg-sheet-muted px-3 py-2 text-[13px] leading-relaxed text-ink-soft">
              {notice}
            </p>
          )}
        </div>

        <div className="rise text-center lg:text-left">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">{t("readyToJoin")}</h1>
          <p className="mt-2 font-mono text-[13px] text-ink-mute">{room}</p>
          <p className="mt-4 text-[14px] text-ink-soft">{t("joiningAs", { name })}</p>
          <p className="text-[13px] text-ink-mute">{email}</p>
          <button
            type="button"
            disabled={joining || !probed}
            onClick={() =>
              onJoin({
                audio: audioOn && audioAccess === "ok",
                video: videoOn && videoAccess === "ok",
                audioDeviceId: micId || undefined,
                videoDeviceId: camId || undefined,
              })
            }
            className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-6 text-[14px] font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-60"
          >
            {joining && <Loader2 size={15} aria-hidden className="animate-spin" />}
            {joining ? t("joining") : t("joinNow")}
          </button>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
