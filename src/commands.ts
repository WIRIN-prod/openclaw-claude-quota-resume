import type { Item } from "./types.ts";
import { MAX_MANUAL_RETRY_AHEAD_MS, MAX_PROMPT_LENGTH } from "./types.ts";
import { isSlashCommand } from "./prompt.ts";
import type { QuotaQueue } from "./queue.ts";

export const HELP =
  "Claude quota queue commands:\n" +
  "  /claude-quota status\n" +
  "  /claude-quota pause | resume\n" +
  "  /claude-quota retry <id> <ISO-8601-time-with-zone> [--confirm] [-- <exact original prompt>]\n" +
  "  /claude-quota clear done | <id> | manual | all   (add --confirm to delete; `done` needs none)\n" +
  "Ids are the first characters (min 4) shown by `status`. Running items are never cleared.";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** `Date.parse` rolls impossible dates over (2026-11-31 -> Dec 1); reject them instead. */
function validCalendarTime(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MAY_HAVE_RUN = new Set(["ambiguous-execution", "interrupted"]);

type Found = { item: Item } | { error: string };

function findItem(items: Item[], prefix: string): Found {
  if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) return { error: `"${prefix.slice(0, 40)}" is not an item id (use the id shown by /claude-quota status, at least 4 characters).` };
  const hits = items.filter(x => x.id.startsWith(prefix.toLowerCase()));
  if (hits.length === 0) return { error: `No item matches ${prefix}.` };
  if (hits.length > 1) return { error: `${prefix} matches ${hits.length} items; use a longer id.` };
  return { item: hits[0] };
}

/** Splits `a b --confirm -- free text` into option tokens and the verbatim text after `--`. */
function parse(raw: string): { tokens: string[]; text?: string } {
  const m = /(^|\s)--(?:\s+|$)/.exec(raw);
  if (!m) return { tokens: raw.split(/\s+/).filter(Boolean) };
  const head = raw.slice(0, m.index);
  const text = raw.slice(m.index + m[0].length).trim();
  return { tokens: head.split(/\s+/).filter(Boolean), text };
}

export function formatStatus(queue: QuotaQueue, now = Date.now()): string {
  const { items, paused } = queue.state;
  const counts: Record<string, number> = {};
  for (const x of items) counts[x.status] = (counts[x.status] ?? 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "empty";
  const lines = items.slice(0, 25).map(x => {
    const next = x.status === "waiting" ? ` next=${new Date(x.nextAttemptAt).toISOString()}` : "";
    const reason = x.manualReason ? ` reason=${x.manualReason}` : "";
    const prompt = x.prompt ? `${x.promptChars ?? x.prompt.length} chars` : "none";
    return `- ${x.id.slice(0, 8)} ${x.status}${reason} ${x.sessionKey} attempts=${x.attempts}${next} prompt=${prompt}`;
  });
  if (items.length > 25) lines.push(`... and ${items.length - 25} more`);
  void now;
  return `Queue: ${items.length} item(s) (${summary}); paused=${paused}\n${lines.join("\n") || "(empty)"}`;
}

export async function runCommand(queue: QuotaQueue, rawArgs: string, now = Date.now()): Promise<{ text: string }> {
  try {
    await queue.ensureLoaded();
    const { tokens, text: freeText } = parse(rawArgs.trim());
    const [cmd = "status", ...rest] = tokens;
    const confirm = rest.includes("--confirm");
    const args = rest.filter(x => x !== "--confirm");
    switch (cmd.toLowerCase()) {
      case "status":
        return { text: formatStatus(queue, now) };
      case "help":
        return { text: HELP };
      case "pause":
        await queue.setPaused(true);
        return { text: "Claude quota queue paused. Nothing will run until /claude-quota resume." };
      case "resume":
        await queue.setPaused(false);
        return { text: "Claude quota queue resumed. Overdue waiting items will run shortly." };
      case "clear": {
        const target = args[0]?.toLowerCase();
        if (!target || args.length > 1) return { text: `Usage: /claude-quota clear done | <id> | manual | all [--confirm]\n${HELP}` };
        let match: (x: Item) => boolean;
        if (target === "done") match = x => x.status === "done";
        else if (target === "manual") match = x => x.status === "manual";
        else if (target === "all") match = () => true;
        else {
          const found = findItem(queue.state.items, target);
          if ("error" in found) return { text: found.error };
          if (found.item.status === "running") return { text: `Item ${target} is running and cannot be cleared.` };
          const id = found.item.id;
          match = x => x.id === id;
        }
        const candidates = queue.state.items.filter(x => x.status !== "running" && match(x));
        if (target !== "done" && !confirm) {
          return { text: `Would remove ${candidates.length} item(s) (running items are never removed). Re-run with --confirm to delete: /claude-quota clear ${target} --confirm` };
        }
        const removed = await queue.remove(match);
        return { text: `Removed ${removed} item(s).` };
      }
      case "retry": {
        const [idArg, when, ...extra] = args;
        if (!idArg || !when || extra.length) return { text: `Usage: /claude-quota retry <id> <ISO-8601-time-with-zone> [--confirm] [-- <exact original prompt>]\nExample: /claude-quota retry 1a2b3c4d 2026-10-14T09:00:00+05:30` };
        if (isIsoSessionKeyLike(idArg)) return { text: "retry takes an item id from `status`, not a session key. A retry never invents a request: the item must still hold its original prompt, or you must supply it after `--`." };
        if (!ISO.test(when) || !validCalendarTime(when)) return { text: `Invalid time "${when.slice(0, 40)}". Use ISO-8601 with an explicit zone, e.g. 2026-10-14T09:00:00+05:30 or ...Z.` };
        const dueAt = Date.parse(when);
        if (!Number.isFinite(dueAt)) return { text: `Invalid time "${when.slice(0, 40)}".` };
        if (dueAt <= now) return { text: "That time is in the past. Give a future time." };
        if (dueAt - now > MAX_MANUAL_RETRY_AHEAD_MS) return { text: "That time is more than 30 days ahead; choose a nearer time." };
        const found = findItem(queue.state.items, idArg);
        if ("error" in found) return { text: found.error };
        const item = found.item;
        if (item.status !== "manual") return { text: `Item ${idArg} is ${item.status}; only manual-review items can be retried.` };
        if (item.prompt && freeText !== undefined) return { text: "This item already holds its original prompt; do not supply another. Clear it first if you want to replace it." };
        if (!item.prompt && freeText === undefined) return { text: `Item ${idArg} has no stored prompt (reason=${item.manualReason ?? "unknown"}). It cannot run. Supply the exact original request: /claude-quota retry ${idArg} <time> -- <prompt>` };
        if (freeText !== undefined) {
          if (!freeText) return { text: "The prompt after `--` is empty." };
          if (freeText.length > MAX_PROMPT_LENGTH) return { text: `The prompt is longer than ${MAX_PROMPT_LENGTH} characters.` };
          if (isSlashCommand(freeText)) return { text: "The prompt looks like a chat command; supply the original request text." };
        }
        if (item.manualReason && MAY_HAVE_RUN.has(item.manualReason) && !confirm) {
          return { text: `Item ${idArg} was ${item.manualReason === "interrupted" ? "interrupted while running" : "an ambiguous execution"}: the request may already have run, and retrying could repeat its actions. Re-run with --confirm if you have checked.` };
        }
        const ok = await queue.rearm(item.id, dueAt, freeText);
        if (!ok) return { text: "Item changed while retrying; check /claude-quota status." };
        return { text: `Item ${item.id.slice(0, 8)} re-queued for ${new Date(dueAt).toISOString()}${queue.state.paused ? " (queue is paused)" : ""}.` };
      }
      default:
        return { text: HELP };
    }
  } catch {
    return { text: "The queue operation failed and was not applied (the queue file could not be updated). See the Gateway log." };
  }
}

function isIsoSessionKeyLike(s: string): boolean {
  return s.includes(":") || s.startsWith("agent");
}
