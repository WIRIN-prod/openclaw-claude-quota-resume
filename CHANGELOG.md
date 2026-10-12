# Changelog

## 0.4.0 - 2026-10-13

Nothing here has been verified against a real quota reset.

### Safety

- Ambiguous outcomes (timeout, signal, error after the process started, a throwing launcher) now go to manual
  review and are never replayed automatically. Only a confirmed Claude quota rejection is retried.
- The `running` state is made durable before the agent starts. If it cannot be written, nothing runs.
- An item left `running` by a crash or restart becomes manual `interrupted` instead of being replayed.
- Prompts are passed through a private `0600` file (`--message-file`), never on the command line.
- Prompts and CLI output are no longer written to logs or stored in diagnostics.
- A prompt over 100,000 characters is sent to manual review instead of being truncated and replayed.
- Session keys and agent ids are validated before they reach the CLI.
- `agent_end` only treats the error field and the last assistant message as failure text, so quoted user text
  cannot trigger a queue entry. Plain API rate limits and other providers' limits are not treated as quota exhaustion.
- A completed turn invalidates the cached prompt; cached prompts are matched by session and run id and expire
  after 30 minutes.

### Queue and persistence

- Queue schema v3 with validation of every item and an explicit, backed-up migration from v1/v2.
- Atomic writes (temp file, fsync, rename); corrupt or newer-schema files are backed up and never overwritten.
- All state changes are serialized; a failed write rolls back the in-memory state and never leaves the worker locked.
- Duplicate failure deliveries (same run id or same prompt) queue one item. Retries are ordered deterministically.
- `gateway_start` loads the queue but never replays immediately; `gateway_stop` cancels timers and blocks new work.
- Fixed: the first scheduled retry used the raw reset time, while later retries added the 60 second buffer.
  Both now use the same computation.

### Commands

- `retry` now takes an item id, requires an ISO-8601 time with an explicit zone, and rejects past times, times more than
  30 days out, and impossible dates such as `2026-11-31`.
- `retry` never creates a runnable item without the original prompt; the operator supplies it after `--`.
  Ambiguous or interrupted items additionally need `--confirm`.
- `clear` takes `done`, an id, `manual` or `all`; everything except `done` needs `--confirm`; running items are never removed.
- `status` shows prompt lengths only.

### Packaging and documentation

- Source split into testable modules under `src/`; `index.ts` is the thin entry point.
- Compatibility metadata aligned with the documented format: `minGatewayVersion` is a bare version, and the manifest declares one
  catalog category (`infrastructure`) and `activation.onStartup`.
- Added `engines`, `typecheck`, `prepack`, and `maxAttempts` config.
- Behavioral test suite (queue, outcome, commands, hooks, runner, persistence) replacing metadata-only tests.
- README rewritten with delivery guarantees, the manual-review workflow, security notes and known limitations.

### Deprecated

- `defaultSessionKey` and `retryOnUnknownFailure` are ignored (a warning is logged).

## 0.3.1

- Improve recursive quota-error inspection.
- Improve missing-prompt safeguards.
- Improve reset-time parsing.
- Prepare public package documentation.

End-to-end execution at an actual subscription reset has not been verified.
