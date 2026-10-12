import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Item, ManualReason, State, Status } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export function homePath(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  return p.startsWith("~/") ? resolve(process.env.HOME ?? ".", p.slice(2)) : resolve(p);
}

const STATUSES: readonly Status[] = ["waiting", "running", "done", "manual"];
const REASONS: readonly ManualReason[] = [
  "missing-prompt", "prompt-too-long", "non-quota-failure", "ambiguous-execution",
  "interrupted", "max-attempts", "invalid-record", "invalid-target",
];
const LEGACY_REDACTION = "Legacy diagnostic redacted during schema v3 migration (original kept in the migration backup).";

export type LoadReport = {
  /** The file did not exist (first run). */
  missing: boolean;
  /** The file was unreadable or not valid JSON; state starts empty and the file is backed up. */
  corrupt: boolean;
  /** Entries that could not be interpreted as queue items. */
  dropped: number;
  /** Items that were `running` when the process stopped; moved to manual review. */
  interrupted: number;
  /** Schema version found on disk (undefined when missing/corrupt). */
  fromVersion?: number;
  /** A backup copy of the on-disk file must be made before it is rewritten. */
  needsBackup: boolean;
};

export function emptyState(): State {
  return { version: SCHEMA_VERSION, paused: false, items: [] };
}

function normalizeItem(raw: unknown, legacy: boolean, report: LoadReport): Item | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const x = raw as Record<string, unknown>;
  if (typeof x.id !== "string" || !x.id || typeof x.sessionKey !== "string" || !x.sessionKey) return undefined;

  let status: Status = STATUSES.includes(x.status as Status) ? (x.status as Status) : "manual";
  let manualReason = REASONS.includes(x.manualReason as ManualReason) ? (x.manualReason as ManualReason) : undefined;
  let lastError = typeof x.lastError === "string" ? x.lastError : undefined;
  if (legacy && lastError && (lastError.length > 200 || lastError.includes("\n"))) lastError = LEGACY_REDACTION;

  const prompt = typeof x.prompt === "string" && x.prompt.trim() ? x.prompt : undefined;
  const nextAttemptAt = typeof x.nextAttemptAt === "number" && Number.isFinite(x.nextAttemptAt) ? x.nextAttemptAt : undefined;

  if (!STATUSES.includes(x.status as Status) || (status === "waiting" && nextAttemptAt === undefined)) {
    status = "manual"; manualReason = "invalid-record";
    lastError = "Queue record was incomplete or had an unknown status; automatic replay is blocked.";
  } else if (status === "running") {
    // The previous process stopped mid-run: the agent may or may not have executed the request.
    status = "manual"; manualReason = "interrupted";
    lastError = "Interrupted while running; the request may already have executed. Review before retrying.";
    report.interrupted++;
  } else if (status === "waiting" && !prompt) {
    status = "manual"; manualReason = "missing-prompt";
    lastError = "Original prompt is missing; automatic replay is blocked.";
  }

  const item: Item = {
    id: x.id,
    sessionKey: x.sessionKey,
    agentId: typeof x.agentId === "string" && x.agentId ? x.agentId : "main",
    createdAt: typeof x.createdAt === "string" ? x.createdAt : new Date(0).toISOString(),
    nextAttemptAt: nextAttemptAt ?? 0,
    attempts: typeof x.attempts === "number" && Number.isInteger(x.attempts) && x.attempts >= 0 ? x.attempts : 0,
    status,
  };
  if (status !== "done" && prompt) item.prompt = prompt;
  if (typeof x.promptChars === "number" && Number.isFinite(x.promptChars)) item.promptChars = x.promptChars;
  else if (prompt) item.promptChars = prompt.length;
  if (status === "manual" && manualReason) item.manualReason = manualReason;
  if (lastError) item.lastError = lastError;
  if (typeof x.runId === "string" && x.runId) item.runId = x.runId;
  return item;
}

/** Reads and validates the queue file. Never throws; problems are reported, not swallowed. */
export async function readState(path: string): Promise<{ state: State; report: LoadReport }> {
  const report: LoadReport = { missing: false, corrupt: false, dropped: 0, interrupted: 0, needsBackup: false };
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") { report.missing = true; return { state: emptyState(), report }; }
    report.corrupt = true; report.needsBackup = true;
    return { state: emptyState(), report };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); } catch {
    report.corrupt = true; report.needsBackup = true;
    return { state: emptyState(), report };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    report.corrupt = true; report.needsBackup = true;
    return { state: emptyState(), report };
  }
  const doc = parsed as Record<string, unknown>;
  const version = typeof doc.version === "number" ? doc.version : 0;
  report.fromVersion = version;
  if (version > SCHEMA_VERSION) {
    // Written by a newer plugin: do not interpret or overwrite it silently.
    report.corrupt = true; report.needsBackup = true;
    return { state: emptyState(), report };
  }
  const legacy = version < SCHEMA_VERSION;
  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  const items: Item[] = [];
  for (const raw of rawItems) {
    const item = normalizeItem(raw, legacy, report);
    if (item) items.push(item); else report.dropped++;
  }
  report.needsBackup = legacy || report.dropped > 0 || report.interrupted > 0;
  return { state: { version: SCHEMA_VERSION, paused: doc.paused === true, items }, report };
}

/** Copies the on-disk file next to itself (0600). Returns the backup path. */
export async function backupFile(path: string, tag: string): Promise<string> {
  const target = `${path}.${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(path, target);
  await chmod(target, 0o600);
  return target;
}

/** Atomic replace: write a private temp file, fsync it, rename over the target. */
export async function writeState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}
