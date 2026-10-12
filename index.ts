import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "waiting" | "running" | "done" | "manual";
type Item = {
  id: string; sessionKey: string; agentId: string; prompt?: string;
  createdAt: string; nextAttemptAt: number; attempts: number;
  lastError?: string; status: Status; runId?: string;
};
type State = { version: number; paused?: boolean; items: Item[] };

const DEFAULT_PATH = "~/.openclaw/state/claude-quota-resume/queue.json";
const INITIAL_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 50;
const MAX_PROMPT_LENGTH = 100_000;

function homePath(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  return p.startsWith("~/") ? resolve(process.env.HOME ?? ".", p.slice(2)) : resolve(p);
}
function str(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v ?? ""); } catch { return String(v ?? ""); }
}
function searchableText(v: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 8 || v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return "";
  if (seen.has(v as object)) return "";
  seen.add(v as object);
  if (Array.isArray(v)) return v.map(x => searchableText(x, depth + 1, seen)).join("\n");
  return Object.entries(v as Record<string, unknown>)
    .map(([k, value]) => `${k}: ${searchableText(value, depth + 1, seen)}`).join("\n");
}
function quotaError(v: unknown): boolean {
  const s = searchableText(v).toLowerCase();
  return /you(?:'|’)ve hit your session limit/.test(s) ||
    /\bsession limit\b/.test(s) || /\bquota exceeded\b/.test(s) ||
    (/\b(rate.?limit|usage limit|limit reached)\b/.test(s) &&
     /\b(claude|anthropic|subscription|quota|weekly|five.?hour|5.?hour)\b/.test(s));
}
function field(o: unknown, keys: string[]): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) if (typeof r[k] === "string" && (r[k] as string).trim()) return (r[k] as string).trim();
  return undefined;
}
function messageText(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  for (const k of ["text", "body", "cleanedBody", "prompt"]) {
    if (typeof r[k] === "string" && (r[k] as string).trim()) return (r[k] as string).trim();
  }
  if (typeof r.content === "string" && r.content.trim()) return r.content.trim();
  if (Array.isArray(r.content)) {
    const joined = r.content.map(x => typeof x === "string" ? x : field(x, ["text"]) ?? "")
      .filter(Boolean).join("\n").trim();
    if (joined) return joined;
  }
  return undefined;
}
function userPromptFrom(v: unknown, depth = 0, seen = new Set<object>()): string | undefined {
  if (!v || typeof v !== "object" || depth > 7 || seen.has(v as object)) return undefined;
  seen.add(v as object);
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const found = userPromptFrom(v[i], depth + 1, seen);
      if (found) return found;
    }
    return undefined;
  }
  const r = v as Record<string, unknown>;
  const role = String(r.role ?? r.type ?? r.author ?? "").toLowerCase();
  if (["user", "human"].includes(role)) {
    const text = messageText(r);
    if (text && !/^\/claude-quota(?:\s|$)/i.test(text)) return text;
  }
  for (const k of ["message", "messages", "payload", "data", "event", "content", "input", "request"]) {
    const found = userPromptFrom(r[k], depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}
function resetTimeFrom(v: unknown, fallbackMs: number): number {
  const text = searchableText(v);
  const match = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!match) return fallbackMs;
  const zone = match[4].trim();
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  const minute = Number(match[2] ?? 0);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone: zone, year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(new Date());
    const part = (type: string) => parts.find(x => x.type === type)?.value ?? "";
    const base = `${part("year")}-${part("month")}-${part("day")}`;
    const makeUtc = (date: string) => {
      // Iteratively convert wall-clock time in the named timezone to UTC.
      const target = Date.parse(`${date}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);
      let guess = target;
      for (let i = 0; i < 3; i++) {
        const got = new Intl.DateTimeFormat("en-CA", {timeZone:zone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).formatToParts(new Date(guess));
        const val = (t: string) => got.find(x => x.type === t)?.value ?? "0";
        const wall = Date.UTC(Number(val("year")), Number(val("month"))-1, Number(val("day")), Number(val("hour")), Number(val("minute")));
        guess += target - wall;
      }
      return guess;
    };
    let candidate = makeUtc(base);
    if (candidate <= Date.now()) {
      const d = new Date(Date.parse(`${base}T00:00:00Z`) + 86400000);
      candidate = makeUtc(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`);
    }
    return candidate;
  } catch { return fallbackMs; }
}

function sessionKey(event: unknown, ctx: unknown): string | undefined {
  return field(ctx, ["sessionKey", "session_key"]) ?? field(event, ["sessionKey", "session_key"]);
}
function agentId(event: unknown, ctx: unknown, key: string): string {
  return field(ctx, ["agentId"]) ?? field(event, ["agentId"]) ?? /^agent:([^:]+):/.exec(key)?.[1] ?? "main";
}
function runId(event: unknown, ctx: unknown): string | undefined {
  return field(ctx, ["runId"]) ?? field(event, ["runId"]);
}
function cli(args: string[], timeoutMs = 15 * 60_000): Promise<{code: number; output: string}> {
  return new Promise(resolvePromise => {
    const child = spawn("openclaw", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    const append = (chunk: unknown) => { output += String(chunk); if (output.length > 100_000) output = output.slice(-100_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); }, timeoutMs);
    timer.unref();
    child.on("error", e => { clearTimeout(timer); resolvePromise({code: 127, output: `${output}\n${e.message}`}); });
    child.on("close", code => { clearTimeout(timer); resolvePromise({code: code ?? 1, output}); });
  });
}

export default definePluginEntry({
  id: "claude-quota-resume",
  name: "Claude Quota Resume",
  description: "Queue original requests and retry after Claude subscription limits reset.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const path = homePath(typeof cfg.statePath === "string" ? cfg.statePath : DEFAULT_PATH);
    const retryMs = typeof cfg.initialRetryMs === "number" ? Math.max(1000, cfg.initialRetryMs) : INITIAL_RETRY_MS;
    let state: State = {version: 2, paused: false, items: []};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let busy = false;
    const recent = new Map<string, {prompt: string; agentId: string; at: number}>();
    const seenRuns = new Set<string>();

    async function persist() {
      await mkdir(dirname(path), {recursive: true});
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), {mode: 0o600});
      await rename(tmp, path);
    }
    async function load() {
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as Partial<State>;
        state = {
          version: 2, paused: raw.paused === true,
          items: (Array.isArray(raw.items) ? raw.items : []).filter((x): x is Item => Boolean(
            x && typeof x.id === "string" && typeof x.sessionKey === "string" && typeof x.nextAttemptAt === "number"
          )).map(x => ({...x, status: x.status === "running" ? "waiting" : x.status ?? "waiting"})),
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") api.logger.warn(`Queue load failed: ${str(e)}`);
        state = {version: 2, paused: false, items: []};
      }
      await persist();
    }
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (stopping || state.paused) return;
      const waiting = state.items.filter(x => x.status === "waiting");
      if (!waiting.length) return;
      const due = Math.min(...waiting.map(x => x.nextAttemptAt));
      timer = setTimeout(() => { void processQueue(); }, Math.max(250, due - Date.now()));
      timer.unref?.();
    }
    function delay(attempts: number) { return Math.min(MAX_RETRY_MS, retryMs * 2 ** Math.min(attempts, 8)); }
    async function enqueue(input: {sessionKey: string; agentId: string; prompt?: string; error?: string; runId?: string; dueAt?: number}) {
      const item: Item = {
        id: randomUUID(), sessionKey: input.sessionKey, agentId: input.agentId,
        ...(input.prompt ? {prompt: input.prompt.slice(0, MAX_PROMPT_LENGTH)} : {}),
        createdAt: new Date().toISOString(), nextAttemptAt: input.dueAt ?? Date.now() + retryMs,
        attempts: 0, lastError: input.error ?? "Claude subscription limit reached", status: "waiting",
        ...(input.runId ? {runId: input.runId} : {}),
      };
      state.items.push(item); await persist(); schedule(); return item;
    }
    async function processQueue() {
      if (stopping || state.paused || busy) return;
      const item = state.items.filter(x => x.status === "waiting" && x.nextAttemptAt <= Date.now())
        .sort((a,b) => a.nextAttemptAt-b.nextAttemptAt || a.createdAt.localeCompare(b.createdAt))[0];
      if (!item) { schedule(); return; }
      busy = true; item.status = "running"; await persist();
      try {
        if (!item.prompt?.trim()) {
          item.status = "manual";
          item.lastError = "Original prompt is missing; automatic replay was blocked to prevent running an unintended task. Recover the exact prompt, then re-queue it.";
          api.logger.error(`Blocked queued request ${item.id}: original prompt missing.`);
          return;
        }
        const prompt = item.prompt;
        const result = await cli(["agent", "--session-key", item.sessionKey, "--agent", item.agentId, "--message", prompt, "--json"]);
        if (result.code === 0 && !quotaError(result.output)) {
          item.status = "done"; item.lastError = undefined;
          api.logger.info(`Completed queued request ${item.id} for ${item.sessionKey}.`);
        } else if (quotaError(result.output)) {
          item.attempts++; item.status = item.attempts >= MAX_ATTEMPTS ? "manual" : "waiting";
          item.lastError = result.output.slice(-4000); item.nextAttemptAt = Date.now() + delay(item.attempts);
          api.logger.warn(`Claude quota still exhausted for ${item.sessionKey}; retry scheduled.`);
        } else {
          item.status = "manual"; item.lastError = result.output.slice(-4000) || `OpenClaw exited ${result.code}`;
          api.logger.error(`Queued request ${item.id} needs manual review.`);
        }
      } catch (e) {
        item.attempts++; item.status = item.attempts >= MAX_ATTEMPTS ? "manual" : "waiting";
        item.lastError = str(e); item.nextAttemptAt = Date.now() + delay(item.attempts);
      } finally { await persist(); busy = false; schedule(); }
    }

    // Capture each inbound request before the agent's final result.
    api.on("message_received", async (event: unknown, ctx: unknown) => {
      const key = sessionKey(event, ctx);
      const prompt = messageText(event) ?? userPromptFrom(event);
      if (!key || !prompt || /^\/claude-quota(?:\s|$)/i.test(prompt)) return;
      recent.set(key, {prompt: prompt.slice(0, MAX_PROMPT_LENGTH), agentId: agentId(event, ctx, key), at: Date.now()});
      for (const [k, v] of recent) if (Date.now() - v.at > 60 * 60_000) recent.delete(k);
    });

    api.on("agent_end", async (event: unknown, ctx: unknown) => {
      if (!event || typeof event !== "object") return;
      const e = event as Record<string, unknown>;
      const id = runId(event, ctx);
      if (id && seenRuns.has(id)) return;
      if (id) { seenRuns.add(id); if (seenRuns.size > 2000) seenRuns.clear(); }
      const failure = searchableText(event);
      if (e.success === true || !quotaError(failure)) return;
      const key = sessionKey(event, ctx);
      if (!key) { api.logger.warn("Quota failure detected without session key."); return; }

      const latest = recent.get(key);
      const usable = latest && Date.now() - latest.at < 30 * 60_000;
      let prompt = usable ? latest.prompt : undefined;
      const targetAgent = usable ? latest.agentId : agentId(event, ctx, key);
      if (!prompt) prompt = userPromptFrom(event);
      if (prompt) {
        const dueAt = resetTimeFrom(failure, Date.now() + retryMs);
        await enqueue({sessionKey: key, agentId: targetAgent, prompt, error: "Claude subscription quota limit reached; retry scheduled.", runId: id, dueAt});
        recent.delete(key);
        api.logger.warn(`Captured original request and queued it for ${key}.`);
      } else {
        const item = await enqueue({sessionKey: key, agentId: targetAgent, error: "Claude quota limit detected, but the original prompt could not be recovered.", runId: id});
        item.status = "manual";
        item.lastError = "Quota failure detected, but the original prompt could not be recovered from the hook payload. Automatic replay is blocked.";
        await persist();
        api.logger.error(`Original prompt unavailable for ${key}; item moved to manual review.`);
      }
    });

    api.registerCommand({
      name: "claude-quota", description: "Inspect and control the Claude quota retry queue.", acceptsArgs: true,
      handler: async (ctx: {args?: string}) => {
        const raw = String(ctx?.args ?? "").trim();
        const [command = "status", ...args] = raw.split(/\s+/);
        switch (command.toLowerCase()) {
          case "status":
            return {text: `Queue items: ${state.items.length}; paused=${Boolean(state.paused)}\n` +
              (state.items.map(x => `- ${x.id.slice(0,8)} ${x.status} ${x.sessionKey} attempts=${x.attempts} next=${new Date(x.nextAttemptAt).toISOString()} prompt=${x.prompt ? JSON.stringify(x.prompt.slice(0,80)) : "(legacy item)"}`).join("\n") || "(empty)")};
          case "pause":
            state.paused = true; if (timer) clearTimeout(timer); timer = undefined; await persist();
            return {text: "Claude quota queue paused."};
          case "resume":
            state.paused = false; await persist(); schedule(); return {text: "Claude quota queue resumed."};
          case "clear": {
            const prefix = args[0];
            state.items = state.items.filter(x => prefix ? !x.id.startsWith(prefix) : x.status === "running");
            await persist(); schedule(); return {text: prefix ? `Removed items matching ${prefix}.` : "Cleared non-running queue items."};
          }
          case "retry": {
            const key = args[0], when = args[1];
            if (!key || !when) return {text: "Usage: /claude-quota retry <sessionKey> <ISO-8601-time>"};
            const dueAt = Date.parse(when);
            if (!Number.isFinite(dueAt)) return {text: `Invalid date: ${when}`};
            const item = await enqueue({sessionKey: key, agentId: agentId(undefined, undefined, key), dueAt, error: "Manually scheduled retry"});
            return {text: `Queued ${item.id.slice(0,8)} for ${key} at ${new Date(dueAt).toISOString()}.`};
          }
          default:
            return {text: "Commands: status | pause | resume | clear [id-prefix] | retry <sessionKey> <ISO-8601-time>"};
        }
      },
    });

    api.on("gateway_start", async () => {
      stopping = false; await load(); schedule();
      api.logger.info(`Claude quota resume loaded ${state.items.length} queue item(s).`);
    });
    api.on("gateway_stop", async () => {
      stopping = true; if (timer) clearTimeout(timer); timer = undefined;
    });
  },
});
