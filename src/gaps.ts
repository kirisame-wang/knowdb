import type { GapEvent, GapAggregate, KnownGapResponse } from "./types.js";
import { serializeGap, parseGapsJsonl, newSessionId } from "./utils.js";

// ── Known-gap thresholds (tunable) ────────────────────────────────────────

/** ≥ HIGH occurrences → "not in coverage". */
export const HIGH = 10;
/** ≥ MID (and < HIGH) → "try alternative keywords". */
export const MID = 3;

// ── Keyword normalization (deterministic, no LLM) ────────────────────────

export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Sink (two impls share one JSONL schema) ──────────────────────────────

export interface GapSink {
  record(event: GapEvent): void;
  /** Returns a snapshot — a later record() must not mutate a prior result. */
  readAll(): GapEvent[];
}

/** Minimal Storage surface — `window.localStorage` satisfies this. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Browser sink: appends JSONL to localStorage; dump() feeds the export button. */
export class BrowserGapSink implements GapSink {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "knowdb-gaps",
    private readonly sessionId: string = newSessionId()
  ) {}

  record(event: GapEvent): void {
    const stamped: GapEvent = { ...event, session_id: this.sessionId };
    this.store.setItem(this.key, (this.store.getItem(this.key) ?? "") + serializeGap(stamped) + "\n");
  }

  readAll(): GapEvent[] {
    return parseGapsJsonl(this.store.getItem(this.key) ?? "");
  }

  /** Raw JSONL for the Demo's user-triggered download (ui.ts wraps in a Blob). */
  dump(): string {
    return this.store.getItem(this.key) ?? "";
  }
}

// ── Aggregation (pure, deterministic) ────────────────────────────────────

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

// ── Known-gap check (pure; caller records the current gap first) ──────────

/**
 * Decide whether an empty search hit a known gap. `events` must already
 * include the just-recorded gap. Returns null below MID so the caller
 * keeps the original `[]` behavior (backward compatible).
 */
export function checkKnownGap(events: GapEvent[], keyword: string): KnownGapResponse | null {
  const topic = normalizeKeyword(keyword);
  const agg = aggregate(events).find((a) => a.topic === topic);
  const count = agg?.occurrence_count ?? 0;
  if (count < MID) return null;

  const recommendation =
    count >= HIGH ? "此主題不在當前知識庫覆蓋範圍內" : "嘗試替代關鍵字或更上層的概念";

  return {
    status: "known_gap",
    message: `已知缺口：『${keyword.trim()}』已被查詢 ${count} 次都無結果`,
    gap_info: { topic, occurrence_count: count, first_seen: agg!.first_seen },
    recommendation,
  };
}
