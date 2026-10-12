import test from "node:test";
import assert from "node:assert/strict";
import type { PluginApiLike } from "../src/plugin.ts";
import { parseConfig, registerClaudeQuotaResume } from "../src/plugin.ts";
import type { RunJob, RunResult } from "../src/types.ts";
import { DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_ATTEMPTS, MAX_RETRY_MS } from "../src/types.ts";
import { OK, SECRET, T0, fakeClock, recordingLogger, tempDir } from "./helpers.ts";

const QUOTA_ERROR = "You've hit your session limit · resets 3am (Asia/Calcutta)";
const KEY = "agent:main:main";

function harness(opts: { config?: Record<string, unknown>; execute?: (j: RunJob) => Promise<RunResult> } = {}) {
  const t = tempDir();
  const logger = recordingLogger();
  const clock = fakeClock();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let command: { name: string; acceptsArgs: boolean; handler: (ctx: { args?: string }) => Promise<{ text: string }> | { text: string } } | undefined;
  const calls: RunJob[] = [];
  const api: PluginApiLike = {
    pluginConfig: { statePath: t.path, ...opts.config },
    logger,
    on: (hook, handler) => { handlers.set(hook, handler); },
    registerCommand: (def) => { command = def; },
  };
  const queue = registerClaudeQuotaResume(api, {
    now: clock.now,
    execute: async (job) => { calls.push(job); return (opts.execute ?? (async () => OK))(job); },
  });
  const fire = (hook: string, event: unknown, ctx: unknown = {}) => handlers.get(hook)!(event, ctx);
  const userMessage = (text: string, ctx: unknown = { sessionKey: KEY }) => fire("message_received", { from: "u", content: text }, ctx);
  const quotaEnd = (extra: Record<string, unknown> = {}, ctx: unknown = { sessionKey: KEY }) =>
    fire("agent_end", { success: false, error: QUOTA_ERROR, messages: [], ...extra }, ctx);
  return { t, logger, clock, handlers, get command() { return command!; }, calls, queue, fire, userMessage, quotaEnd };
}

test("registers the four hooks and the /claude-quota command", () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()].sort(), ["agent_end", "gateway_start", "gateway_stop", "message_received"]);
  assert.equal(h.command.name, "claude-quota");
  assert.equal(h.command.acceptsArgs, true);
  h.t.cleanup();
});

test("a Claude quota failure queues the original prompt and runs nothing", async () => {
  const h = harness();
  await h.userMessage(`${SECRET} do the thing`);
  await h.quotaEnd({ runId: "r1" });
  assert.equal(h.queue.state.items.length, 1);
  const item = h.queue.state.items[0];
  assert.equal(item.status, "waiting");
  assert.equal(item.prompt, `${SECRET} do the thing`);
  assert.equal(item.sessionKey, KEY);
  assert.equal(item.nextAttemptAt, Date.parse("2026-10-13T21:30:00Z") + 60_000, "uses the reported reset time");
  assert.equal(h.calls.length, 0, "queueing never executes");
  h.t.cleanup();
});

test("without a reset time the configured fallback delay is used", async () => {
  const h = harness({ config: { initialRetryMs: 120_000 } });
  await h.userMessage("p");
  await h.quotaEnd({ error: "Claude usage limit: you've hit your session limit" });
  assert.equal(h.queue.state.items[0].nextAttemptAt, T0 + 120_000);
  h.t.cleanup();
});

test("failures that are not Claude quota errors queue nothing", async () => {
  const h = harness();
  await h.userMessage("p");
  for (const error of ["something exploded", "429 rate_limit_error", "OpenAI: you've hit your usage limit", "ECONNRESET"]) {
    await h.quotaEnd({ error });
  }
  assert.equal(h.queue.state.items.length, 0);
  h.t.cleanup();
});

test("a successful run queues nothing, even if its text mentions a limit", async () => {
  const h = harness();
  await h.userMessage("explain what 'you've hit your session limit' means");
  await h.fire("agent_end", { success: true, error: QUOTA_ERROR, messages: [] }, { sessionKey: KEY });
  assert.equal(h.queue.state.items.length, 0);
  h.t.cleanup();
});

test("a failure message found only in user text is not treated as the failure", async () => {
  const h = harness();
  await h.fire("agent_end", {
    success: false, error: "boom",
    messages: [{ role: "user", content: `please explain: ${QUOTA_ERROR}` }],
  }, { sessionKey: KEY });
  assert.equal(h.queue.state.items.length, 0);
  h.t.cleanup();
});

test("a quota failure without a session key is not queued", async () => {
  const h = harness();
  await h.userMessage("p");
  await h.quotaEnd({}, {});
  assert.equal(h.queue.state.items.length, 0);
  assert.ok(h.logger.lines.some(l => l.startsWith("warn:") && /without session key/.test(l)));
  h.t.cleanup();
});

test("an invalid session key or agent id is never queued for replay", async () => {
  const h = harness();
  await h.quotaEnd({}, { sessionKey: "agent:main:main\nrm" });
  await h.quotaEnd({}, { sessionKey: KEY, agentId: "../etc" });
  assert.equal(h.queue.state.items.length, 0);
  h.t.cleanup();
});

test("malformed hook payloads are ignored without throwing", async () => {
  const h = harness();
  for (const event of [undefined, null, 42, "text", [], {}, { success: "false" }, { success: false }]) {
    await assert.doesNotReject(async () => { await h.fire("agent_end", event, undefined); });
    await assert.doesNotReject(async () => { await h.fire("agent_end", event, { sessionKey: KEY }); });
    await assert.doesNotReject(async () => { await h.fire("message_received", event, undefined); });
  }
  assert.equal(h.queue.state.items.length, 0);
  h.t.cleanup();
});

test("a slash command is never captured as the user's request", async () => {
  const h = harness();
  await h.userMessage("/claude-quota retry 1234 2026-10-14T09:00:00Z");
  await h.userMessage("/status");
  await h.quotaEnd();
  assert.equal(h.queue.state.items.length, 1);
  assert.equal(h.queue.state.items[0].status, "manual");
  assert.equal(h.queue.state.items[0].manualReason, "missing-prompt");
  assert.equal(h.queue.state.items[0].prompt, undefined);
  h.t.cleanup();
});

test("a slash command does not overwrite the real prompt that came before it", async () => {
  const h = harness();
  await h.userMessage("the real request");
  await h.userMessage("/claude-quota status");
  await h.quotaEnd();
  assert.equal(h.queue.state.items[0].prompt, "the real request");
  h.t.cleanup();
});

test("a prompt can be recovered from the failing event's own messages", async () => {
  const h = harness();
  await h.fire("agent_end", {
    success: false, error: QUOTA_ERROR,
    messages: [{ role: "user", content: [{ type: "text", text: "recovered from payload" }] }],
  }, { sessionKey: KEY });
  assert.equal(h.queue.state.items[0].prompt, "recovered from payload");
  assert.equal(h.queue.state.items[0].status, "waiting");
  h.t.cleanup();
});

test("no recoverable prompt means manual review, never a guessed request", async () => {
  const h = harness();
  await h.quotaEnd();
  assert.equal(h.queue.state.items[0].status, "manual");
  assert.equal(h.queue.state.items[0].manualReason, "missing-prompt");
  await h.queue.processQueue();
  assert.equal(h.calls.length, 0);
  h.t.cleanup();
});

test("a stale cached prompt (older than 30 minutes) is not used", async () => {
  const h = harness();
  await h.userMessage("old request");
  h.clock.advance(31 * 60_000);
  await h.quotaEnd();
  assert.equal(h.queue.state.items[0].manualReason, "missing-prompt");
  h.t.cleanup();
});

test("a prompt cached for a different run is not used", async () => {
  const h = harness();
  await h.fire("message_received", { from: "u", content: "request of run A", runId: "A" }, { sessionKey: KEY, runId: "A" });
  await h.quotaEnd({ runId: "B" });
  assert.equal(h.queue.state.items[0].manualReason, "missing-prompt");
  h.t.cleanup();
});

test("a completed turn invalidates the cached prompt so it cannot leak into a later failure", async () => {
  const h = harness();
  await h.userMessage("request one");
  await h.fire("agent_end", { success: true, messages: [] }, { sessionKey: KEY });
  await h.quotaEnd();
  assert.equal(h.queue.state.items[0].manualReason, "missing-prompt");
  assert.equal(h.queue.state.items[0].prompt, undefined);
  h.t.cleanup();
});

test("sessions are kept apart: a prompt from one session is never used for another", async () => {
  const h = harness();
  await h.userMessage("belongs to A", { sessionKey: "agent:main:a" });
  await h.quotaEnd({}, { sessionKey: "agent:main:b" });
  assert.equal(h.queue.state.items[0].sessionKey, "agent:main:b");
  assert.equal(h.queue.state.items[0].prompt, undefined);
  h.t.cleanup();
});

test("the agent id comes from the hook context or the session key", async () => {
  const h = harness();
  await h.userMessage("p", { sessionKey: "agent:ops:incident" });
  await h.quotaEnd({}, { sessionKey: "agent:ops:incident" });
  assert.equal(h.queue.state.items[0].agentId, "ops");
  h.t.cleanup();
});

test("the same failing run delivered twice queues one item", async () => {
  const h = harness();
  await h.userMessage("p");
  await h.quotaEnd({ runId: "run-7" });
  await h.quotaEnd({ runId: "run-7" });
  await h.userMessage("p");
  await h.quotaEnd({ runId: "run-7" });
  assert.equal(h.queue.state.items.length, 1);
  h.t.cleanup();
});

test("concurrent deliveries of the same failure queue one item", async () => {
  const h = harness();
  await h.userMessage("p");
  await Promise.all([h.quotaEnd({ runId: "run-8" }), h.quotaEnd({ runId: "run-8" }), h.quotaEnd({ runId: "run-8" })]);
  assert.equal(h.queue.state.items.length, 1);
  h.t.cleanup();
});

test("an oversized prompt goes to manual review instead of being truncated and replayed", async () => {
  const h = harness();
  await h.userMessage("y".repeat(150_000));
  await h.quotaEnd();
  assert.equal(h.queue.state.items[0].manualReason, "prompt-too-long");
  assert.equal(h.queue.state.items[0].prompt, undefined);
  h.t.cleanup();
});

test("a failed write is reported and the same failure can be queued on a repeat delivery", async () => {
  const fs = await import("node:fs");
  const { dirname } = await import("node:path");
  const h = harness();
  await h.queue.ensureLoaded();
  fs.writeFileSync(dirname(h.t.path), "block");
  await h.userMessage("p");
  await h.quotaEnd({ runId: "run-5" });
  assert.equal(h.queue.state.items.length, 0);
  assert.ok(h.logger.lines.some(l => /Could not persist/.test(l)));
  fs.rmSync(dirname(h.t.path), { force: true });
  await h.userMessage("p");
  await h.quotaEnd({ runId: "run-5" });
  assert.equal(h.queue.state.items.length, 1, "the failed delivery did not poison the dedupe set");
  h.t.cleanup();
});

test("logs never contain the prompt", async () => {
  const h = harness();
  await h.userMessage(`${SECRET} private`);
  await h.quotaEnd({ runId: "r" });
  await h.userMessage(`${SECRET} two`, { sessionKey: "agent:main:two" });
  await h.quotaEnd({}, { sessionKey: "agent:main:two" });
  assert.ok(h.logger.lines.length > 0);
  assert.ok(!h.logger.lines.join("\n").includes(SECRET));
  h.t.cleanup();
});

test("gateway_start loads the queue without running anything; gateway_stop stops the worker", async () => {
  const h = harness();
  await h.userMessage("p");
  await h.quotaEnd();
  h.clock.advance(48 * 3600_000);
  await h.fire("gateway_start", {});
  assert.equal(h.calls.length, 0, "start never replays immediately");
  await h.fire("gateway_stop", {});
  await h.queue.processQueue();
  assert.equal(h.calls.length, 0, "no work after gateway_stop");
  h.t.cleanup();
});

test("the registered /claude-quota command routes to the queue and never executes", async () => {
  const h = harness();
  await h.userMessage(`${SECRET} p`);
  await h.quotaEnd();
  const status = await h.command.handler({ args: "status" });
  assert.match(status.text, /waiting=1/);
  assert.ok(!status.text.includes(SECRET));
  assert.match((await h.command.handler({})).text, /Queue: 1 item/);
  assert.equal(h.calls.length, 0);
  h.t.cleanup();
});

test("parseConfig applies defaults, clamps values and warns about deprecated options", () => {
  const logger = recordingLogger();
  const defaults = parseConfig(undefined, logger);
  assert.equal(defaults.initialRetryMs, DEFAULT_INITIAL_RETRY_MS);
  assert.equal(defaults.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.ok(defaults.statePath.endsWith("/.openclaw/state/claude-quota-resume/queue.json"));
  assert.ok(!defaults.statePath.includes("~"));
  const clamped = parseConfig({ initialRetryMs: 1, maxAttempts: 99999 }, logger);
  assert.equal(clamped.initialRetryMs, 1000);
  assert.equal(clamped.maxAttempts, 1000);
  assert.equal(parseConfig({ initialRetryMs: 1e12 }, logger).initialRetryMs, MAX_RETRY_MS);
  assert.equal(parseConfig({ maxAttempts: 0 }, logger).maxAttempts, 1);
  assert.equal(parseConfig({ maxAttempts: "x", initialRetryMs: NaN }, logger).maxAttempts, DEFAULT_MAX_ATTEMPTS);
  parseConfig({ retryOnUnknownFailure: true, defaultSessionKey: "agent:x:y" }, logger);
  assert.ok(logger.lines.some(l => /retryOnUnknownFailure is ignored/.test(l)));
  assert.ok(logger.lines.some(l => /defaultSessionKey is ignored/.test(l)));
});
