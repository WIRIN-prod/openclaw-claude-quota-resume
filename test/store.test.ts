import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { backupFile, readState, writeState } from "../src/store.ts";
import { tempDir, SECRET } from "./helpers.ts";

const item = (over: Record<string, unknown> = {}) => ({
  id: "11111111-aaaa", sessionKey: "agent:main:main", agentId: "main", prompt: "do it",
  createdAt: "2026-10-12T00:00:00.000Z", nextAttemptAt: 1000, attempts: 0, status: "waiting", ...over,
});
const put = (path: string, doc: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc)); };

test("a missing queue file is a clean first run", async () => {
  const t = tempDir();
  const { state, report } = await readState(t.path);
  assert.deepEqual(state.items, []); assert.equal(report.missing, true); assert.equal(report.needsBackup, false);
  t.cleanup();
});

test("a valid v3 queue loads unchanged and needs no backup", async () => {
  const t = tempDir();
  put(t.path, { version: 3, paused: true, items: [item()] });
  const { state, report } = await readState(t.path);
  assert.equal(state.paused, true); assert.equal(state.items[0].status, "waiting"); assert.equal(state.items[0].prompt, "do it");
  assert.equal(report.needsBackup, false);
  t.cleanup();
});

test("truncated or invalid JSON is reported as corrupt, never treated as an empty valid queue silently", async () => {
  const t = tempDir();
  put(t.path, '{"version":3,"items":[{"id":"a","prompt":"' + SECRET);
  const { state, report } = await readState(t.path);
  assert.equal(report.corrupt, true); assert.equal(report.needsBackup, true); assert.deepEqual(state.items, []);
  put(t.path, "[1,2,3]");
  assert.equal((await readState(t.path)).report.corrupt, true);
  t.cleanup();
});

test("a queue written by a newer schema is not interpreted or overwritten blindly", async () => {
  const t = tempDir();
  put(t.path, { version: 99, items: [item()] });
  const { report } = await readState(t.path);
  assert.equal(report.corrupt, true); assert.equal(report.needsBackup, true);
  t.cleanup();
});

test("v2 -> v3 migration: running becomes manual 'interrupted', raw diagnostics are redacted, backup is requested", async () => {
  const t = tempDir();
  put(t.path, { version: 2, paused: false, items: [
    item({ id: "r1", status: "running" }),
    item({ id: "w1", status: "waiting", lastError: `line1\n${SECRET} raw cli output` }),
    item({ id: "d1", status: "done", prompt: SECRET }),
  ] });
  const { state, report } = await readState(t.path);
  const by = Object.fromEntries(state.items.map(i => [i.id, i]));
  assert.equal(by.r1.status, "manual"); assert.equal(by.r1.manualReason, "interrupted");
  assert.equal(by.w1.status, "waiting"); assert.doesNotMatch(by.w1.lastError ?? "", new RegExp(SECRET));
  assert.equal(by.d1.prompt, undefined);
  assert.equal(report.interrupted, 1); assert.equal(report.needsBackup, true); assert.equal(report.fromVersion, 2);
  t.cleanup();
});

test("valid entries survive alongside invalid ones; invalid ones are counted and force a backup", async () => {
  const t = tempDir();
  put(t.path, { version: 3, items: [item(), null, "junk", { id: 5 }, item({ id: "x2", status: "bogus" }), item({ id: "x3", nextAttemptAt: "soon" })] });
  const { state, report } = await readState(t.path);
  assert.equal(report.dropped, 3);
  assert.equal(state.items.find(i => i.id === "11111111-aaaa")?.status, "waiting");
  assert.equal(state.items.find(i => i.id === "x2")?.manualReason, "invalid-record");
  assert.equal(state.items.find(i => i.id === "x3")?.status, "manual");
  assert.equal(report.needsBackup, true);
  t.cleanup();
});

test("waiting items without a prompt are never runnable after load", async () => {
  const t = tempDir();
  put(t.path, { version: 3, items: [item({ prompt: undefined }), item({ id: "b", prompt: "   " })] });
  const { state } = await readState(t.path);
  assert.deepEqual(state.items.map(i => [i.status, i.manualReason]), [["manual", "missing-prompt"], ["manual", "missing-prompt"]]);
  t.cleanup();
});

test("writeState is atomic, private (0600/0700) and leaves no temp files", async () => {
  const t = tempDir();
  await writeState(t.path, { version: 3, paused: false, items: [] });
  assert.equal(statSync(t.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(t.path)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(t.path)), ["queue.json"]);
  t.cleanup();
});

test("overlapping writeState calls never corrupt the file", async () => {
  const t = tempDir();
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    writeState(t.path, { version: 3, paused: false, items: [item({ id: `id-${i}` })] as never })));
  const doc = JSON.parse(readFileSync(t.path, "utf8"));
  assert.equal(doc.items.length, 1);
  assert.deepEqual(readdirSync(dirname(t.path)), ["queue.json"]);
  t.cleanup();
});

test("backupFile copies with 0600", async () => {
  const t = tempDir();
  put(t.path, { version: 2, items: [] });
  const b = await backupFile(t.path, "premigration");
  assert.equal(statSync(b).mode & 0o777, 0o600);
  assert.equal(readFileSync(b, "utf8"), readFileSync(t.path, "utf8"));
  t.cleanup();
});
