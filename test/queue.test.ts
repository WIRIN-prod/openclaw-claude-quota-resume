import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunResult } from "../src/types.ts";
import { MAX_PROMPT_LENGTH, MAX_RETRY_MS } from "../src/types.ts";
import {
  FAIL, OK, QUOTA, SECRET, T0, deferred, fakeClock, makeQueue, recordingLogger, tempDir,
} from "./helpers.ts";

const target = { sessionKey: "agent:main:main", agentId: "main" };
const fileText = (p: string) => readFileSync(p, "utf8");

test("an eligible item executes once and becomes done; its prompt leaves memory and disk", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  await queue.enqueue({ ...target, prompt: SECRET, dueAt: T0 });
  await queue.processQueue();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ...target, prompt: SECRET });
  assert.equal(queue.state.items[0].status, "done");
  assert.equal(queue.state.items[0].prompt, undefined);
  assert.ok(!fileText(t.path).includes(SECRET), "prompt must not remain on disk once done");
  assert.equal(queue.isBusy, false);
  t.cleanup();
});

test("items that are not yet due are not executed", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  await queue.enqueue({ ...target, prompt: "later", dueAt: T0 + 60_000 });
  await queue.processQueue();
  assert.equal(calls.length, 0);
  assert.equal(queue.state.items[0].status, "waiting");
  t.cleanup();
});

test("confirmed quota exhaustion reschedules at the reported reset time plus buffer", async () => {
  const t = tempDir();
  const clock = fakeClock();
  const { queue, calls } = makeQueue({ path: t.path, now: clock.now, execute: async () => QUOTA });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  const item = queue.state.items[0];
  assert.equal(calls.length, 1);
  assert.equal(item.status, "waiting");
  assert.equal(item.attempts, 1);
  // 3am Asia/Calcutta is 21:30Z the previous day; at T0 (05:30 IST) the next one is 2026-10-13T21:30Z.
  assert.equal(item.nextAttemptAt, Date.parse("2026-10-13T21:30:00Z") + 60_000);
  t.cleanup();
});

test("without a reset time the retry delay backs off and never exceeds the cap", async () => {
  const t = tempDir();
  const clock = fakeClock();
  const noReset: RunResult = { code: 1, timedOut: false, output: "Claude usage limit reached: you've hit your session limit" };
  const { queue } = makeQueue({ path: t.path, now: clock.now, execute: async () => noReset, initialRetryMs: 3_600_000, maxAttempts: 100 });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  for (let i = 0; i < 4; i++) {
    clock.set(Math.max(clock.now(), queue.state.items[0].nextAttemptAt));
    await queue.processQueue();
    assert.ok(queue.state.items[0].nextAttemptAt - clock.now() <= MAX_RETRY_MS, "delay is bounded");
  }
  assert.equal(queue.state.items[0].status, "waiting");
  assert.equal(queue.state.items[0].attempts, 4);
  t.cleanup();
});

test("reaching the maximum number of quota retries moves the item to manual review", async () => {
  const t = tempDir();
  const clock = fakeClock();
  const { queue, calls } = makeQueue({ path: t.path, now: clock.now, execute: async () => QUOTA, maxAttempts: 2 });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  for (let i = 0; i < 2; i++) {
    clock.set(Math.max(clock.now(), queue.state.items[0].nextAttemptAt));
    await queue.processQueue();
  }
  assert.equal(calls.length, 2);
  assert.equal(queue.state.items[0].status, "manual");
  assert.equal(queue.state.items[0].manualReason, "max-attempts");
  clock.advance(7 * 24 * 3600_000);
  await queue.processQueue();
  assert.equal(calls.length, 2, "a manual item is never replayed automatically");
  t.cleanup();
});

test("a non-quota failure goes to manual review and is not retried", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path, execute: async () => FAIL });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  await queue.processQueue();
  assert.equal(calls.length, 1);
  assert.equal(queue.state.items[0].status, "manual");
  assert.equal(queue.state.items[0].manualReason, "non-quota-failure");
  t.cleanup();
});

test("a failure that merely mentions another provider's limit is not quota exhaustion", async () => {
  const t = tempDir();
  const other: RunResult = { code: 1, timedOut: false, output: "OpenAI: you've hit your usage limit" };
  const { queue } = makeQueue({ path: t.path, execute: async () => other });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  assert.equal(queue.state.items[0].manualReason, "non-quota-failure");
  t.cleanup();
});

for (const [name, result] of [
  ["a timeout", { code: null, timedOut: true, output: "" }],
  ["a signal", { code: null, signal: "SIGKILL", timedOut: false, output: "" }],
  ["an error after spawn", { code: null, timedOut: false, spawnError: { code: "EPIPE", name: "Error" }, output: "" }],
] as const) {
  test(`${name} is ambiguous: manual review, never replayed automatically`, async () => {
    const t = tempDir();
    const { queue, calls } = makeQueue({ path: t.path, execute: async () => result });
    await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
    await queue.processQueue();
    await queue.processQueue();
    assert.equal(calls.length, 1);
    assert.equal(queue.state.items[0].status, "manual");
    assert.equal(queue.state.items[0].manualReason, "ambiguous-execution");
    t.cleanup();
  });
}

test("a rejecting executor is treated as ambiguous", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path, execute: async () => { throw new Error(`boom ${SECRET}`); } });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  assert.equal(calls.length, 1);
  assert.equal(queue.state.items[0].manualReason, "ambiguous-execution");
  assert.ok(!JSON.stringify(queue.state).includes(SECRET), "executor error text is never stored");
  assert.equal(queue.isBusy, false);
  t.cleanup();
});

test("a CLI that never started (ENOENT) is a manual non-quota failure", async () => {
  const t = tempDir();
  const result: RunResult = { code: null, timedOut: false, spawnError: { code: "ENOENT", name: "Error" }, output: "" };
  const { queue } = makeQueue({ path: t.path, execute: async () => result });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  assert.equal(queue.state.items[0].manualReason, "non-quota-failure");
  t.cleanup();
});

test("a missing original prompt never executes", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  const { item } = await queue.enqueue({ ...target, dueAt: T0 });
  assert.equal(item.status, "manual");
  assert.equal(item.manualReason, "missing-prompt");
  await queue.processQueue();
  assert.equal(calls.length, 0);
  t.cleanup();
});

test("an oversized prompt is never stored, truncated or executed", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  const { item } = await queue.enqueue({ ...target, prompt: "x".repeat(MAX_PROMPT_LENGTH + 1), dueAt: T0 });
  assert.equal(item.status, "manual");
  assert.equal(item.manualReason, "prompt-too-long");
  assert.equal(item.prompt, undefined);
  await queue.processQueue();
  assert.equal(calls.length, 0);
  t.cleanup();
});

test("a prompt of exactly the limit is accepted", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path });
  const { item } = await queue.enqueue({ ...target, prompt: "x".repeat(MAX_PROMPT_LENGTH), dueAt: T0 });
  assert.equal(item.status, "waiting");
  t.cleanup();
});

test("an invalid session key or agent id is blocked before any execution", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  await queue.enqueue({ sessionKey: "agent:main:main --evil", agentId: "main", prompt: "p", dueAt: T0 });
  await queue.enqueue({ sessionKey: "agent:main:main", agentId: "../x", prompt: "p", dueAt: T0 });
  await queue.processQueue();
  await queue.processQueue();
  assert.equal(calls.length, 0);
  assert.deepEqual(queue.state.items.map(x => x.manualReason), ["invalid-target", "invalid-target"]);
  t.cleanup();
});

test("due items run one at a time, oldest due first", async () => {
  const t = tempDir();
  const clock = fakeClock();
  const gate = deferred<RunResult>();
  let first = true;
  const { queue, calls } = makeQueue({
    path: t.path, now: clock.now,
    execute: async () => { if (first) { first = false; return gate.promise; } return OK; },
  });
  await queue.enqueue({ ...target, prompt: "second", dueAt: T0 - 1000 });
  await queue.enqueue({ ...target, prompt: "first", dueAt: T0 - 5000 });
  const running = queue.processQueue();
  while (calls.length === 0) await new Promise(r => setTimeout(r, 5)); // claim is persisted first
  await queue.processQueue(); // concurrent trigger while one is in flight
  await queue.processQueue();
  assert.equal(calls.length, 1, "no second run while the first is in flight");
  assert.equal(calls[0].prompt, "first", "earliest due item goes first");
  assert.equal(queue.isBusy, true);
  gate.resolve(OK);
  await running;
  await queue.processQueue();
  assert.deepEqual(calls.map(c => c.prompt), ["first", "second"]);
  t.cleanup();
});

test("the running state is durable before execution starts", async () => {
  const t = tempDir();
  let onDiskDuringRun = "";
  const { queue } = makeQueue({
    path: t.path,
    execute: async () => { onDiskDuringRun = JSON.parse(fileText(t.path)).items[0].status; return OK; },
  });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  assert.equal(onDiskDuringRun, "running");
  t.cleanup();
});

test("a persistence failure before execution runs nothing and releases the worker", async () => {
  const t = tempDir();
  const { queue, calls, logger } = makeQueue({ path: t.path });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  // Break the state directory: replace it with a plain file so every write fails.
  rmSync(dirname(t.path), { recursive: true, force: true });
  writeFileSync(dirname(t.path), "not a directory");
  await queue.processQueue();
  assert.equal(calls.length, 0, "must not execute when 'running' cannot be made durable");
  assert.equal(queue.isBusy, false, "worker lock is released");
  assert.equal(queue.state.items[0].status, "waiting", "in-memory state is rolled back");
  assert.ok((logger as ReturnType<typeof recordingLogger>).lines.some(l => l.startsWith("error:") && /persistence failed/i.test(l)));
  // Repair, move past the failure backoff, and the same item runs normally.
  rmSync(dirname(t.path), { force: true });
  mkdirSync(dirname(t.path), { recursive: true });
  await queue.processQueue();
  assert.equal(calls.length, 1);
  assert.equal(queue.state.items[0].status, "done");
  t.cleanup();
});

test("a persistence failure after execution is reported and does not lock the worker", async () => {
  const t = tempDir();
  const { queue, calls, logger } = makeQueue({
    path: t.path,
    execute: async () => { rmSync(dirname(t.path), { recursive: true, force: true }); writeFileSync(dirname(t.path), "x"); return OK; },
  });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  assert.equal(calls.length, 1);
  assert.equal(queue.isBusy, false);
  assert.ok((logger as ReturnType<typeof recordingLogger>).lines.some(l => /not durable/i.test(l)), "non-durable transition is stated, not claimed");
  t.cleanup();
});

test("a failed enqueue write rolls back and reports instead of pretending to queue", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path });
  await queue.ensureLoaded();
  mkdirSync(dirname(t.path), { recursive: true });
  rmSync(dirname(t.path), { recursive: true, force: true });
  writeFileSync(dirname(t.path), "x");
  await assert.rejects(queue.enqueue({ ...target, prompt: "p", dueAt: T0 }));
  assert.equal(queue.state.items.length, 0);
  t.cleanup();
});

test("duplicate enqueue by run id or identical prompt does not create a second item", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path });
  const a = await queue.enqueue({ ...target, prompt: "same", runId: "run-1", dueAt: T0 });
  const b = await queue.enqueue({ ...target, prompt: "other text", runId: "run-1", dueAt: T0 });
  const c = await queue.enqueue({ ...target, prompt: "same", dueAt: T0 });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(c.duplicate, true);
  assert.equal(queue.state.items.length, 1);
  t.cleanup();
});

test("simultaneous enqueues of the same run produce one item", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path });
  await Promise.all([1, 2, 3, 4].map(() => queue.enqueue({ ...target, prompt: "p", runId: "run-9", dueAt: T0 })));
  assert.equal(queue.state.items.length, 1);
  t.cleanup();
});

test("a paused queue executes nothing; resuming allows work", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.setPaused(true);
  await queue.processQueue();
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(fileText(t.path)).paused, true, "paused state persists");
  await queue.setPaused(false);
  await queue.processQueue();
  assert.equal(calls.length, 1);
  await queue.stop();
  t.cleanup();
});

test("after stop() no new work is claimed or executed", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.stop();
  await queue.processQueue();
  assert.equal(calls.length, 0);
  assert.equal(queue.state.items[0].status, "waiting");
  t.cleanup();
});

test("start() loads the queue but never executes immediately", async () => {
  const t = tempDir();
  const first = makeQueue({ path: t.path });
  await first.queue.enqueue({ ...target, prompt: "overdue", dueAt: T0 - 3_600_000 });
  await first.queue.stop();
  const second = makeQueue({ path: t.path });
  await second.queue.start();
  assert.equal(second.calls.length, 0, "gateway_start must not trigger an instant replay");
  assert.equal(second.queue.state.items.length, 1);
  await second.queue.stop();
  t.cleanup();
});

test("waiting items survive a restart intact", async () => {
  const t = tempDir();
  const first = makeQueue({ path: t.path });
  await first.queue.enqueue({ ...target, prompt: SECRET, dueAt: T0 + 5000 });
  const second = makeQueue({ path: t.path });
  await second.queue.ensureLoaded();
  assert.equal(second.queue.state.items[0].status, "waiting");
  assert.equal(second.queue.state.items[0].prompt, SECRET);
  assert.equal(second.queue.state.items[0].nextAttemptAt, T0 + 5000);
  t.cleanup();
});

test("an item left 'running' by a crash is never replayed after restart", async () => {
  const t = tempDir();
  const gate = deferred<RunResult>();
  const first = makeQueue({ path: t.path, execute: () => gate.promise });
  await first.queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  void first.queue.processQueue(); // never resolves: simulates the Gateway dying mid-run
  await new Promise(r => setTimeout(r, 30));
  assert.equal(JSON.parse(fileText(t.path)).items[0].status, "running");
  const second = makeQueue({ path: t.path });
  await second.queue.ensureLoaded();
  assert.equal(second.queue.state.items[0].status, "manual");
  assert.equal(second.queue.state.items[0].manualReason, "interrupted");
  await second.queue.processQueue();
  assert.equal(second.calls.length, 0);
  gate.resolve(OK);
  t.cleanup();
});

test("a corrupt queue file is backed up, not overwritten, and the queue still works", async () => {
  const t = tempDir();
  mkdirSync(dirname(t.path), { recursive: true });
  writeFileSync(t.path, '{"version":3,"items":[ {"truncated');
  const { queue, logger } = makeQueue({ path: t.path });
  await queue.ensureLoaded();
  const backups = readdirSync(dirname(t.path)).filter(f => f.includes(".corrupt-"));
  assert.equal(backups.length, 1, "original is preserved in a backup");
  assert.equal(queue.state.items.length, 0);
  assert.ok((logger as ReturnType<typeof recordingLogger>).lines.some(l => l.startsWith("error:")));
  const { item } = await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  assert.equal(item.status, "waiting");
  t.cleanup();
});

test("a queue from a newer schema is never overwritten", async () => {
  const t = tempDir();
  mkdirSync(dirname(t.path), { recursive: true });
  const future = JSON.stringify({ version: 99, items: [{ id: "x", anything: true }] });
  writeFileSync(t.path, future);
  const { queue } = makeQueue({ path: t.path });
  await queue.ensureLoaded();
  assert.equal(readdirSync(dirname(t.path)).filter(f => f.includes(".corrupt-")).length, 1);
  t.cleanup();
});

test("remove() never removes a running item", async () => {
  const t = tempDir();
  const gate = deferred<RunResult>();
  const { queue } = makeQueue({ path: t.path, execute: () => gate.promise });
  await queue.enqueue({ ...target, prompt: "a", dueAt: T0 });
  await queue.enqueue({ sessionKey: "agent:main:other", agentId: "main", prompt: "b", dueAt: T0 + 10_000_000 });
  const running = queue.processQueue();
  await new Promise(r => setTimeout(r, 30));
  const removed = await queue.remove(() => true);
  assert.equal(removed, 1);
  assert.equal(queue.state.items.length, 1);
  assert.equal(queue.state.items[0].status, "running");
  gate.resolve(OK);
  await running;
  t.cleanup();
});

test("logs and persisted diagnostics never contain the prompt text", async () => {
  const t = tempDir();
  const logger = recordingLogger();
  const results: RunResult[] = [QUOTA, FAIL, { code: null, timedOut: true, output: SECRET }];
  let i = 0;
  const clock = fakeClock();
  const { queue } = makeQueue({ path: t.path, now: clock.now, logger, execute: async () => ({ ...results[i++ % 3], output: `${results[(i - 1) % 3].output} ${SECRET}` }), maxAttempts: 5 });
  for (const text of [`${SECRET} one`, `${SECRET} two`, `${SECRET} three`]) {
    await queue.enqueue({ sessionKey: `agent:main:s${text.length}`, agentId: "main", prompt: text, dueAt: T0 });
  }
  for (let n = 0; n < 6; n++) { clock.advance(30 * 3600_000); await queue.processQueue(); }
  assert.ok(logger.lines.length > 0);
  assert.ok(!logger.lines.join("\n").includes(SECRET), "no log line contains prompt or CLI output");
  const persisted = JSON.stringify(queue.state.items.map(x => ({ e: x.lastError, r: x.manualReason })));
  assert.ok(!persisted.includes(SECRET), "stored diagnostics are sanitized");
  assert.ok(existsSync(t.path));
  t.cleanup();
});
