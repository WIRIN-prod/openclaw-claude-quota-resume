import { randomUUID } from "node:crypto";
import type { Item, Logger, ManualReason, RunJob, RunResult, State } from "./types.ts";
import {
  MAX_PROMPT_LENGTH, MAX_TIMER_MS, MIN_TIMER_MS, PERSIST_FAILURE_BACKOFF_MS,
} from "./types.ts";
import { validAgentId, validSessionKey } from "./prompt.ts";
import { applyOutcome } from "./outcome.ts";
import { backupFile, emptyState, readState, writeState } from "./store.ts";

export type QueueOptions = {
  path: string;
  logger: Logger;
  /** Runs one request. Must never reject for ordinary failures; a rejection is treated as ambiguous. */
  execute: (job: RunJob) => Promise<RunResult>;
  initialRetryMs: number;
  maxAttempts: number;
  now?: () => number;
};

export type EnqueueInput = {
  sessionKey: string; agentId: string; prompt?: string; runId?: string; dueAt: number;
};

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? "Error";

/**
 * Single-Gateway persistent queue. All state changes run inside `serial()`, so persists never
 * interleave and the in-memory state always matches the last attempted write.
 */
export class QuotaQueue {
  state: State = emptyState();
  private readonly o: QueueOptions;
  private readonly now: () => number;
  private loading?: Promise<void>;
  private lock: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private busy = false;
  private notBefore = 0;

  constructor(options: QueueOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  get isBusy() { return this.busy; }

  // ---- lifecycle -------------------------------------------------------------------------

  /** Loads state once. Safe to call from every entry point. */
  ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.ensureLoaded();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    await this.lock.catch(() => undefined); // let queued writes finish
  }

  private async load(): Promise<void> {
    const { state, report } = await readState(this.o.path);
    this.state = state;
    const log = this.o.logger;
    if (report.corrupt) log.error("Queue file was unreadable or from a newer schema; it was backed up and the queue starts empty.");
    if (report.dropped) log.warn(`Queue file contained ${report.dropped} unusable entr${report.dropped === 1 ? "y" : "ies"}; originals kept in the backup.`);
    if (report.interrupted) log.warn(`${report.interrupted} item(s) were running when the Gateway stopped and need manual review.`);
    if (report.fromVersion !== undefined && report.fromVersion < 3 && !report.corrupt) log.info(`Migrated queue schema v${report.fromVersion} -> v3.`);
    if (report.needsBackup) {
      try { log.info(`Queue backup written: ${await backupFile(this.o.path, report.corrupt ? "corrupt" : "premigration")}`); }
      catch (e) {
        // Without a backup we must not overwrite the original file.
        log.error(`Could not back up the queue file (${errCode(e)}); leaving it untouched. Queue changes are refused until this is fixed.`);
        this.persistDisabled = true;
      }
    }
    if (!report.missing && !this.persistDisabled) {
      try { await writeState(this.o.path, this.state); }
      catch (e) { log.error(`Queue persistence failed on load (${errCode(e)}).`); }
    }
  }
  private persistDisabled = false;

  // ---- serialization & persistence --------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    if (this.persistDisabled) throw new Error("persistence disabled (queue file backup failed)");
    await writeState(this.o.path, this.state);
  }

  /** Mutate + persist; the in-memory state is rolled back if the write fails. */
  private mutate<T>(fn: (s: State) => T): Promise<T> {
    return this.serial(async () => {
      await this.ensureLoaded();
      const snapshot = structuredClone(this.state);
      try {
        const result = fn(this.state);
        await this.persist();
        return result;
      } catch (e) {
        this.state = snapshot;
        throw e;
      }
    });
  }

  // ---- scheduling --------------------------------------------------------------------------

  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  schedule(): void {
    this.clearTimer();
    if (this.stopping || this.state.paused) return;
    const waiting = this.state.items.filter(x => x.status === "waiting");
    if (!waiting.length) return;
    const due = Math.max(Math.min(...waiting.map(x => x.nextAttemptAt)), this.notBefore);
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, due - this.now()));
    this.timer = setTimeout(() => { void this.processQueue(); }, delay);
    this.timer.unref?.();
  }

  // ---- enqueue -----------------------------------------------------------------------------

  async enqueue(input: EnqueueInput): Promise<{ item: Item; duplicate: boolean }> {
    return this.mutate(s => {
      const prompt = input.prompt?.trim() ? input.prompt : undefined;
      const active = s.items.filter(x => x.status === "waiting" || x.status === "running");
      const dup = active.find(x =>
        (input.runId && x.runId === input.runId) ||
        (prompt && x.sessionKey === input.sessionKey && x.prompt === prompt));
      if (dup) return { item: dup, duplicate: true };

      let manualReason: ManualReason | undefined;
      let lastError: string | undefined;
      if (!prompt) {
        manualReason = "missing-prompt";
        lastError = "Quota failure detected, but the original prompt could not be recovered. Automatic replay is blocked.";
      } else if (prompt.length > MAX_PROMPT_LENGTH) {
        manualReason = "prompt-too-long";
        lastError = `Original prompt exceeds ${MAX_PROMPT_LENGTH} characters and was not stored; replaying a truncated request is blocked.`;
      }
      const item: Item = {
        id: randomUUID(), sessionKey: input.sessionKey, agentId: input.agentId,
        createdAt: new Date(this.now()).toISOString(), nextAttemptAt: input.dueAt, attempts: 0,
        status: manualReason ? "manual" : "waiting",
        lastError: lastError ?? "Claude subscription quota limit reached; retry scheduled.",
      };
      if (manualReason) item.manualReason = manualReason;
      if (prompt) item.promptChars = prompt.length;
      if (prompt && !manualReason) item.prompt = prompt;
      if (input.runId) item.runId = input.runId;
      s.items.push(item);
      return { item, duplicate: false };
    }).then(r => { this.schedule(); return r; });
  }

  // ---- worker ------------------------------------------------------------------------------

  /** Picks the next due item, marks it running and persists that BEFORE any execution. */
  private claimNext(): Promise<Item | undefined> {
    return this.mutate(s => {
      const now = this.now();
      const due = s.items
        .filter(x => x.status === "waiting" && x.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const item of due) {
        if (!item.prompt?.trim()) {
          item.status = "manual"; item.manualReason = "missing-prompt";
          item.lastError = "Original prompt is missing; automatic replay was blocked.";
          this.o.logger.error(`Blocked queued request ${item.id.slice(0, 8)}: original prompt missing.`);
          continue;
        }
        if (!validSessionKey(item.sessionKey) || !validAgentId(item.agentId)) {
          item.status = "manual"; item.manualReason = "invalid-target";
          item.lastError = "Session key or agent id is not valid; automatic replay was blocked.";
          this.o.logger.error(`Blocked queued request ${item.id.slice(0, 8)}: invalid session key or agent id.`);
          continue;
        }
        item.status = "running";
        return structuredClone(item);
      }
      return undefined;
    });
  }

  /** Processes at most one due item. Concurrent calls are no-ops while a run is in flight. */
  async processQueue(): Promise<void> {
    if (this.stopping || this.busy) return;
    this.busy = true;
    try {
      await this.ensureLoaded();
      if (this.stopping || this.state.paused) return;
      let claimed: Item | undefined;
      try { claimed = await this.claimNext(); }
      catch (e) {
        // "running" could not be made durable: do NOT execute (a crash would lose track of it).
        this.notBefore = this.now() + PERSIST_FAILURE_BACKOFF_MS;
        this.o.logger.error(`Queue persistence failed before execution (${errCode(e)}); item not run, will retry later.`);
        return;
      }
      if (!claimed) return;
      if (this.stopping || this.state.paused) {
        // Paused or shut down between claim and launch: nothing has executed yet, so hand it back.
        await this.unclaim(claimed.id);
        return;
      }

      let result: RunResult;
      try {
        result = await this.o.execute({ sessionKey: claimed.sessionKey, agentId: claimed.agentId, prompt: claimed.prompt! });
      } catch (e) {
        result = { code: null, timedOut: false, spawnError: { code: errCode(e), name: "ExecuteError" }, output: "" };
      }
      await this.record(claimed.id, result);
    } finally {
      this.busy = false;
      this.schedule(); // no-op when stopping or paused
    }
  }

  private async unclaim(id: string): Promise<void> {
    try {
      await this.mutate(s => {
        const item = s.items.find(x => x.id === id);
        if (item?.status === "running") item.status = "waiting";
      });
    } catch (e) {
      this.o.logger.error(`Could not release item ${id.slice(0, 8)} after pause/stop (${errCode(e)}); it will be reviewed manually after restart.`);
    }
  }

  private record(id: string, result: RunResult): Promise<void> {
    return this.serial(async () => {
      const item = this.state.items.find(x => x.id === id);
      if (!item) return;
      const kind = applyOutcome(item, result, { now: this.now(), initialRetryMs: this.o.initialRetryMs, maxAttempts: this.o.maxAttempts });
      const label = id.slice(0, 8);
      if (kind === "done") this.o.logger.info(`Completed queued request ${label}.`);
      else if (kind === "quota" && item.status === "waiting") this.o.logger.warn(`Claude quota still exhausted for ${label}; retry scheduled.`);
      else this.o.logger.error(`Queued request ${label} moved to manual review (${item.manualReason}).`);
      try { await this.persist(); }
      catch (e) {
        // The agent already ran; the transition exists in memory only. A restart will see `running`
        // on disk and move the item to manual review rather than replaying it.
        this.o.logger.error(`Queue persistence failed after execution (${errCode(e)}); state is not durable yet.`);
      }
    });
  }

  // ---- operator operations (used by commands) ---------------------------------------------

  async setPaused(paused: boolean): Promise<void> {
    await this.mutate(s => { s.paused = paused; });
    if (paused) this.clearTimer(); else this.schedule();
  }

  /** Removes the given items (never a running one). Returns how many were removed. */
  async remove(match: (item: Item) => boolean): Promise<number> {
    const removed = await this.mutate(s => {
      const before = s.items.length;
      s.items = s.items.filter(x => x.status === "running" || !match(x));
      return before - s.items.length;
    });
    this.schedule();
    return removed;
  }

  /** Re-arms a manual item. Validation is done by the caller; this applies it atomically. */
  async rearm(id: string, dueAt: number, prompt?: string): Promise<boolean> {
    const ok = await this.mutate(s => {
      const item = s.items.find(x => x.id === id);
      if (!item || item.status !== "manual") return false;
      if (prompt !== undefined) { item.prompt = prompt; item.promptChars = prompt.length; }
      if (!item.prompt?.trim()) return false;
      item.status = "waiting"; item.attempts = 0; item.nextAttemptAt = dueAt;
      delete item.manualReason;
      item.lastError = "Re-queued by an operator.";
      return true;
    });
    this.schedule();
    return ok;
  }

  /** Test/diagnostic hook: wait for the in-flight run and queued writes to settle. */
  async idle(): Promise<void> {
    await this.lock.catch(() => undefined);
  }
}
