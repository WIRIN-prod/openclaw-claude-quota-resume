import test from "node:test";
import assert from "node:assert/strict";
import { failureText, quotaError, resetTimeFrom } from "../src/detect.ts";

test("recognises the Claude session-limit message", () => {
  assert.equal(quotaError("You've hit your session limit · resets 3am (Asia/Calcutta)"), true);
  assert.equal(quotaError("You’ve hit your session limit · resets 3am (Asia/Calcutta)"), true);
});

test("recognises Claude subscription limit messages", () => {
  assert.equal(quotaError("Claude usage limit reached for your subscription. Resets 2pm (UTC)"), true);
  assert.equal(quotaError("Anthropic subscription: weekly limit reached"), true);
  assert.equal(quotaError({ error: "5-hour limit reached ∙ resets 11pm (Europe/London)" }), true);
});

test("ignores another provider's rate limit or quota error", () => {
  assert.equal(quotaError("OpenAI: rate limit exceeded, please retry in 20s"), false);
  assert.equal(quotaError("429 RESOURCE_EXHAUSTED: quota exceeded for Gemini API"), false);
  assert.equal(quotaError("You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM (Codex)"), false);
  assert.equal(quotaError("Vertex AI quota exceeded for claude-sonnet in project x"), false);
});

test("a plain Anthropic API rate limit is not subscription quota exhaustion", () => {
  assert.equal(quotaError('{"type":"error","error":{"type":"rate_limit_error","message":"Anthropic API rate limit"}}'), false);
});

test("ignores generic agent failures and bare 'session limit' text", () => {
  assert.equal(quotaError("Error: tool call failed: ENOENT"), false);
  assert.equal(quotaError("connection reset by peer"), false);
  assert.equal(quotaError("The session limit for this web server is 50 connections"), false);
});

test("tolerates malformed payloads", () => {
  for (const v of [undefined, null, 42, true, [], {}, { a: { b: [] } }]) assert.equal(quotaError(v), false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(quotaError(cyclic), false);
  assert.equal(failureText(undefined), "");
  assert.equal(failureText("text"), "");
  assert.equal(failureText({ messages: "nope", error: 5 }), "");
});

test("failureText reads only the error and the last assistant message, never user text", () => {
  const event = {
    success: false,
    error: "boom",
    messages: [
      { role: "user", content: "please explain the Claude session limit that resets 3am (UTC)" },
      { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 3am (UTC)" }] },
    ],
  };
  const text = failureText(event);
  assert.match(text, /boom/);
  assert.match(text, /session limit/);
  const userOnly = failureText({ success: false, messages: [{ role: "user", content: "You've hit your session limit · resets 3am (UTC)" }] });
  assert.equal(quotaError(userOnly), false);
});

test("resetTimeFrom resolves the next occurrence in the named zone", () => {
  const now = Date.parse("2026-10-13T10:00:00Z"); // 15:30 in Asia/Calcutta
  const fb = -1;
  assert.equal(resetTimeFrom("resets 3am (Asia/Calcutta)", fb, now), Date.parse("2026-10-13T21:30:00Z"));
  assert.equal(resetTimeFrom("resets 5pm (Asia/Calcutta)", fb, now), Date.parse("2026-10-13T11:30:00Z"));
  assert.equal(resetTimeFrom("Resets 4:30pm (UTC)", fb, now), Date.parse("2026-10-13T16:30:00Z"));
});

test("resetTimeFrom falls back on missing or invalid information", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  assert.equal(resetTimeFrom("no reset info", 123, now), 123);
  assert.equal(resetTimeFrom("resets 3am (Not/AZone)", 123, now), 123);
  assert.equal(resetTimeFrom("resets 13pm (UTC)", 123, now), 123);
  assert.equal(resetTimeFrom("resets 3:75am (UTC)", 123, now), 123);
});
