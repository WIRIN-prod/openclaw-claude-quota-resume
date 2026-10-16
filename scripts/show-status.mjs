import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  const data = JSON.parse(await readFile(join(homedir(), ".claude", "state", "claude-quota-resume", "last-event.json"), "utf8"));
  const time = new Date(data.at).toLocaleString();
  if (data.event === "quota_auto_resume_fired") console.log(`Claude Code automatically resumed after the usage limit reset (${time}).`);
  else if (data.event === "quota_auto_resume_stale") console.log(`The usage limit reset while the computer was asleep. Claude Code is waiting for Enter (${time}).`);
  else if (data.event === "quota_auto_resume_disabled") console.log(`Claude Code ended the automatic wait without continuing (${time}). Check the session message and /config.`);
  else console.log(`A rate limit stopped this session (${time}). This may be an API or provider limit; the native subscription wait applies only to eligible claude.ai subscription sessions.`);
} catch {
  console.log("No quota or auto-resume event has been recorded yet. This plugin records events from Claude Code v2.1.234 and later.");
}
