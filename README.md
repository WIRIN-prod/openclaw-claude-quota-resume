# OpenClaw Claude Quota Resume

An OpenClaw extension that queues an agent's original request when a Claude
subscription session limit is detected and schedules a retry for the reported
reset time.

## Features

- Detects supported Claude session-limit messages.
- Persists queued requests locally.
- Schedules retries using the detected reset time.
- Provides the `/claude-quota` queue-management command.
- Blocks automatic replay when the original prompt is missing.

## Installation

Review the source and manifest before installing.

```bash
git clone https://github.com/WIRIN-prod/openclaw-claude-quota-resume.git
cd openclaw-claude-quota-resume
```

Follow the plugin installation procedure documented for your installed
OpenClaw version. Cloning the repository alone does not activate the plugin.

## Commands

The extension registers `/claude-quota`. Actions include `status`,
`pause`, `resume`, `clear`, and `retry`. Check the installed extension
for the exact syntax supported by your version.

## Safety and limitations

- This does not bypass Claude subscription limits or provide extra usage.
- A scheduled retry does not guarantee quota availability or success.
- Retried prompts can repeat actions; review queued work before unattended use.
- Never fabricate missing original prompts.
- End-to-end execution at an actual quota reset has not been verified.
- Prompts may contain sensitive data. Never publish queue files, session
  databases, credentials, or private logs.

## Development

The entry point is `index.ts`. Test quota classification, reset parsing,
persistence, duplicate prevention, gateway restart behavior, missing-prompt
handling, and actual retry execution before production use.

## Licence

MIT. See [LICENSE](LICENSE).
