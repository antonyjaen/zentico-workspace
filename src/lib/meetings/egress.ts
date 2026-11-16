// LiveKit Egress over its Twirp HTTP API (no server SDK): room-composite MP4 recordings written
// straight to DATA_DIR/video, which the egress container mounts at the same path. Server-only.
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { livekitConfig, livekitHttpUrl, mintServerToken, type LiveKitConfig } from "../livekit";
import { dataDir } from "./db";

/** Video recording is offered only when EGRESS_ENABLED=true and LiveKit itself is configured. */
export function egressConfig(): LiveKitConfig | null {
  if (process.env.EGRESS_ENABLED?.trim().toLowerCase() !== "true") return null;
  return livekitConfig();
}

export const videoDir = () => join(dataDir(), "video");
export const videoPath = (meetingId: string) => join(videoDir(), `${meetingId}.mp4`);

export class TwirpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

async function twirp<T>(config: LiveKitConfig, service: string, method: string, grant: Record<string, unknown>, body: unknown): Promise<T> {
  const token = await mintServerToken(config, grant);
  const res = await fetch(`${livekitHttpUrl(config)}/twirp/livekit.${service}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page (proxy): handled below
  }
  if (!res.ok) {
    const err = (json ?? {}) as { code?: unknown; msg?: unknown };
    const code = typeof err.code === "string" ? err.code : "unknown";
    const msg = typeof err.msg === "string" ? err.msg.slice(0, 200) : `HTTP ${res.status}`;
    throw new TwirpError(res.status, code, `${service}/${method}: ${code}: ${msg}`);
  }
  return (json ?? {}) as T;
}

export type EgressState = "starting" | "active" | "ending" | "complete" | "failed" | "aborted" | "limit_reached";
const STATES: EgressState[] = ["starting", "active", "ending", "complete", "failed", "aborted", "limit_reached"];

type RawEgress = { egress_id?: string; egressId?: string; status?: string | number; error?: string };

/** protojson emits enum names ("EGRESS_COMPLETE"); be lenient and accept numbers too. */
function stateOf(v: unknown): EgressState {
  if (typeof v === "number") return STATES[v] ?? "starting";
  const name = typeof v === "string" ? v.replace(/^EGRESS_/, "").toLowerCase() : "";
  return (STATES as string[]).includes(name) ? (name as EgressState) : "starting";
}

export type EgressInfo = { id: string; state: EgressState; error: string };

const toInfo = (e: RawEgress): EgressInfo => ({
  id: e.egress_id ?? e.egressId ?? "",
  state: stateOf(e.status),
  error: typeof e.error === "string" ? e.error.slice(0, 200) : "",
});

/** True when `identity` is currently connected to `room`. */
export async function isInRoom(config: LiveKitConfig, room: string, identity: string): Promise<boolean> {
  try {
    await twirp(config, "RoomService", "GetParticipant", { room, roomAdmin: true }, { room, identity });
    return true;
  } catch (e) {
    if (e instanceof TwirpError && (e.status === 404 || e.code === "not_found")) return false;
    throw e;
  }
}

/** Starts a grid room-composite egress to DATA_DIR/video/<meetingId>.mp4 (720p, 24 fps, ~550 MB/h). */
export async function startRoomVideo(config: LiveKitConfig, room: string, meetingId: string): Promise<EgressInfo> {
  const dir = videoDir();
  await mkdir(dir, { recursive: true, mode: 0o777 });
  // The egress container may run as another uid; mkdir's mode is masked by the umask.
  await chmod(dir, 0o777).catch(() => undefined);
  const info = await twirp<RawEgress>(
    config,
    "Egress",
    "StartRoomCompositeEgress",
    { roomRecord: true },
    {
      room_name: room,
      layout: "grid",
      file_outputs: [{ file_type: "MP4", filepath: videoPath(meetingId) }],
      advanced: {
        width: 1280,
        height: 720,
        framerate: 24,
        video_codec: "H264_MAIN",
        video_bitrate: 1200,
        audio_codec: "AAC",
        audio_bitrate: 96,
      },
    },
  );
  const out = toInfo(info);
  if (!out.id) throw new TwirpError(502, "malformed", "Egress/StartRoomCompositeEgress: no egress id");
  return out;
}

/** Stops an egress. Already-finished egresses answer with an error, which is ignored. */
export async function stopEgress(config: LiveKitConfig, egressId: string): Promise<void> {
  try {
    await twirp(config, "Egress", "StopEgress", { roomRecord: true }, { egress_id: egressId });
  } catch (e) {
    if (e instanceof TwirpError && e.status < 500) return;
    throw e;
  }
}

/** The egress's current state, or null when LiveKit no longer knows it. */
export async function getEgress(config: LiveKitConfig, egressId: string): Promise<EgressInfo | null> {
  const res = await twirp<{ items?: RawEgress[] }>(config, "Egress", "ListEgress", { roomRecord: true }, { egress_id: egressId });
  const hit = (res.items ?? []).map(toInfo).find((e) => e.id === egressId);
  return hit ?? null;
}
