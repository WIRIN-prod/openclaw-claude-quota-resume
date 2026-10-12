import { MAX_PROMPT_LENGTH } from "./types.ts";

export function str(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v ?? ""); } catch { return String(v ?? ""); }
}

export function searchableText(v: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 8 || v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return "";
  if (seen.has(v as object)) return "";
  seen.add(v as object);
  if (Array.isArray(v)) return v.map(x => searchableText(x, depth + 1, seen)).join("\n");
  return Object.entries(v as Record<string, unknown>)
    .map(([k, value]) => `${k}: ${searchableText(value, depth + 1, seen)}`).join("\n");
}

const LIMIT_PHRASE = new RegExp(
  [
    String.raw`you(?:'|’)ve (?:hit|reached) your [\w -]{0,40}\blimit\b`,
    String.raw`\b(?:session|usage|weekly|daily|5.?hour|five.?hour|opus|sonnet) limit\b`,
    String.raw`\bquota (?:exceeded|exhausted|reached)\b`,
  ].join("|"),
);
const CLAUDE_CONTEXT = /\b(?:claude|anthropic|subscription)\b/;
const RESET_HINT = /\bresets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/;
const OTHER_PROVIDER = /\b(?:openai|gpt|codex|gemini|google|vertex|bedrock|azure|openrouter|mistral|groq)\b/;

/**
 * Conservative Claude subscription-quota detection. A limit phrase alone is not enough:
 * the text must also carry Claude/subscription context or a "resets <time>" hint, and text that
 * names another provider needs a subscription or reset hint. Plain API rate limits
 * (`rate_limit_error`, HTTP 429) are deliberately not treated as quota exhaustion.
 */
export function quotaError(v: unknown): boolean {
  const s = searchableText(v).toLowerCase();
  if (!LIMIT_PHRASE.test(s)) return false;
  const reset = RESET_HINT.test(s);
  const subscription = /\bsubscription\b/.test(s);
  if (OTHER_PROVIDER.test(s) && !reset && !subscription) return false;
  return CLAUDE_CONTEXT.test(s) || reset;
}

/** Text that describes why a run failed: the error field and the last assistant message only. */
export function failureText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e.error === "string") parts.push(e.error);
  else if (e.error && typeof e.error === "object") parts.push(searchableText(e.error));
  if (Array.isArray(e.messages)) {
    for (let i = e.messages.length - 1; i >= 0; i--) {
      const m = e.messages[i] as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || String(m.role ?? "").toLowerCase() !== "assistant") continue;
      if (typeof m.errorMessage === "string") parts.push(m.errorMessage);
      parts.push(searchableText(m.content));
      break;
    }
  }
  return parts.join("\n").slice(-MAX_PROMPT_LENGTH);
}

/** Next occurrence of a "resets 3am (Zone)" wall-clock time, or `fallbackMs` when absent/invalid. */
export function resetTimeFrom(v: unknown, fallbackMs: number, now = Date.now()): number {
  const text = searchableText(v);
  const match = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!match) return fallbackMs;
  const zone = match[4].trim();
  const hour12 = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return fallbackMs;
  let hour = hour12 % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const part = (type: string) => parts.find(x => x.type === type)?.value ?? "";
    const base = `${part("year")}-${part("month")}-${part("day")}`;
    const makeUtc = (date: string) => {
      // Iteratively convert wall-clock time in the named timezone to UTC.
      const target = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
      let guess = target;
      for (let i = 0; i < 3; i++) {
        const got = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
        const val = (t: string) => got.find(x => x.type === t)?.value ?? "0";
        const wall = Date.UTC(Number(val("year")), Number(val("month")) - 1, Number(val("day")), Number(val("hour")), Number(val("minute")));
        guess += target - wall;
      }
      return guess;
    };
    let candidate = makeUtc(base);
    if (candidate <= now) {
      const d = new Date(Date.parse(`${base}T00:00:00Z`) + 86400000);
      candidate = makeUtc(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    return Number.isFinite(candidate) ? candidate : fallbackMs;
  } catch { return fallbackMs; }
}
