// Tests for the assistant name and wake words (src/lib/meetings/wake.ts) and the push-to-talk command
// text built from them (src/lib/meetings/voice.ts). Run: npx jiti scripts/agent-wake.test.ts
import assert from "node:assert/strict";
import { cleanAgentName, familyOf, hostOf, resolveAgentName, stripWake, wakeRegex } from "../src/lib/meetings/wake";
import { commandText } from "../src/lib/meetings/voice";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const strip = (name: string, text: string, wakeWords: string[] = []) => stripWake(text, wakeRegex({ name, wakeWords }));

test("Claude and its old misspellings", () => {
  for (const w of ["Claude", "cloud", "Clod", "claud", "Cloude", "klaud"]) assert.equal(strip("Claude", `${w}, what's next?`), "what's next?", w);
  assert.equal(strip("Claude", "Hey Claude: book a room"), "book a room");
});

test("the bridge's agent name works as a wake word, but no other brand does", () => {
  const re = wakeRegex({ name: "Asistente", family: "claude" });
  assert.equal(stripWake("Claude, send it", re), "send it");
  assert.equal(stripWake("cloud send it", re), "send it");
  assert.equal(stripWake("Codex, send it", wakeRegex({ name: "Asistente", family: "codex" })), "send it");
  assert.equal(strip("Codex", "Claude, send it"), "Claude, send it");
});

test("Codex and how recognition writes it", () => {
  for (const w of ["Codex", "kodex", "codecs", "code x", "Code X"]) assert.equal(strip("Codex", `${w}, summarize`), "summarize", w);
});

test("Gemini and OpenCode", () => {
  for (const w of ["Gemini", "geminis", "Jiminy"]) assert.equal(strip("Gemini", `${w} list my tasks`), "list my tasks", w);
  assert.equal(strip("OpenCode", "open code, list my tasks"), "list my tasks");
  assert.equal(strip("OpenCode", "OpenCode: list my tasks"), "list my tasks");
});

test("custom names, extra wake words, accents", () => {
  assert.equal(strip("Jarvis", "Jarvis, open the board"), "open the board");
  assert.equal(strip("Jarvis", "Friday, open the board", ["Friday"]), "open the board");
  assert.equal(strip("José María", "jose maria, abre la pizarra"), "abre la pizarra");
  assert.equal(strip("José María", "José  María: abre la pizarra"), "abre la pizarra");
});

test("generic words in English and Spanish", () => {
  assert.equal(strip("Codex", "oye asistente, ¿qué tengo hoy?"), "¿qué tengo hoy?");
  assert.equal(strip("Codex", "Oye agente: resume la reunión"), "resume la reunión");
  assert.equal(strip("Codex", "OK assistant, summarize"), "summarize");
  assert.equal(strip("Codex", "Zentico, summarize"), "summarize");
});

test("no match in the middle of a sentence or inside a word", () => {
  assert.equal(strip("Codex", "Ask Codex later"), "Ask Codex later");
  assert.equal(strip("Claude", "We said Claude should do it"), "We said Claude should do it");
  assert.equal(strip("Codex", "agenda for tomorrow"), "agenda for tomorrow");
  assert.equal(strip("Claude", "cloudy today"), "cloudy today");
  assert.equal(strip("Codex", "codexes are old books"), "codexes are old books");
});

test("commandText strips the wake word and drops empty commands", () => {
  const re = wakeRegex({ name: "Codex" });
  assert.equal(commandText([{ text: " Codex," } as never, { text: "what's on my calendar?" } as never], re), "what's on my calendar?");
  assert.equal(commandText("Codex.", re), null);
  assert.equal(commandText("“Oye asistente, abre la pizarra”", re), "abre la pizarra”");
  // Default (no profile): generic words only.
  assert.equal(commandText("Claude, list my tasks"), "Claude, list my tasks");
  assert.equal(commandText("assistant, list my tasks"), "list my tasks");
});

test("names: chosen name, else generic (never the agent's brand); families from bridge headers", () => {
  assert.equal(resolveAgentName({ name: "Jarvis", locale: "en" }), "Jarvis");
  assert.equal(resolveAgentName({ name: "  ", locale: "es" }), "Asistente");
  assert.equal(resolveAgentName({ name: null, locale: "en" }), "Assistant");
  assert.equal(familyOf("zentico-bridge/1.2.0 (box)"), "claude");
  assert.equal(familyOf("zentico-bridge/1.3.0 gemini (my-pc)"), "gemini");
  assert.equal(familyOf("zentico-bridge/1.3.0 weird (my-pc)"), null);
  assert.equal(hostOf("zentico-bridge/1.3.0 codex (my-pc)"), "my-pc");
});

test("name validation", () => {
  assert.equal(cleanAgentName("  Jarvis  "), "Jarvis");
  assert.equal(cleanAgentName("José María"), "José María");
  assert.equal(cleanAgentName("R2D2"), null);
  assert.equal(cleanAgentName("a".repeat(25)), null);
  assert.equal(cleanAgentName("x|y"), null);
  assert.equal(cleanAgentName(""), null);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
