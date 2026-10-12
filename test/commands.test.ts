import test from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "../src/types.ts";
import { MAX_MANUAL_RETRY_AHEAD_MS, MAX_PROMPT_LENGTH } from "../src/types.ts";
import { runCommand, formatStatus } from "../src/commands.ts";
import { FAIL, OK, SECRET, T0, deferred, makeQueue, tempDir } from "./helpers.ts";

const target = { sessionKey: "agent:main:main", agentId: "main" };
const FUTURE = new Date(T0 + 3_600_000).toISOString();
const run = (q: Parameters<typeof runCommand>[0], args: string) => runCommand(q, args, T0).then(r => r.text);

/** A queue holding one manual item (failed run) and one waiting item. */
async function seeded(execute?: Parameters<typeof makeQueue>[0]["execute"]) {
  const t = tempDir();
  const ctx = makeQueue({ path: t.path, execute: execute ?? (async () => FAIL) });
  await ctx.queue.enqueue({ ...target, prompt: `${SECRET} manual one`, dueAt: T0 });
  await ctx.queue.processQueue();
  await ctx.queue.enqueue({ sessionKey: "agent:main:later", agentId: "main", prompt: `${SECRET} waiting one`, dueAt: T0 + 86_400_000 });
  const [manual, waiting] = ctx.queue.state.items;
  ctx.calls.length = 0;
  return { t, ...ctx, manual, waiting };
}

test("status never reveals prompt text, only its length", async () => {
  const { t, queue } = await seeded();
  const text = await run(queue, "status");
  assert.ok(!text.includes(SECRET));
  assert.match(text, /prompt=\d+ chars/);
  assert.match(text, /manual/);
  assert.match(text, /waiting/);
  assert.ok(!formatStatus(queue, T0).includes(SECRET));
  t.cleanup();
});

test("status with no arguments and an empty queue is safe", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path });
  assert.match(await run(queue, ""), /Queue: 0 item/);
  t.cleanup();
});

test("pause persists and resume clears it", async () => {
  const { t, queue } = await seeded();
  await run(queue, "pause");
  assert.equal(queue.state.paused, true);
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(t.path, "utf8")).paused, true);
  await run(queue, "resume");
  assert.equal(queue.state.paused, false);
  await queue.stop();
  t.cleanup();
});

test("clear without a target or with extra words returns usage and removes nothing", async () => {
  const { t, queue } = await seeded();
  assert.match(await run(queue, "clear"), /Usage/);
  assert.match(await run(queue, "clear manual extra"), /Usage/);
  assert.equal(queue.state.items.length, 2);
  t.cleanup();
});

test("destructive clear needs --confirm and says what it would remove", async () => {
  const { t, queue } = await seeded();
  const preview = await run(queue, "clear all");
  assert.match(preview, /Would remove 2 item/);
  assert.equal(queue.state.items.length, 2);
  t.cleanup();
});

test("clear <id> --confirm removes only that item", async () => {
  const { t, queue, manual, waiting } = await seeded();
  assert.match(await run(queue, `clear ${manual.id.slice(0, 8)} --confirm`), /Removed 1/);
  assert.deepEqual(queue.state.items.map(x => x.id), [waiting.id]);
  t.cleanup();
});

test("clear manual --confirm preserves waiting items", async () => {
  const { t, queue, waiting } = await seeded();
  await run(queue, "clear manual --confirm");
  assert.deepEqual(queue.state.items.map(x => x.id), [waiting.id]);
  t.cleanup();
});

test("clear done needs no confirmation and keeps everything else", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path, execute: async () => OK });
  await queue.enqueue({ ...target, prompt: "a", dueAt: T0 });
  await queue.processQueue();
  await queue.enqueue({ sessionKey: "agent:main:z", agentId: "main", prompt: "b", dueAt: T0 + 9_999_999 });
  assert.match(await run(queue, "clear done"), /Removed 1/);
  assert.equal(queue.state.items.length, 1);
  assert.equal(queue.state.items[0].status, "waiting");
  t.cleanup();
});

test("clear rejects ids that are unknown, malformed or ambiguous", async () => {
  const { t, queue } = await seeded();
  assert.match(await run(queue, "clear ffff --confirm"), /No item matches/);
  assert.match(await run(queue, "clear agent:main:main --confirm"), /not an item id/);
  assert.match(await run(queue, "clear ab --confirm"), /not an item id/);
  assert.equal(queue.state.items.length, 2);
  t.cleanup();
});

test("clear never removes the running item", async () => {
  const t = tempDir();
  const gate = deferred<RunResult>();
  const { queue } = makeQueue({ path: t.path, execute: () => gate.promise });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  const running = queue.processQueue();
  await new Promise(r => setTimeout(r, 30));
  const id = queue.state.items[0].id.slice(0, 8);
  assert.match(await run(queue, `clear ${id} --confirm`), /running and cannot be cleared/);
  await run(queue, "clear all --confirm");
  assert.equal(queue.state.items.length, 1);
  gate.resolve(OK);
  await running;
  t.cleanup();
});

test("retry with bad syntax explains the usage", async () => {
  const { t, queue } = await seeded();
  assert.match(await run(queue, "retry"), /Usage: \/claude-quota retry/);
  assert.match(await run(queue, "retry abcd"), /Usage: \/claude-quota retry/);
  assert.match(await run(queue, `retry abcd ${FUTURE} extra`), /Usage: \/claude-quota retry/);
  t.cleanup();
});

test("retry takes an item id, not a session key", async () => {
  const { t, queue } = await seeded();
  assert.match(await run(queue, `retry agent:main:main ${FUTURE}`), /not a session key/);
  assert.equal(queue.state.items[0].status, "manual");
  t.cleanup();
});

test("retry rejects malformed, zone-less, past and too-distant timestamps", async () => {
  const { t, queue, manual } = await seeded();
  const id = manual.id.slice(0, 8);
  assert.match(await run(queue, `retry ${id} tomorrow`), /Invalid time/);
  assert.match(await run(queue, `retry ${id} 2026-10-13T09:00:00`), /Invalid time/, "an explicit zone is required");
  assert.match(await run(queue, `retry ${id} 2026-11-31T09:00:00Z`), /Invalid time/);
  assert.match(await run(queue, `retry ${id} ${new Date(T0 - 1000).toISOString()}`), /in the past/);
  assert.match(await run(queue, `retry ${id} ${new Date(T0 + MAX_MANUAL_RETRY_AHEAD_MS + 86_400_000).toISOString()}`), /more than 30 days/);
  assert.equal(queue.state.items[0].status, "manual");
  t.cleanup();
});

test("retry only works on manual-review items", async () => {
  const { t, queue, waiting } = await seeded();
  assert.match(await run(queue, `retry ${waiting.id.slice(0, 8)} ${FUTURE}`), /only manual-review items/);
  t.cleanup();
});

test("a manual item that still holds its prompt can be re-queued, and does not run by itself", async () => {
  const { t, queue, manual, calls } = await seeded();
  const out = await run(queue, `retry ${manual.id.slice(0, 8)} ${FUTURE}`);
  assert.match(out, /re-queued/);
  assert.equal(queue.state.items[0].status, "waiting");
  assert.equal(queue.state.items[0].attempts, 0);
  assert.equal(queue.state.items[0].nextAttemptAt, T0 + 3_600_000);
  assert.equal(calls.length, 0, "commands never execute the agent");
  await queue.stop();
  t.cleanup();
});

test("a promptless item cannot be retried without the original request", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  const { item } = await queue.enqueue({ ...target, dueAt: T0 });
  const out = await run(queue, `retry ${item.id.slice(0, 8)} ${FUTURE}`);
  assert.match(out, /has no stored prompt/);
  assert.equal(queue.state.items[0].status, "manual");
  assert.equal(queue.state.items[0].prompt, undefined);
  await queue.processQueue();
  assert.equal(calls.length, 0, "a promptless retry never becomes runnable");
  t.cleanup();
});

test("an operator can supply the exact original prompt after --", async () => {
  const t = tempDir();
  const { queue, calls } = makeQueue({ path: t.path });
  const { item } = await queue.enqueue({ ...target, dueAt: T0 });
  const out = await run(queue, `retry ${item.id.slice(0, 8)} ${FUTURE} -- please re-run this -- with dashes`);
  assert.match(out, /re-queued/);
  assert.equal(queue.state.items[0].prompt, "please re-run this -- with dashes");
  assert.ok(!out.includes("please re-run"), "command output never echoes the prompt");
  assert.equal(queue.state.items[0].status, "waiting");
  assert.equal(calls.length, 0);
  await queue.stop();
  t.cleanup();
});

test("a supplied prompt is validated: empty, oversized, chat-command, or replacing an existing one", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path });
  const { item } = await queue.enqueue({ ...target, dueAt: T0 });
  const id = item.id.slice(0, 8);
  assert.match(await run(queue, `retry ${id} ${FUTURE} --`), /empty/);
  assert.match(await run(queue, `retry ${id} ${FUTURE} -- ${"x".repeat(MAX_PROMPT_LENGTH + 1)}`), /longer than/);
  assert.match(await run(queue, `retry ${id} ${FUTURE} -- /new`), /chat command/);
  assert.equal(queue.state.items[0].status, "manual");
  const { t: t2, queue: q2, manual } = await seeded();
  assert.match(await run(q2, `retry ${manual.id.slice(0, 8)} ${FUTURE} -- replacement`), /already holds its original prompt/);
  t.cleanup(); t2.cleanup();
});

test("an ambiguous or interrupted item needs explicit --confirm before it can be replayed", async () => {
  const t = tempDir();
  const { queue } = makeQueue({ path: t.path, execute: async () => ({ code: null, timedOut: true, output: "" }) });
  await queue.enqueue({ ...target, prompt: "p", dueAt: T0 });
  await queue.processQueue();
  const id = queue.state.items[0].id.slice(0, 8);
  const refused = await run(queue, `retry ${id} ${FUTURE}`);
  assert.match(refused, /may already have run/);
  assert.equal(queue.state.items[0].status, "manual");
  assert.match(await run(queue, `retry ${id} ${FUTURE} --confirm`), /re-queued/);
  assert.equal(queue.state.items[0].status, "waiting");
  await queue.stop();
  t.cleanup();
});

test("unknown subcommands return help and change nothing", async () => {
  const { t, queue } = await seeded();
  assert.match(await run(queue, "explode"), /Claude quota queue commands/);
  assert.match(await run(queue, "help"), /Claude quota queue commands/);
  assert.equal(queue.state.items.length, 2);
  t.cleanup();
});

test("a persistence failure is reported, not hidden, and not applied", async () => {
  const fs = await import("node:fs");
  const { dirname } = await import("node:path");
  const { t, queue, manual } = await seeded();
  fs.rmSync(dirname(t.path), { recursive: true, force: true });
  fs.writeFileSync(dirname(t.path), "x");
  assert.match(await run(queue, `clear ${manual.id.slice(0, 8)} --confirm`), /failed and was not applied/);
  assert.equal(queue.state.items.length, 2, "in-memory state rolled back");
  t.cleanup();
});

test("no command ever starts an agent run", async () => {
  const { t, queue, manual, calls } = await seeded();
  for (const cmd of ["status", "pause", "resume", "help", `retry ${manual.id.slice(0, 8)} ${FUTURE}`, "clear done"]) await run(queue, cmd);
  assert.equal(calls.length, 0);
  await queue.stop();
  t.cleanup();
});
