# OpenClaw Claude Quota Resume

An OpenClaw plugin that remembers the original request when a Claude **subscription usage limit**
stops an agent run, and re-runs that request after the limit resets.

It does not bypass or extend Claude limits. A retry is just the same request sent again later.

> **Read [Delivery guarantees](#delivery-guarantees) and [Security and privacy](#security-and-privacy)
> before using this unattended.** Replaying a request can repeat its side effects, and the queue
> stores your prompts on disk.

## Requirements

- OpenClaw `2026.9.9` or newer (the version this plugin was built and checked against; older
  versions were not tested and are not claimed to work).
- Node.js `>=24.16.0 <25` or `>=26.1.0` (the same range OpenClaw requires).
- The `openclaw` CLI on the Gateway host's `PATH`. Retries are executed with `openclaw agent`.
- Conversation-hook permission: the plugin reads agent and message events, so OpenClaw requires
  `plugins.entries.claude-quota-resume.hooks.allowConversationAccess: true` for a non-bundled plugin.
  This plugin does not change configuration itself.

## Installation

From a checkout (review the source and manifest first):

```bash
git clone https://github.com/WIRIN-prod/openclaw-claude-quota-resume.git
cd openclaw-claude-quota-resume
npm ci
npm run build          # produces dist/index.js, the entry point OpenClaw loads
```

Then install it with the plugin install procedure documented for your OpenClaw version (for local
development, `openclaw plugins install --link <path>`), and grant conversation access as described
above. The install steps themselves are OpenClaw's, not this repository's, and are not exercised by
this repository's test suite.

OpenClaw may warn that it cannot verify where a locally installed plugin came from. That is a
provenance notice about the install source. Do not silence it by weakening plugin security
settings; installing from a published package or ClawHub listing is what makes the source verifiable.

## Configuration

Set under `plugins.entries.claude-quota-resume.config`. All options are optional.

| Option | Default | Meaning |
| --- | --- | --- |
| `statePath` | `~/.openclaw/state/claude-quota-resume/queue.json` | Queue file. Its directory is created `0700` and the file `0600`. |
| `initialRetryMs` | `300000` (5 min) | Fallback delay when the error carries no reset time. Doubles per attempt, capped at 1 hour. Range 1,000 to 3,600,000. |
| `maxAttempts` | `50` | Quota retries before the item goes to manual review. Range 1 to 1000. |
| `defaultSessionKey`, `retryOnUnknownFailure` | none | **Deprecated and ignored** (a warning is logged). Sessions come from the failing run, and non-quota failures always go to manual review. |

## How it works

1. `message_received` caches the latest user message per session in memory (30 minutes, 500 sessions).
   Chat commands such as `/status` or `/claude-quota ...` are never cached.
2. `agent_end` with `success: false` is inspected. Only the `error` field and the **last assistant
   message** are examined, never user text, and only a conservative Claude quota pattern counts (see below).
3. The original prompt is recovered from the cached message (same session, under 30 minutes old, same
   run id when both are known), otherwise from a user message inside the failing event.
4. The item is stored and a timer retries it at the reset time (plus a 60 second buffer, at most 26
   hours ahead) or after the fallback delay.
5. When due, the worker runs one item at a time:
   `openclaw agent --session-key <key> --agent <id> --message-file <private temp file> --json`.
   The prompt travels in a `0600` file, never on the command line, and the file is deleted afterwards.

### What counts as a Claude quota error

A limit phrase (`you've hit your ... limit`, `session/usage/weekly/5-hour limit`, `quota exceeded`) **and**
Claude, Anthropic or subscription context, or a `resets 3am` style hint. Plain API rate limits
(`rate_limit_error`, HTTP 429), other providers' limits, and generic failures are **not** queued.

### Run outcomes

| Result of the replayed run | Treated as | Item becomes |
| --- | --- | --- |
| Exit 0 | Completed | `done` (prompt removed from the file) |
| Non-zero exit with Claude quota text | Confirmed quota failure | `waiting` again, until `maxAttempts`, then `manual` (`max-attempts`) |
| Any other non-zero exit | Non-quota failure | `manual` (`non-quota-failure`) |
| Timeout, killed by signal, error after the process started, or the launcher itself threw | **Ambiguous**: the request may have run | `manual` (`ambiguous-execution`), **never replayed automatically** |
| `openclaw` could not be started (`ENOENT`/`EACCES`) | Did not run | `manual` (`non-quota-failure`) |
| Gateway stopped while the item was `running` | Ambiguous | `manual` (`interrupted`) on next load |

The `running` state is written to disk **before** the agent is started. If that write fails, nothing is
run and the item stays `waiting`.

## Commands

`/claude-quota` (OpenClaw restricts plugin commands to authorized senders by default).

| Command | Behavior |
| --- | --- |
| `status` | Counts, and per item: short id, status, reason, session key, attempts, next attempt, **prompt length only**. Never prints a prompt. Shows the first 25 items. |
| `pause` / `resume` | Persisted. While paused nothing starts; a run already in flight finishes. |
| `clear done` | Removes completed items. No confirmation needed. |
| `clear <id> --confirm` | Removes that item. Without `--confirm` it only reports what it would remove. |
| `clear manual --confirm` / `clear all --confirm` | Same, for all manual-review items or all items. Waiting items survive `clear manual`. |
| `retry <id> <time> [--confirm] [-- <prompt>]` | Re-queues a **manual-review** item. See below. |
| `help` | Syntax summary. |

`<id>` is the first 4 or more characters of the id shown by `status`. A running item is never cleared.
`<time>` is ISO-8601 **with an explicit zone**, in the future and within 30 days, for example
`2026-10-14T09:00:00+05:30`. Impossible dates such as `2026-11-31` are rejected.

### Manual review

Items land in manual review when the plugin cannot safely decide for you: the prompt could not be
recovered (`missing-prompt`), it is over the 100,000 character limit (`prompt-too-long`, never truncated),
the failure was not a quota error, the run was ambiguous or interrupted, or retries ran out.
Nothing in manual review ever runs by itself. Review the item, then re-queue it:

- **The item still holds its prompt:** `retry <id> <time>`.
- **The item has no prompt:** you must supply the exact original request after `--`:
  `retry <id> <time> -- <exact original request>`. The command refuses to create a runnable item
  without a prompt, and refuses to replace a prompt that is already stored. Command output never echoes
  the prompt. Note that the text you type is part of your chat history and any shell history if you
  use a terminal client; avoid it for sensitive requests.
- **The item was `ambiguous-execution` or `interrupted`:** the request may already have run. Check the
  side effects first, then add `--confirm`.

## Delivery guarantees

- There is **no exactly-once guarantee**. `openclaw agent` offers no idempotency key, so the plugin cannot
  tell whether a request that timed out or lost its process actually executed.
- The plugin chooses **at-most-once for anything ambiguous** (manual review) and retries automatically
  **only** after a confirmed Claude quota rejection.
- A run that finishes but whose `done` state cannot be written is left `running` on disk and is moved to
  manual review after a restart; it is not replayed.
- Replays run without `--deliver`, so the answer is recorded in the session but is not sent back to the
  originating chat channel. This is the behavior of the command as invoked; it has not been verified
  end to end against a real quota reset.
- End-to-end execution at a real subscription reset has not been verified. The behavior above is covered
  by unit and mocked integration tests (below), not by a live quota event.

## Security and privacy

- Prompts are stored in plain text in the queue file until the item is `done` (then removed). Treat the
  file like the conversation itself. It is not encrypted. Never publish it, back it up somewhere shared,
  or attach it to bug reports. Backups made on migration or corruption (`queue.json.corrupt-*`,
  `queue.json.premigration-*`) contain prompts too.
- Prompts and CLI output are never written to logs or to the `lastError` field. Logs use a short id only.
- A stale prompt replayed hours later may no longer make sense or may be unwanted. Use `pause`/`clear`
  freely, and review `status` before leaving a queue unattended.
- Session keys and agent ids are validated before they reach the command line, and the CLI is started
  without a shell.
- Queue updates are atomic (temp file, fsync, rename). A corrupt or newer-schema file is backed up and not
  overwritten; the queue then starts empty and the error is logged.

## Queue file

Schema version 3. Version 1 and 2 files are migrated on first load after a backup is written; items that
were `running` become manual `interrupted`, and long legacy diagnostics are redacted in the live file.
Fields per item: `id`, `sessionKey`, `agentId`, `prompt` (until done), `promptChars`, `createdAt`,
`nextAttemptAt`, `attempts`, `status` (`waiting` | `running` | `done` | `manual`), `manualReason`,
`lastError` (sanitized), `runId`.

## Known limitations

- Reset times are parsed from text of the form `resets 3am (Asia/Calcutta)`. Other formats fall back to
  the configured delay.
- The prompt cache is in memory. If the Gateway restarts between the user's message and the failure, the
  prompt may be unrecoverable and the item goes to manual review.
- Only the latest message per session is cached, so a failure after several quick messages replays the last one.
- One worker, one Gateway. There is no cross-process locking; do not point two Gateways at the same `statePath`.
- Compatibility was checked against OpenClaw `2026.9.9` only.

## Troubleshooting

- **Nothing is ever queued:** confirm `hooks.allowConversationAccess` is `true` for this plugin, and that the
  failing text really matches a Claude quota error (`agent_end` must report `success: false`).
- **Items go straight to manual review (`missing-prompt`):** the user message was not cached (restart,
  more than 30 minutes, or a slash command). Use `retry <id> <time> -- <prompt>`.
- **`non-quota-failure` after `openclaw` could not be started:** make sure `openclaw` is on the Gateway's `PATH`.
- **"Queue persistence failed" in the log:** check disk space and permissions on the `statePath` directory.
  While writes fail the plugin refuses to start runs.

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # builds dist/index.js, then runs the Node test runner
npm run build       # dist/index.js only
npm pack --dry-run  # inspect what would be published
```

`.npmrc` sets `legacy-peer-deps=true` so development installs do not pull in the whole host `openclaw` package (a
peer dependency the Gateway provides at runtime). It is not part of the published package, and `npm ci` needs it to
match the committed lockfile.

Layout: `index.ts` (entry), `src/detect.ts` (quota detection, reset parsing), `src/prompt.ts` (prompt recovery
and validation), `src/store.ts` (atomic persistence, migration), `src/queue.ts` (worker and lifecycle),
`src/outcome.ts` (result classification), `src/runner.ts` (CLI launcher), `src/commands.ts`,
`src/plugin.ts` (hook wiring).

Test coverage, by kind:

- **Unit tests:** detection, reset parsing, prompt recovery, persistence and migration, outcome classification,
  command parsing, config parsing.
- **Mocked integration tests:** the queue worker, hooks and commands against a fake OpenClaw API and fake
  executors, using isolated temp directories; the runner against a fake `openclaw` shell script.
- **Not covered:** a real Gateway, a real `openclaw agent` run, and a real quota reset.

Tests never touch `~/.openclaw` and never start a real agent.

### Release preparation

Do not publish without authorization. When approved, from a clean checkout of the release commit:

```bash
npm ci && npm run typecheck && npm test && npm pack --dry-run
npm version <patch|minor> --no-git-tag-version   # then update manifest "version" and CHANGELOG
npm publish --access public                      # npm
# ClawHub publication follows ClawHub's current publishing instructions.
```

The manifest `version` must equal the package version (a test enforces this).

## Licence

MIT. See [LICENSE](LICENSE).
