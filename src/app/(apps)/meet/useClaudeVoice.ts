"use client";

// Claude's spoken replies in a call. When one of the local user's commands finishes with a short
// "spoken" summary, their browser says it and broadcasts it (LiveKit data channel, CLAUDE_VOICE_TOPIC)
// so every participant's browser says it too, with the Web Speech API. Anyone can stop a reply for
// everyone ("stop" signal); anyone can mute Claude's voice on their own device.
// The speaker shown is always the LiveKit identity that sent the reply (the command's owner), never
// a name from the payload.
import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLAUDE_SPEAK_PREF,
  CLAUDE_VOICE_MUTE_PREF,
  CLAUDE_VOICE_TOPIC,
  cleanSpoken,
  COMMAND_ID,
  type ClaudeVoiceSignal,
  type CommandView,
} from "./claude";
import { displayName } from "./media";

export type SpokenItem = { id: string; text: string; lang: string; by: string; mine: boolean };

const RATE = 1.05;
const LANG = /^[a-z]{2}(-[A-Za-z]{2})?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Echo guard for the local "Claude commands" microphone capture: clips that overlap Claude's own
// voice are not uploaded (see useClaudeCommands).
let ttsActive = false;
let ttsLastEnd = 0;
/** Claude's voice was playing at some point since `since` (epoch ms). */
export const ttsPlayedSince = (since: number) => ttsActive || ttsLastEnd >= since;

const ES_WORDS = new Set(
  "el la los las que de del es está están son por para con una un y pero tu tus su sus ya hay tienes tiene mañana hoy correo reunión listo envié he hecho encontré no sí también esta este".split(" "),
);
const EN_WORDS = new Set(
  "the is are and you your to of for with it that this have has i sent done found tomorrow today meeting there was were will can on in at email ready yes not".split(" "),
);

/** "es" or "en" from the words used; `fallback` when it can't tell. */
export function detectLang(text: string, fallback: string): string {
  let es = (text.match(/[áéíóúñ¿¡]/gi) ?? []).length * 2;
  let en = 0;
  for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  return es > en ? "es" : en > es ? "en" : fallback;
}

/** The most natural installed voice for a language (cloud "Natural"/"Online"/Google voices first). */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const base = lang.slice(0, 2).toLowerCase();
  const pref = (navigator.language || "").toLowerCase();
  const tag = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace("_", "-");
  const score = (v: SpeechSynthesisVoice) =>
    (/natural/i.test(v.name) ? 8 : 0) +
    (/online/i.test(v.name) ? 4 : 0) +
    (/google/i.test(v.name) ? 3 : 0) +
    (/microsoft/i.test(v.name) ? 1 : 0) +
    (v.localService ? 0 : 1) +
    (tag(v) === pref ? 1 : 0);
  const list = speechSynthesis.getVoices().filter((v) => tag(v).startsWith(base));
  return list.sort((a, b) => score(b) - score(a))[0] ?? null;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // storage blocked: the setting still applies for this call
  }
}

export function useClaudeVoice(room: Room, uiLang: string) {
  const [current, setCurrent] = useState<SpokenItem | null>(null);
  const [muted, setMutedState] = useState(false);
  /** The local user's own answers are spoken to the call. */
  const [speakAnswers, setSpeakAnswersState] = useState(true);
  const [supported, setSupported] = useState(false);
  const queue = useRef<SpokenItem[]>([]);
  const currentRef = useRef<SpokenItem | null>(null);
  /** Ids already spoken, queued or stopped: each reply is said once per device. */
  const handled = useRef(new Set<string>());
  const mutedRef = useRef(false);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined");
    const m = readFlag(CLAUDE_VOICE_MUTE_PREF, false);
    mutedRef.current = m;
    setMutedState(m);
    setSpeakAnswersState(readFlag(CLAUDE_SPEAK_PREF, true));
    // Chrome loads its voice list lazily.
    if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.getVoices();
  }, []);

  const finish = useCallback(() => {
    if (safety.current) clearTimeout(safety.current);
    safety.current = null;
    currentRef.current = null;
    ttsActive = false;
    ttsLastEnd = Date.now();
    setCurrent(null);
  }, []);

  const pump = useCallback(() => {
    if (currentRef.current || !("speechSynthesis" in window)) return;
    const item = queue.current.shift();
    if (!item) return;
    if (mutedRef.current) {
      queue.current = [];
      return;
    }
    currentRef.current = item;
    ttsActive = true;
    setCurrent(item);
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = item.lang;
    const voice = pickVoice(item.lang);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = RATE;
    const done = () => {
      if (currentRef.current !== item) return;
      finish();
      setTimeout(pump, 150);
    };
    u.onend = done;
    u.onerror = done;
    // Some browsers never fire onend (e.g. the voice failed to load).
    safety.current = setTimeout(done, 4000 + item.text.length * 110);
    speechSynthesis.speak(u);
  }, [finish]);

  const enqueue = useCallback(
    (item: SpokenItem) => {
      if (handled.current.has(item.id)) return;
      handled.current.add(item.id);
      if (mutedRef.current || !("speechSynthesis" in window)) return;
      queue.current.push(item);
      pump();
    },
    [pump],
  );

  /** Stops one reply on this device (queued or playing). */
  const stopLocal = useCallback(
    (id: string) => {
      handled.current.add(id);
      queue.current = queue.current.filter((x) => x.id !== id);
      if (currentRef.current?.id === id) {
        speechSynthesis.cancel();
        finish();
        setTimeout(pump, 150);
      }
    },
    [finish, pump],
  );

  const publish = useCallback(
    (signal: ClaudeVoiceSignal) =>
      room.localParticipant
        .publishData(encoder.encode(JSON.stringify(signal)), { reliable: true, topic: CLAUDE_VOICE_TOPIC })
        .catch(() => undefined),
    [room],
  );

  /** Stops a reply for everyone in the call. */
  const stop = useCallback(
    (id: string) => {
      stopLocal(id);
      void publish({ kind: "stop", id });
    },
    [stopLocal, publish],
  );

  /** Owner side: one of my commands finished with a spoken summary → say it here and in everyone's browser. */
  const announce = useCallback(
    (command: CommandView) => {
      const text = command.spoken ? cleanSpoken(command.spoken) : "";
      if (!text || handled.current.has(command.id) || !readFlag(CLAUDE_SPEAK_PREF, true)) return;
      const lang = detectLang(text, uiLang);
      enqueue({ id: command.id, text, lang, by: displayName(room.localParticipant), mine: true });
      void publish({ kind: "say", id: command.id, text, lang });
    },
    [enqueue, publish, room, uiLang],
  );

  /** Says something on this device only (e.g. a confirmation prompt for the local user). */
  const sayLocal = useCallback(
    (id: string, text: string, lang: string) => enqueue({ id, text: cleanSpoken(text), lang, by: displayName(room.localParticipant), mine: true }),
    [enqueue, room],
  );

  /** Stops whatever of mine is playing (and tells the others). */
  const stopMine = useCallback(() => {
    const cur = currentRef.current;
    if (cur?.mine) stop(cur.id);
  }, [stop]);

  const setMuted = useCallback((on: boolean) => {
    mutedRef.current = on;
    setMutedState(on);
    writeFlag(CLAUDE_VOICE_MUTE_PREF, on);
    if (on && currentRef.current) {
      queue.current = [];
      speechSynthesis.cancel();
      finish();
    }
  }, [finish]);

  const setSpeakAnswers = useCallback((on: boolean) => {
    setSpeakAnswersState(on);
    writeFlag(CLAUDE_SPEAK_PREF, on);
  }, []);

  // Replies and stops from the other participants.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== CLAUDE_VOICE_TOPIC || !participant) return;
      let signal: Partial<ClaudeVoiceSignal> & Record<string, unknown>;
      try {
        signal = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      if (!signal || typeof signal.id !== "string" || !COMMAND_ID.test(signal.id)) return;
      if (signal.kind === "stop") stopLocal(signal.id);
      else if (signal.kind === "say" && typeof signal.text === "string") {
        const text = cleanSpoken(signal.text);
        if (!text) return;
        const lang = typeof signal.lang === "string" && LANG.test(signal.lang) ? signal.lang : detectLang(text, uiLang);
        enqueue({ id: signal.id, text, lang, by: displayName(participant), mine: false });
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, enqueue, stopLocal, uiLang]);

  // Leaving the call silences Claude.
  useEffect(
    () => () => {
      queue.current = [];
      if (currentRef.current && "speechSynthesis" in window) speechSynthesis.cancel();
      if (safety.current) clearTimeout(safety.current);
      currentRef.current = null;
      ttsActive = false;
    },
    [],
  );

  return { supported, current, muted, setMuted, speakAnswers, setSpeakAnswers, announce, sayLocal, stop, stopMine };
}
