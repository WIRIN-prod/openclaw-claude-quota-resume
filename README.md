# Claude Quota Resume for Claude Code

A Claude Code plugin that records subscription usage-limit events and shows whether Claude Code resumed,
is waiting for confirmation, or ended the wait.

Claude Code now has native usage-limit auto-continue. The plugin observes that feature; it does not replay
prompts, launch a second Claude process, or bypass usage limits. Auto-continue requires Claude Code
v2.1.234 or newer and an eligible interactive session authenticated with a claude.ai subscription.
API-key, cloud-provider, usage-billed, and background `-p` sessions do not get the subscription reset wait.

## Install for your user

In Claude Code CLI, add this GitHub repository as a marketplace and install the plugin:

```text
/plugin marketplace add WIRIN-prod/openclaw-claude-quota-resume
/plugin install quota-resume@wirin-claude-plugins
```

The CLI install scope defaults to `user`, so the plugin is available across your projects. To install from
the shell, use `claude plugin marketplace add WIRIN-prod/openclaw-claude-quota-resume` followed by
`claude plugin install quota-resume@wirin-claude-plugins`.

Enable Claude Code's native setting in the CLI with `/config` → **Continue automatically at usage limit**.
The plugin does not change this setting. Claude Code may still ask whether to wait when auto-continue is
off. Use `/quota-resume:setup` for setup guidance and `/quota-resume:status` to see the
latest event captured by the plugin.

## What it records

- `rate_limit` from Claude Code's `StopFailure` hook.
- `quota_auto_resume_fired`, `quota_auto_resume_stale`, and `quota_auto_resume_disabled` notifications.

The most recent event is saved to `~/.claude/state/claude-quota-resume/last-event.json`. The directory
is created with mode `0700` and the file with mode `0600`. The record contains an event name and timestamp;
it does not store prompts, transcript contents, session identifiers, or API error details. Recording
failures do not interrupt Claude Code. The hook records event statuses but does not alter Claude's
native behavior.

## Compatibility

The Claude Code plugin lives in `.claude-plugin/`, `hooks/`, `commands/`, and `scripts/`. Validate it with:

```sh
claude plugin validate .
```

The existing `src/` OpenClaw Gateway implementation remains available for OpenClaw users. Its npm package
metadata and OpenClaw manifest are retained for that integration; Claude Code users install through the
Git marketplace above.

## Privacy and safety

Usage-limit continuation runs inside the original Claude Code session and follows Claude Code's own
permissions. It may continue work unattended after the reset. Review your session's permission mode and
the setting in `/config` before enabling it. This plugin only stores a small local event record and never
retries work itself.

## License

MIT. See [LICENSE](LICENSE).
