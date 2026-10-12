import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliRunner } from "../src/runner.ts";
import { SECRET, tempDir } from "./helpers.ts";

/** Writes a fake `openclaw` executable. These tests never run the real CLI or any real agent. */
function fakeCli(dir: string, body: string): string {
  const file = join(dir, "fake-openclaw.sh");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const job = { sessionKey: "agent:main:main", agentId: "main", prompt: `multi\nline ${SECRET}` };

test("the prompt travels in a private temp file, never in argv, and the file is removed afterwards", async () => {
  const t = tempDir();
  const argvFile = join(t.dir, "argv.txt");
  const copy = join(t.dir, "message-copy.txt");
  const cmd = fakeCli(t.dir, `printf '%s\\n' "$@" > "${argvFile}"
while [ $# -gt 0 ]; do [ "$1" = "--message-file" ] && { cp "$2" "${copy}"; stat -c %a "$2" > "${t.dir}/mode.txt"; }; shift; done
echo '{"ok":true}'`);
  const run = createCliRunner({ tmpDir: join(t.dir, "tmp"), command: cmd });
  const result = await run(job);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  const argv = readFileSync(argvFile, "utf8");
  assert.ok(!argv.includes(SECRET), "prompt must not appear on the command line");
  assert.deepEqual(argv.trim().split("\n").filter((_, i) => i < 6), ["agent", "--session-key", "agent:main:main", "--agent", "main", "--message-file"]);
  assert.ok(argv.includes("--json"));
  assert.equal(readFileSync(copy, "utf8"), job.prompt, "exact multi-line prompt is delivered unchanged");
  assert.equal(readFileSync(join(t.dir, "mode.txt"), "utf8").trim(), "600");
  assert.equal(statSync(join(t.dir, "tmp")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(t.dir, "tmp")), [], "no prompt file is left behind");
  t.cleanup();
});

test("a non-zero exit returns the code and combined output for classification", async () => {
  const t = tempDir();
  const cmd = fakeCli(t.dir, `echo "out line"; echo "You've hit your session limit · resets 3am (Asia/Calcutta)" >&2; exit 1`);
  const result = await createCliRunner({ tmpDir: join(t.dir, "tmp"), command: cmd })(job);
  assert.equal(result.code, 1);
  assert.match(result.output, /out line/);
  assert.match(result.output, /session limit/);
  t.cleanup();
});

test("a hung process is terminated and reported as timed out", async () => {
  const t = tempDir();
  const cmd = fakeCli(t.dir, "exec sleep 30");
  const started = Date.now();
  const result = await createCliRunner({ tmpDir: join(t.dir, "tmp"), command: cmd, timeoutMs: 200, killGraceMs: 100 })(job);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(readdirSync(join(t.dir, "tmp")), []);
  t.cleanup();
});

test("a missing executable is reported as a spawn error (the request never ran)", async () => {
  const t = tempDir();
  const result = await createCliRunner({ tmpDir: join(t.dir, "tmp"), command: join(t.dir, "does-not-exist") })(job);
  assert.equal(result.spawnError?.code, "ENOENT");
  assert.equal(result.code, null);
  assert.ok(!existsSync(join(t.dir, "tmp", "prompt-x")));
  assert.deepEqual(readdirSync(join(t.dir, "tmp")), []);
  t.cleanup();
});

test("output is bounded", async () => {
  const t = tempDir();
  const cmd = fakeCli(t.dir, `i=0; while [ $i -lt 400 ]; do printf '%0500d\\n' 0; i=$((i+1)); done`);
  const result = await createCliRunner({ tmpDir: join(t.dir, "tmp"), command: cmd })(job);
  assert.ok(result.output.length <= 100_000);
  t.cleanup();
});
