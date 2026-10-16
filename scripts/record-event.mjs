import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const allowed = new Set([
  "rate_limit",
  "quota_auto_resume_fired",
  "quota_auto_resume_stale",
  "quota_auto_resume_disabled",
]);

try {
  const input = JSON.parse(await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  }));
  const event = input.hook_event_name === "StopFailure" ? input.error : input.notification_type;
  if (!allowed.has(event)) process.exit(0);

  const dir = join(homedir(), ".claude", "state", "claude-quota-resume");
  const path = join(dir, "last-event.json");
  const temp = `${path}.${process.pid}.tmp`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const record = {
    event,
    at: new Date().toISOString(),
  };
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
} catch {
  // Hooks must not interrupt the Claude Code session if local status recording fails.
  process.exitCode = 0;
}
