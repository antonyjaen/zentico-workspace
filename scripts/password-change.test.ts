// Tests for the self-service password change (Settings → Security): input checks, the exact
// x:AccountPassword/set request sent to Stalwart, and how Stalwart's answers map to errors.
// No network: fetch is stubbed. Run: npx jiti scripts/password-change.test.ts
import assert from "node:assert/strict";
import {
  checkPasswordInput,
  passwordSetArgs,
  readPasswordSetResult,
  sameSecret,
  strengthEstimate,
  utf8Length,
} from "../src/lib/security/password";

process.env.OIDC_ISSUER = "https://mail.example.com";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const OLD = "old-example-pass";
const NEW = "correct horse battery staple 42";

async function main() {
  /* ---------------------------------------------------------------- input checks */
  await test("accepts a valid change without code", () => {
    assert.deepEqual(checkPasswordInput({ current: OLD, next: NEW, confirm: NEW, code: null }), { current: OLD, next: NEW, code: null });
  });
  await test("rejects mismatch", () => {
    assert.deepEqual(checkPasswordInput({ current: OLD, next: NEW, confirm: NEW + "x", code: null }), { error: "mismatch" });
  });
  await test("rejects new == current", () => {
    assert.deepEqual(checkPasswordInput({ current: NEW, next: NEW, confirm: NEW, code: null }), { error: "same" });
  });
  await test("rejects non-strings, empties, control chars and huge input", () => {
    for (const bad of [
      { current: 1, next: NEW, confirm: NEW },
      { current: OLD, next: null, confirm: null },
      { current: "", next: NEW, confirm: NEW },
      { current: OLD, next: "", confirm: "" },
      { current: OLD, next: "abc\ndefghij", confirm: "abc\ndefghij" },
      { current: OLD, next: "x".repeat(1025), confirm: "x".repeat(1025) },
    ]) {
      assert.deepEqual(checkPasswordInput({ ...bad, code: null }), { error: "invalid" }, JSON.stringify(bad).slice(0, 60));
    }
  });
  await test("leaves length/strength to Stalwart (short password passes the shape check)", () => {
    assert.ok(!("error" in checkPasswordInput({ current: OLD, next: "abc", confirm: "abc", code: null })));
  });
  await test("sameSecret is exact, including length and unicode", () => {
    assert.equal(sameSecret("abc", "abc"), true);
    assert.equal(sameSecret("abc", "abcd"), false);
    assert.equal(sameSecret("", "a"), false);
    assert.equal(sameSecret("ñandú", "ñandú"), true);
    assert.equal(sameSecret("ñandú", "nandu"), false);
  });
  await test("utf8Length counts bytes like Stalwart (str::len)", () => {
    assert.equal(utf8Length("abcdefgh"), 8);
    assert.equal(utf8Length("ñññ"), 6);
  });

  /* ------------------------------------------------------------- request builder */
  await test("set args: secret, currentSecret, masked otpUrl (keeps TOTP), code", () => {
    assert.deepEqual(passwordSetArgs({ current: OLD, next: NEW, code: "123456" }), {
      update: { singleton: { secret: NEW, currentSecret: OLD, otpAuth: { otpUrl: "****", otpCode: "123456" } } },
    });
    assert.deepEqual(passwordSetArgs({ current: OLD, next: NEW, code: null }).update.singleton.otpAuth, { otpUrl: "****", otpCode: null });
  });

  /* ------------------------------------------------------------- result mapping */
  // Descriptions are Stalwart v1.1 literals (crates/jmap/src/registry/mapping/account.rs and
  // crates/common/src/network/security.rs is_secure_password).
  const refused = (type: string, description: string) => ({ notUpdated: { singleton: { type, description } } });
  await test("maps success", () => assert.deepEqual(readPasswordSetResult({ updated: { singleton: null } }), { ok: true }));
  await test("maps Stalwart's errors", () => {
    assert.deepEqual(readPasswordSetResult(refused("forbidden", "Current secret is incorrect.")), { ok: false, error: "wrong_credentials" });
    assert.deepEqual(readPasswordSetResult(refused("forbidden", "Current OTP code is required to change the password or OTP auth.")), {
      ok: false,
      error: "otp_required",
    });
    assert.deepEqual(readPasswordSetResult(refused("invalidProperties", "Password must be at least 8 characters long.")), {
      ok: false,
      error: "too_short",
      limit: 8,
    });
    assert.deepEqual(readPasswordSetResult(refused("invalidProperties", "Password must be at most 128 characters long.")), {
      ok: false,
      error: "too_long",
      limit: 128,
    });
    assert.deepEqual(readPasswordSetResult(refused("invalidProperties", "Password is too weak. This is a top-10 common password.")), {
      ok: false,
      error: "weak",
      detail: "This is a top-10 common password.",
    });
    assert.deepEqual(readPasswordSetResult(refused("invalidProperties", "Password is too weak.")), { ok: false, error: "weak" });
    assert.deepEqual(readPasswordSetResult(refused("forbidden", "Operation not allowed.")), { ok: false, error: "not_supported" });
    assert.deepEqual(readPasswordSetResult(refused("forbidden", "Your account does not support password changes")), {
      ok: false,
      error: "not_supported",
    });
    assert.deepEqual(readPasswordSetResult(refused("invalidProperties", "Something new.")), { ok: false, error: "rejected", detail: "Something new." });
    assert.deepEqual(readPasswordSetResult({}), { ok: false, error: "failed" });
  });

  await test("strength estimate is monotone-ish", () => {
    assert.equal(strengthEstimate(""), 0);
    assert.ok(strengthEstimate("aaaaaaaa") <= 1);
    assert.ok(strengthEstimate("12345678") <= 1);
    assert.ok(strengthEstimate(NEW) >= 3);
  });

  /* ------------------------------------------- end to end with a stubbed Stalwart */
  const { changePassword } = await import("../src/lib/security/stalwart");
  const sent: { url: string; auth: string | null; body: unknown }[] = [];
  let answer: () => Response = () => Response.json({ methodResponses: [["x:AccountPassword/set", { updated: { singleton: null } }, "0"]] });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/jmap/session")) {
      return Response.json({ apiUrl: "https://mail.example.com/jmap/", primaryAccounts: { "urn:stalwart:jmap": "a1" } });
    }
    sent.push({ url, auth, body: JSON.parse(String(init?.body)) });
    return answer();
  }) as typeof fetch;

  await test("sends the exact JMAP request", async () => {
    const r = await changePassword("tok-example", { current: OLD, next: NEW, code: "654321" });
    assert.deepEqual(r, { ok: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://mail.example.com/jmap/");
    assert.equal(sent[0].auth, "Bearer tok-example");
    assert.deepEqual(sent[0].body, {
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: [
        [
          "x:AccountPassword/set",
          {
            accountId: "a1",
            update: { singleton: { secret: NEW, currentSecret: OLD, otpAuth: { otpUrl: "****", otpCode: "654321" } } },
          },
          "0",
        ],
      ],
    });
  });
  await test("401 → authorize, 429 → rate_limited, notUpdated → mapped", async () => {
    answer = () => new Response("", { status: 401 });
    assert.deepEqual(await changePassword("t", { current: OLD, next: NEW, code: null }), { ok: false, error: "authorize" });
    answer = () => new Response("", { status: 429 });
    assert.deepEqual(await changePassword("t", { current: OLD, next: NEW, code: null }), { ok: false, error: "rate_limited" });
    answer = () =>
      Response.json({
        methodResponses: [["x:AccountPassword/set", refused("forbidden", "Current secret is incorrect."), "0"]],
      });
    assert.deepEqual(await changePassword("t", { current: OLD, next: NEW, code: null }), { ok: false, error: "wrong_credentials" });
  });

  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error("FAIL", f);
  if (failures.length) process.exit(1);
}

main();
