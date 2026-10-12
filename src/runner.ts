import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunJob, RunResult } from "./types.ts";

export type CliRunnerOptions = {
  /** Directory for private prompt files (created 0700). */
  tmpDir: string;
  /** Executable to run; defaults to `openclaw`. Injectable for tests. */
  command?: string;
  timeoutMs?: number;
  killGraceMs?: number;
};

/**
 * Runs `openclaw agent` for one queued request. The prompt is passed through a private
 * 0600 file (`--message-file`) so it never appears in the process list or argv.
 */
export function createCliRunner(opts: CliRunnerOptions): (job: RunJob) => Promise<RunResult> {
  const command = opts.command ?? "openclaw";
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const killGraceMs = opts.killGraceMs ?? 3000;
  return async (job) => {
    await mkdir(opts.tmpDir, { recursive: true, mode: 0o700 });
    const file = join(opts.tmpDir, `prompt-${randomUUID()}.txt`);
    await writeFile(file, job.prompt, { encoding: "utf8", mode: 0o600 });
    try {
      return await new Promise<RunResult>(resolve => {
        const args = ["agent", "--session-key", job.sessionKey, "--agent", job.agentId, "--message-file", file, "--json"];
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
        let output = "";
        let timedOut = false;
        let settled = false;
        const append = (chunk: unknown) => { output += String(chunk); if (output.length > 100_000) output = output.slice(-100_000); };
        child.stdout.on("data", append); child.stderr.on("data", append);
        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
        }, timeoutMs);
        killTimer.unref();
        const finish = (r: RunResult) => { if (settled) return; settled = true; clearTimeout(killTimer); resolve(r); };
        child.on("error", (e: NodeJS.ErrnoException) => {
          finish({ code: null, timedOut, spawnError: { code: e.code, name: e.name }, output });
        });
        child.on("close", (code, signal) => finish({ code, signal, timedOut, output }));
      });
    } finally {
      await unlink(file).catch(() => undefined);
    }
  };
}
