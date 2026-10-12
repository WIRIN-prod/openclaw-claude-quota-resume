import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, RunJob, RunResult } from "../src/types.ts";
import { QuotaQueue } from "../src/queue.ts";

export const T0 = Date.parse("2026-10-13T00:00:00Z");
export const SECRET = "TOP-SECRET-PROMPT-MARKER-7f3a";

export function tempDir(): { dir: string; path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "qrs-test-"));
  return { dir, path: join(dir, "state", "queue.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (m: string) => { lines.push(`${level}: ${m}`); };
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

export const OK: RunResult = { code: 0, timedOut: false, output: '{"ok":true}' };
export const QUOTA: RunResult = {
  code: 1, timedOut: false,
  output: "You've hit your session limit · resets 3am (Asia/Calcutta)",
};
export const FAIL: RunResult = { code: 1, timedOut: false, output: "something exploded" };

export function fakeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}

export function makeQueue(opts: {
  path: string;
  execute?: (job: RunJob) => Promise<RunResult>;
  now?: () => number;
  maxAttempts?: number;
  initialRetryMs?: number;
  logger?: Logger;
}) {
  const logger = opts.logger ?? recordingLogger();
  const calls: RunJob[] = [];
  const execute = opts.execute ?? (async () => OK);
  const queue = new QuotaQueue({
    path: opts.path, logger,
    execute: async (job) => { calls.push(job); return execute(job); },
    initialRetryMs: opts.initialRetryMs ?? 60_000,
    maxAttempts: opts.maxAttempts ?? 3,
    now: opts.now ?? (() => T0),
  });
  return { queue, calls, logger };
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
