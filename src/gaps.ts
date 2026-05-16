import type { GapEvent, GapAggregate } from "./types.js";

// ── Known-gap thresholds (G8, tunable) ────────────────────────────────────────

/** ≥ HIGH occurrences → "not in coverage". */
export const HIGH = 10;
/** ≥ MID (and < HIGH) → "try alternative keywords". */
export const MID = 3;

// ── Keyword normalization (G7 — deterministic, no LLM) ────────────────────────

export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Gap id ────────────────────────────────────────────────────────────────────

/** "gap_<yyyymmdd>_<seq3>" in UTC. `seq` is the per-day sequence (1-based). */
export function makeGapId(date: Date, seq: number): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `gap_${y}${m}${d}_${String(seq).padStart(3, "0")}`;
}

// ── JSONL serialization ───────────────────────────────────────────────────────

export function serializeGap(event: GapEvent): string {
  return JSON.stringify(event);
}

export function parseGapsJsonl(text: string): GapEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GapEvent);
}

// ── Aggregation (G7 — pure, deterministic) ────────────────────────────────────

export function aggregate(events: GapEvent[]): GapAggregate[] {
  const groups = new Map<string, GapEvent[]>();
  for (const e of events) {
    const topic = normalizeKeyword(e.keyword);
    (groups.get(topic) ?? groups.set(topic, []).get(topic)!).push(e);
  }

  const result: GapAggregate[] = [];
  for (const [topic, group] of groups) {
    let first = group[0]!.timestamp;
    let last = group[0]!.timestamp;
    const scopes = new Set<string | null>();
    for (const e of group) {
      if (Date.parse(e.timestamp) < Date.parse(first)) first = e.timestamp;
      if (Date.parse(e.timestamp) > Date.parse(last)) last = e.timestamp;
      scopes.add(e.scope);
    }
    result.push({
      topic,
      occurrence_count: group.length,
      first_seen: first,
      last_seen: last,
      scopes: [...scopes],
    });
  }
  return result.sort((a, b) => b.occurrence_count - a.occurrence_count);
}
