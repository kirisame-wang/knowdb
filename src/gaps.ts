import type { GapEvent, GapAggregate, KnownGapResponse } from "./types.js";
import {
  utcYmd,
  newSessionId,
  toJsonLine,
  parseJsonl,
  nextDailySeq as nextDailySeqGeneric,
  SessionContext,
  sessionId as resolveSessionId,
} from "./utils.js";

// Re-export the generic counter under the path gap callers already use,
// so existing imports (`from "../src/gaps.js"`) keep working.
export { nextDailySeqGeneric as nextDailySeq, SessionContext };

// ── Known-gap thresholds (tunable) ────────────────────────────────────────

/** ≥ HIGH occurrences → "not in coverage". */
export const HIGH = 10;
/** ≥ MID (and < HIGH) → "try alternative keywords". */
export const MID = 3;

// ── Keyword normalization (deterministic, no LLM) ────────────────────────

export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Simple-OR detector — the contract's supported shape: keyword contains
 * `|` and no other regex metacharacter. Out-of-contract metachars
 * (`. * + ? ^ $ { } ( ) [ ] \`) disqualify; such keywords fall back to a
 * single raw topic everywhere `|`-splitting is used.
 */
export function isSimpleOR(keyword: string): boolean {
  return keyword.includes("|") && !/[.*+?^${}()[\]\\]/.test(keyword);
}

/**
 * Record-time decomposition. Simple-OR → one keyword per alternative
 * (minimally trimmed, original case preserved so `GapEvent.keyword` stays
 * raw). Single-term or out-of-contract regex → `[keyword]` (one event).
 */
export function expandKeywordToTopics(keyword: string): string[] {
  if (!isSimpleOR(keyword)) return [keyword];
  const alts = keyword.split("|").map((s) => s.trim()).filter(Boolean);
  return alts.length > 0 ? alts : [keyword];
}

/**
 * Concept-shaped grouping key. Simple-OR keywords share a canonical key
 * regardless of order/case/spacing (`a|b`, `b|a`, `A | B` → `a|b`).
 * Single-term → its normalized form. Out-of-contract regex containing
 * `|` (e.g. `foo(a|b)`) returns the normalized raw keyword as ONE topic
 * — `|` is NOT split when other regex metachars are present, because a
 * lexical split would produce garbage like `b)|foo(a`. Empty / `|`-only /
 * pure-whitespace input returns `""` — callers (e.g.
 * `BrowserGapSink.record`) treat the empty key as non-recordable.
 * Deterministic, no LLM.
 */
export function gapTopicKey(keyword: string): string {
  if (!isSimpleOR(keyword) && keyword.includes("|")) {
    // Out-of-contract regex containing `|`: do NOT split.
    return normalizeKeyword(keyword);
  }
  return [...new Set(keyword.split("|").map(normalizeKeyword).filter(Boolean))]
    .sort()
    .join("|");
}

// ── Gap id ────────────────────────────────────────────────────────────────────

/** "gap_<yyyymmdd>_<seq3>" in UTC. `seq` is the per-day sequence (1-based). */
export function makeGapId(date: Date, seq: number): string {
  return `gap_${utcYmd(date)}_${String(seq).padStart(3, "0")}`;
}

// `nextDailySeq` for gaps is the generic helper from utils, re-exported above.

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

/** Browser sink: appends JSONL to localStorage; dump() feeds the export button.
 *  The session arg accepts a SessionContext (preferred — lets trace/gap share
 *  one id) or a bare string (legacy path for direct id injection). */
export class BrowserGapSink implements GapSink {
  private readonly sessionId: string;

  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "knowdb-gaps",
    session: SessionContext | string = newSessionId()
  ) {
    this.sessionId = resolveSessionId(session);
  }

  record(event: GapEvent): void {
    // Skip events with an empty canonical key (empty / |-only / whitespace
    // keyword). Symmetric with query.sh's CLI guard; keeps aggregate clean.
    if (!gapTopicKey(event.keyword)) return;
    const stamped: GapEvent = { ...event, session_id: this.sessionId };
    this.store.setItem(this.key, (this.store.getItem(this.key) ?? "") + toJsonLine(stamped) + "\n");
  }

  readAll(): GapEvent[] {
    return parseJsonl<GapEvent>(this.store.getItem(this.key) ?? "");
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
    const topic = gapTopicKey(e.keyword);
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
  // Decompose simple-OR input into its alternatives so a query like `a|b`
  // matches any alternative that has accumulated misses via record-time
  // fan-out. Single-term and out-of-contract regex stay as one lookup.
  const aggs = aggregate(events);
  const topics = expandKeywordToTopics(keyword).map((alt) => gapTopicKey(alt));
  const matches = topics
    .map((t) => aggs.find((a) => a.topic === t))
    .filter((a): a is GapAggregate => !!a);
  if (matches.length === 0) return null;
  const top = matches.reduce((m, c) =>
    c.occurrence_count > m.occurrence_count ? c : m
  );
  const count = top.occurrence_count;
  if (count < MID) return null;

  const recommendation =
    count >= HIGH
      ? "This topic is not within the current knowledge base's coverage."
      : "Try alternative keywords or a higher-level concept.";

  return {
    status: "known_gap",
    message: `Known gap: "${top.topic}" has returned no results ${count} times.`,
    gap_info: { topic: top.topic, occurrence_count: count, first_seen: top.first_seen },
    recommendation,
  };
}
