import test from "node:test";
import assert from "node:assert/strict";
import { boundPrompt, isSlashCommand, messageText, userPromptFrom, validAgentId, validSessionKey } from "../src/prompt.ts";
import { MAX_PROMPT_LENGTH } from "../src/types.ts";

test("recovers the prompt from a plain message event", () => {
  assert.equal(messageText({ content: "  fix the build  " }), "fix the build");
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
});

test("recovers the latest user prompt from a nested hook payload", () => {
  const payload = {
    data: { messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: "the real request" }] },
      { role: "assistant", content: "partial" },
    ] },
  };
  assert.equal(userPromptFrom(payload), "the real request");
});

test("skips tool-result style user turns without text", () => {
  const payload = { messages: [
    { role: "user", content: "do the thing" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] },
  ] };
  assert.equal(userPromptFrom(payload), "do the thing");
});

test("returns undefined when no user prompt exists", () => {
  assert.equal(userPromptFrom({ messages: [{ role: "assistant", content: "hi" }] }), undefined);
  assert.equal(userPromptFrom(undefined), undefined);
  assert.equal(userPromptFrom("string"), undefined);
});

test("slash commands are not user requests", () => {
  for (const c of ["/status", "/claude-quota retry abc", "/new@bot", "  /help me"]) assert.equal(isSlashCommand(c), true, c);
  for (const t of ["/home/user/file.txt is broken", "please run /status", "hello"]) assert.equal(isSlashCommand(t), false, t);
  assert.equal(userPromptFrom({ messages: [{ role: "user", content: "real" }, { role: "user", content: "/claude-quota status" }] }), "real");
  assert.equal(userPromptFrom({ messages: [{ role: "user", content: "/reset" }] }), undefined);
});

test("boundPrompt keeps one extra character so oversize is detectable, never silently truncating below the limit", () => {
  assert.equal(boundPrompt("x".repeat(MAX_PROMPT_LENGTH)).length, MAX_PROMPT_LENGTH);
  assert.equal(boundPrompt("x".repeat(MAX_PROMPT_LENGTH + 500)).length, MAX_PROMPT_LENGTH + 1);
});

test("session keys and agent ids are validated before they reach a CLI", () => {
  assert.equal(validSessionKey("agent:main:telegram:direct:12345"), true);
  for (const bad of ["", "-x", "has space", "line\nbreak", "a".repeat(300), undefined, 5]) assert.equal(validSessionKey(bad), false, String(bad));
  assert.equal(validAgentId("main"), true);
  for (const bad of ["", "--help", "a b", "x".repeat(70)]) assert.equal(validAgentId(bad), false, bad);
});
