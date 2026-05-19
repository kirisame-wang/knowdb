// General utilities: UTC date formatting, ephemeral ids, JSONL (de)serialization.
import type { GapEvent } from "./types.js";

// ── Date / id ─────────────────────────────────────────────────────────────────

function utcYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** "gap_<yyyymmdd>_<seq3>" in UTC. `seq` is the per-day sequence (1-based). */
export function makeGapId(date: Date, seq: number): string {
  return `gap_${utcYmd(date)}_${String(seq).padStart(3, "0")}`;
}

/** 1-based sequence for `date`'s UTC day, given the events already recorded. */
export function nextDailySeq(events: GapEvent[], date: Date): number {
  const ymd = utcYmd(date);
  return events.filter((e) => utcYmd(new Date(e.timestamp)) === ymd).length + 1;
}

/** Ephemeral per-conversation id. One per page load (the sink is built at
 *  app init); rotate by constructing a new sink on a "new"/reset action.
 *  Not user-identifying; only groups a session for post-hoc analysis. */
export function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── JSONL serialization ───────────────────────────────────────────────────────

export function serializeGap(event: GapEvent): string {
  return JSON.stringify(event);
}

export function parseGapsJsonl(text: string): GapEvent[] {
  const out: GapEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as GapEvent);
    } catch {
      // Skip a corrupt line (truncated/interleaved >> append, partial
      // localStorage write) rather than aborting the whole read — gap
      // logging runs inside the live search path and must never break it.
    }
  }
  return out;
}
