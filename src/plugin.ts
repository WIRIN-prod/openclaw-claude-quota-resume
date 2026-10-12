import { join, dirname } from "node:path";
import type { Logger } from "./types.ts";
import {
  DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_STATE_PATH, MAX_RETRY_MS, MIN_INITIAL_RETRY_MS,
} from "./types.ts";
import { failureText, quotaError } from "./detect.ts";
import { dueAtFromReset } from "./outcome.ts";
import { boundPrompt, field, isSlashCommand, messageText, userPromptFrom, validAgentId, validSessionKey } from "./prompt.ts";
import { homePath } from "./store.ts";
import { QuotaQueue } from "./queue.ts";
import { createCliRunner } from "./runner.ts";
import { runCommand } from "./commands.ts";
import type { RunJob, RunResult } from "./types.ts";

/** The slice of the OpenClaw plugin API this plugin uses. */
export type PluginApiLike = {
  pluginConfig?: Record<string, unknown>;
  logger: Logger;
  on(hook: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerCommand(def: {
    name: string; description: string; acceptsArgs: boolean;
    handler: (ctx: { args?: string }) => Promise<{ text: string }> | { text: string };
  }): void;
};

export type PluginDeps = {
  execute?: (job: RunJob) => Promise<RunResult>;
  now?: () => number;
};

export type PluginConfig = { statePath: string; initialRetryMs: number; maxAttempts: number };

export function parseConfig(raw: Record<string, unknown> | undefined, logger: Logger): PluginConfig {
  const cfg = raw ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (cfg.retryOnUnknownFailure === true) logger.warn("retryOnUnknownFailure is ignored: non-quota failures always go to manual review.");
  if (cfg.defaultSessionKey !== undefined) logger.warn("defaultSessionKey is ignored; sessions are taken from the failing run.");
  const retry = num(cfg.initialRetryMs);
  const attempts = num(cfg.maxAttempts);
  return {
    statePath: homePath(typeof cfg.statePath === "string" && cfg.statePath ? cfg.statePath : DEFAULT_STATE_PATH),
    initialRetryMs: retry === undefined ? DEFAULT_INITIAL_RETRY_MS : Math.min(MAX_RETRY_MS, Math.max(MIN_INITIAL_RETRY_MS, retry)),
    maxAttempts: attempts === undefined ? DEFAULT_MAX_ATTEMPTS : Math.min(1000, Math.max(1, Math.floor(attempts))),
  };
}

const RECENT_TTL_MS = 30 * 60_000;
const RECENT_MAX = 500;

type Recent = { prompt: string; agentId: string; at: number; runId?: string };

export function registerClaudeQuotaResume(api: PluginApiLike, deps: PluginDeps = {}): QuotaQueue {
  const cfg = parseConfig(api.pluginConfig, api.logger);
  const now = deps.now ?? Date.now;
  const queue = new QuotaQueue({
    path: cfg.statePath,
    logger: api.logger,
    initialRetryMs: cfg.initialRetryMs,
    maxAttempts: cfg.maxAttempts,
    now,
    execute: deps.execute ?? createCliRunner({ tmpDir: join(dirname(cfg.statePath), "tmp") }),
  });
  const recent = new Map<string, Recent>();
  const seenRuns = new Set<string>();

  const sessionKeyOf = (event: unknown, ctx: unknown) => field(ctx, ["sessionKey", "session_key"]) ?? field(event, ["sessionKey", "session_key"]);
  const runIdOf = (event: unknown, ctx: unknown) => field(ctx, ["runId"]) ?? field(event, ["runId"]);
  const agentIdOf = (event: unknown, ctx: unknown, key: string) =>
    field(ctx, ["agentId"]) ?? field(event, ["agentId"]) ?? /^agent:([^:]+):/.exec(key)?.[1] ?? "main";

  api.on("message_received", async (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    const prompt = messageText(event) ?? userPromptFrom(event);
    if (!key || !validSessionKey(key) || !prompt || isSlashCommand(prompt)) return;
    recent.set(key, { prompt: boundPrompt(prompt), agentId: agentIdOf(event, ctx, key), at: now(), runId: runIdOf(event, ctx) });
    for (const [k, v] of recent) if (now() - v.at > RECENT_TTL_MS) recent.delete(k);
    while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
  });

  api.on("agent_end", async (event, ctx) => {
    if (!event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    const key = sessionKeyOf(event, ctx);
    const id = runIdOf(event, ctx);
    // Only a definite failure is considered; a finished turn invalidates the cached prompt so it
    // can never be replayed for a later, unrelated failure in the same session.
    if (e.success === true) {
      const cached = key ? recent.get(key) : undefined;
      if (key && cached && (!cached.runId || !id || cached.runId === id)) recent.delete(key);
      return;
    }
    if (e.success !== false) return;
    const failure = failureText(event);
    if (!quotaError(failure)) return;
    if (id && seenRuns.has(id)) return;
    if (!key) { api.logger.warn("Quota failure detected without session key."); return; }
    if (!validSessionKey(key)) { api.logger.warn("Quota failure ignored: session key is not valid for replay."); return; }
    if (id) { seenRuns.add(id); if (seenRuns.size > 2000) seenRuns.clear(); }

    const latest = recent.get(key);
    const usable = !!latest && now() - latest.at < RECENT_TTL_MS && (!latest.runId || !id || latest.runId === id);
    let prompt = usable ? latest.prompt : undefined;
    const agentId = usable ? latest.agentId : agentIdOf(event, ctx, key);
    if (!prompt) {
      const found = userPromptFrom(event);
      prompt = found ? boundPrompt(found) : undefined;
    }
    if (!validAgentId(agentId)) { api.logger.warn("Quota failure ignored: agent id is not valid for replay."); return; }
    try {
      const dueAt = dueAtFromReset(failure, now() + cfg.initialRetryMs, now());
      const { item, duplicate } = await queue.enqueue({ sessionKey: key, agentId, prompt, runId: id, dueAt });
      recent.delete(key);
      if (duplicate) api.logger.info(`Quota failure for ${key} matched queued item ${item.id.slice(0, 8)}; not queued again.`);
      else if (item.status === "waiting") api.logger.warn(`Captured original request and queued it as ${item.id.slice(0, 8)} for ${key}.`);
      else api.logger.error(`Quota failure for ${key} queued as ${item.id.slice(0, 8)} for manual review (${item.manualReason}).`);
    } catch {
      if (id) seenRuns.delete(id); // allow a repeat delivery of this hook to try again
      api.logger.error("Could not persist the quota-failure queue entry; the request was not queued.");
    }
  });

  api.registerCommand({
    name: "claude-quota",
    description: "Inspect and control the Claude quota retry queue.",
    acceptsArgs: true,
    handler: async (ctx) => runCommand(queue, String(ctx?.args ?? ""), now()),
  });

  api.on("gateway_start", async () => {
    try {
      await queue.start();
      api.logger.info(`Claude quota resume loaded ${queue.state.items.length} queue item(s).`);
    } catch {
      api.logger.error("Claude quota resume failed to start.");
    }
  });
  api.on("gateway_stop", async () => { await queue.stop(); });
  return queue;
}
