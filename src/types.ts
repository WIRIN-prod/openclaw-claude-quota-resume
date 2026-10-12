export type Status = "waiting" | "running" | "done" | "manual";

export type ManualReason =
  | "missing-prompt"
  | "prompt-too-long"
  | "non-quota-failure"
  | "ambiguous-execution"
  | "interrupted"
  | "max-attempts"
  | "invalid-record"
  | "invalid-target";

export type Item = {
  id: string;
  sessionKey: string;
  agentId: string;
  /** Exact original prompt. Removed once the item is done. Never logged or shown by `status`. */
  prompt?: string;
  promptChars?: number;
  createdAt: string;
  nextAttemptAt: number;
  attempts: number;
  status: Status;
  manualReason?: ManualReason;
  /** Sanitized diagnostic only; never raw CLI output. */
  lastError?: string;
  runId?: string;
};

export type State = { version: 3; paused: boolean; items: Item[] };

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type RunJob = { sessionKey: string; agentId: string; prompt: string };

export type RunResult = {
  /** Exit code, or null when the process was terminated by a signal. */
  code: number | null;
  signal?: string | null;
  timedOut: boolean;
  /** Set when the process could not be spawned or errored after spawn. */
  spawnError?: { code?: string; name: string };
  /** Combined stdout/stderr tail. Used only for classification, never stored. */
  output: string;
};

export const SCHEMA_VERSION = 3 as const;
export const DEFAULT_STATE_PATH = "~/.openclaw/state/claude-quota-resume/queue.json";
export const DEFAULT_INITIAL_RETRY_MS = 5 * 60_000;
export const MIN_INITIAL_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 60 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 50;
export const MAX_PROMPT_LENGTH = 100_000;
/** Added after a parsed reset time so the retry does not land exactly on the boundary. */
export const RESET_BUFFER_MS = 60_000;
/** Upper bound on how far ahead a parsed reset time may schedule a retry. */
export const MAX_RESET_WAIT_MS = 26 * 60 * 60_000;
/** Upper bound for an operator-supplied retry time. */
export const MAX_MANUAL_RETRY_AHEAD_MS = 30 * 24 * 60 * 60_000;
export const MIN_TIMER_MS = 250;
/** setTimeout overflows above 2^31-1 ms; wake at least this often and re-evaluate. */
export const MAX_TIMER_MS = 60 * 60_000;
export const PERSIST_FAILURE_BACKOFF_MS = 30_000;
