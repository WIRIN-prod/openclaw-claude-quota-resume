import type { Item, RunResult } from "./types.ts";
import { MAX_RESET_WAIT_MS, MAX_RETRY_MS, RESET_BUFFER_MS } from "./types.ts";
import { quotaError, resetTimeFrom } from "./detect.ts";

export type OutcomeKind = "done" | "quota" | "failure" | "ambiguous" | "not-started";

/**
 * Classification contract (see README "Delivery guarantees"):
 * - exit 0 is a completed turn, whatever the text says;
 * - a non-zero exit with Claude quota text is a confirmed quota failure;
 * - timeouts, signals and post-spawn errors are ambiguous (the agent may have run);
 * - a spawn failure (ENOENT/EACCES) means the CLI never started;
 * - any other non-zero exit is a non-quota failure.
 */
export function classifyRun(r: RunResult): OutcomeKind {
  if (r.spawnError) return r.spawnError.code === "ENOENT" || r.spawnError.code === "EACCES" ? "not-started" : "ambiguous";
  if (r.timedOut || r.code === null) return "ambiguous";
  if (r.code === 0) return "done";
  return quotaError(r.output) ? "quota" : "failure";
}

export function backoffMs(attempts: number, initialMs: number): number {
  return Math.min(MAX_RETRY_MS, initialMs * 2 ** Math.min(attempts, 8));
}

/**
 * When to retry: the parsed reset time plus a safety buffer (capped), or `fallbackAt` when the
 * text carries no usable reset time. Shared by the first schedule and every later retry.
 */
export function dueAtFromReset(text: unknown, fallbackAt: number, now: number): number {
  const resetAt = resetTimeFrom(text, fallbackAt, now);
  return resetAt === fallbackAt ? fallbackAt : Math.min(resetAt + RESET_BUFFER_MS, now + MAX_RESET_WAIT_MS);
}

/** Applies a run result to an item in place. Never copies CLI output into the item. */
export function applyOutcome(
  item: Item, result: RunResult, opts: { now: number; initialRetryMs: number; maxAttempts: number },
): OutcomeKind {
  const kind = classifyRun(result);
  switch (kind) {
    case "done":
      item.status = "done";
      delete item.prompt; // completed work no longer needs its prompt on disk
      delete item.manualReason;
      delete item.lastError;
      break;
    case "quota": {
      item.attempts++;
      if (item.attempts >= opts.maxAttempts) {
        item.status = "manual"; item.manualReason = "max-attempts";
        item.lastError = `Claude quota still exhausted after ${item.attempts} attempts; manual review required.`;
        break;
      }
      const backoffAt = opts.now + backoffMs(item.attempts, opts.initialRetryMs);
      item.status = "waiting"; item.nextAttemptAt = dueAtFromReset(result.output, backoffAt, opts.now);
      delete item.manualReason;
      item.lastError = "Claude subscription quota still exhausted; retry scheduled.";
      break;
    }
    case "not-started":
      item.status = "manual"; item.manualReason = "non-quota-failure";
      item.lastError = `Could not start the openclaw CLI (${result.spawnError?.code}); the request did not run.`;
      break;
    case "ambiguous": {
      item.status = "manual"; item.manualReason = "ambiguous-execution";
      const why = result.timedOut ? "timed out" : result.signal ? `was terminated by ${result.signal}` : "ended abnormally";
      item.lastError = `Agent process ${why}; the request may have partly or fully executed. Automatic replay blocked.`;
      break;
    }
    case "failure":
      item.status = "manual"; item.manualReason = "non-quota-failure";
      item.lastError = `openclaw agent exited with code ${result.code} (not a recognised Claude quota error).`;
      break;
  }
  return kind;
}
