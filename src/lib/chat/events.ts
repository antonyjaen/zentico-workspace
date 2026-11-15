// In-process event bus feeding /api/chat/events (SSE). Server-only.
// NOTE: this only reaches clients connected to the same Node process. The app is deployed as a
// single container instance; running several replicas would need a shared bus (e.g. Redis/NOTIFY).
import { EventEmitter } from "node:events";
import type { ChatEvent } from "@/app/(apps)/chat/shared";

const g = globalThis as typeof globalThis & { __zwChatBus?: EventEmitter };

function bus(): EventEmitter {
  if (!g.__zwChatBus) {
    g.__zwChatBus = new EventEmitter();
    g.__zwChatBus.setMaxListeners(0);
  }
  return g.__zwChatBus;
}

const channel = (userId: number) => `u:${userId}`;

export function publish(userIds: Iterable<number>, event: ChatEvent) {
  const b = bus();
  for (const id of new Set(userIds)) b.emit(channel(id), event);
}

export function subscribe(userId: number, listener: (event: ChatEvent) => void): () => void {
  const b = bus();
  b.on(channel(userId), listener);
  return () => b.off(channel(userId), listener);
}
