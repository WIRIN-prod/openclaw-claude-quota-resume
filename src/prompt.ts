import { MAX_PROMPT_LENGTH } from "./types.ts";

export function field(o: unknown, keys: string[]): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) if (typeof r[k] === "string" && (r[k] as string).trim()) return (r[k] as string).trim();
  return undefined;
}

/** `/status`, `/claude-quota retry ...`, `/new@bot`: chat commands, never agent prompts. */
export function isSlashCommand(text: string): boolean {
  return /^\/[a-z][\w-]*(?:@\w+)?(?:\s|$)/i.test(text.trimStart());
}

export function messageText(v: unknown): string | undefined {
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

/** Latest user-authored prompt found in a (possibly nested) hook payload. */
export function userPromptFrom(v: unknown, depth = 0, seen = new Set<object>()): string | undefined {
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
    if (text && !isSlashCommand(text)) return text;
  }
  for (const k of ["message", "messages", "payload", "data", "event", "content", "input", "request"]) {
    const found = userPromptFrom(r[k], depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * Keeps one character beyond the limit so oversized prompts are detectable.
 * An oversized prompt is never truncated and replayed: that would run a different request.
 */
export function boundPrompt(prompt: string): string {
  return prompt.slice(0, MAX_PROMPT_LENGTH + 1);
}

const SESSION_KEY = /^[A-Za-z0-9][^\s\u0000-\u001f\u007f]{0,255}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const validSessionKey = (k: unknown): k is string => typeof k === "string" && SESSION_KEY.test(k);
export const validAgentId = (k: unknown): k is string => typeof k === "string" && AGENT_ID.test(k);
