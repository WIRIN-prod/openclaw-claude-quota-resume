import test from "node:test";
import assert from "node:assert/strict";
import type { Item, RunResult } from "../src/types.ts";
import { MAX_RESET_WAIT_MS, MAX_RETRY_MS, RESET_BUFFER_MS } from "../src/types.ts";
import { applyOutcome, backoffMs, classifyRun } from "../src/outcome.ts";
import { QUOTA, SECRET, T0 } from "./helpers.ts";

const base = (over: Partial<Item> = {}): Item => ({
  id: "id-1", sessionKey: "agent:main:main", agentId: "main", prompt: "p",
  createdAt: "2026-10-12T00:00:00.000Z", nextAttemptAt: T0, attempts: 0, status: "running", ...over,
});
const opts = { now: T0, initialRetryMs: 60_000, maxAttempts: 3 };

test("classifyRun: exit 0 is done even when the output mentions a limit", () => {
  assert.equal(classifyRun({ code: 0, timedOut: false, output: "the docs say: you've hit your session limit" }), "done");
});

test("classifyRun: non-zero with Claude quota text is a confirmed quota failure", () => {
  assert.equal(classifyRun(QUOTA), "quota");
});

test("classifyRun: other non-zero exits are plain failures", () => {
  assert.equal(classifyRun({ code: 2, timedOut: false, output: "TypeError: x is not a function" }), "failure");
  assert.equal(classifyRun({ code: 1, timedOut: false, output: "HTTP 429 rate_limit_error" }), "failure");
});

test("classifyRun: timeouts, signals and post-spawn errors are ambiguous", () => {
  assert.equal(classifyRun({ code: null, timedOut: true, output: "" }), "ambiguous");
  assert.equal(classifyRun({ code: null, signal: "SIGTERM", timedOut: false, output: "" }), "ambiguous");
  assert.equal(classifyRun({ code: null, timedOut: false, spawnError: { code: "EPIPE", name: "Error" }, output: "" }), "ambiguous");
  assert.equal(classifyRun({ code: 1, timedOut: true, output: QUOTA.output }), "ambiguous", "a timeout wins over quota-looking output");
});

test("classifyRun: only a spawn failure proves the CLI never started", () => {
  assert.equal(classifyRun({ code: null, timedOut: false, spawnError: { code: "ENOENT", name: "Error" }, output: "" }), "not-started");
  assert.equal(classifyRun({ code: null, timedOut: false, spawnError: { code: "EACCES", name: "Error" }, output: "" }), "not-started");
});

test("backoffMs doubles per attempt and never exceeds the cap", () => {
  assert.equal(backoffMs(1, 60_000), 120_000);
  assert.equal(backoffMs(2, 60_000), 240_000);
  assert.equal(backoffMs(50, 60_000), MAX_RETRY_MS);
  assert.equal(backoffMs(3, MAX_RETRY_MS), MAX_RETRY_MS);
});

test("applyOutcome(done) clears the prompt and diagnostics", () => {
  const item = base({ lastError: "old", manualReason: "interrupted" });
  assert.equal(applyOutcome(item, { code: 0, timedOut: false, output: "" }, opts), "done");
  assert.equal(item.status, "done");
  assert.equal(item.prompt, undefined);
  assert.equal(item.lastError, undefined);
  assert.equal(item.manualReason, undefined);
});

test("applyOutcome(quota) counts the attempt and schedules after the reset plus buffer", () => {
  const item = base();
  applyOutcome(item, QUOTA, opts);
  assert.equal(item.status, "waiting");
  assert.equal(item.attempts, 1);
  assert.equal(item.nextAttemptAt, Date.parse("2026-10-13T21:30:00Z") + RESET_BUFFER_MS);
});

test("applyOutcome(quota) caps an absurdly distant reset time", () => {
  const item = base();
  const far: RunResult = { code: 1, timedOut: false, output: "Claude: you've hit your session limit · resets 1am (Pacific/Kiritimati)" };
  // Reset parsing is bounded by the next 24h wall-clock occurrence, and then by MAX_RESET_WAIT_MS.
  applyOutcome(item, far, opts);
  assert.ok(item.nextAttemptAt - T0 <= MAX_RESET_WAIT_MS);
});

test("applyOutcome(quota) at the attempt limit stops for manual review", () => {
  const item = base({ attempts: 2 });
  applyOutcome(item, QUOTA, opts);
  assert.equal(item.status, "manual");
  assert.equal(item.manualReason, "max-attempts");
});

test("applyOutcome never copies CLI output into the item", () => {
  for (const r of [
    { code: 1, timedOut: false, output: `${SECRET} you've hit your session limit, Claude` },
    { code: 1, timedOut: false, output: SECRET },
    { code: null, timedOut: true, output: SECRET },
    { code: null, timedOut: false, spawnError: { code: "ENOENT", name: "Error" }, output: SECRET },
  ] as RunResult[]) {
    const item = base();
    applyOutcome(item, r, opts);
    assert.ok(!JSON.stringify(item).includes(SECRET));
  }
});

test("applyOutcome(ambiguous) keeps the prompt for review but blocks replay", () => {
  const item = base();
  applyOutcome(item, { code: null, timedOut: true, output: "" }, opts);
  assert.equal(item.status, "manual");
  assert.equal(item.manualReason, "ambiguous-execution");
  assert.equal(item.prompt, "p");
});
