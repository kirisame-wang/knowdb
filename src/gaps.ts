import type { GapEvent, GapAggregate, KnownGapResponse } from "./types.js";

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

// ── Sink (G3 — two impls share one JSONL schema) ──────────────────────────────

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
    private readonly key = "knowdb-gaps"
  ) {}

  record(event: GapEvent): void {
    this.store.setItem(this.key, (this.store.getItem(this.key) ?? "") + serializeGap(event) + "\n");
  }

  readAll(): GapEvent[] {
    return parseGapsJsonl(this.store.getItem(this.key) ?? "");
  }

  /** Raw JSONL for the Demo's user-triggered download (ui.ts wraps in a Blob). */
  dump(): string {
    return this.store.getItem(this.key) ?? "";
  }
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

// ── Known-gap check (G8 — pure; caller records the current gap first) ──────────

/**
 * Decide whether an empty search hit a known gap. `events` must already
 * include the just-recorded gap (spec §4). Returns null below MID so the
 * caller keeps the original `[]` behavior (backward compatible).
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
