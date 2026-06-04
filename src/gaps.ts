import type { GapEvent, GapAggregate, KnownGapResponse, NoIndexMatchResponse } from "./types.js";
import { utcYmd, toJsonLine, parseJsonl, SessionContext } from "./utils.js";

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
 *  The session arg is a SessionContext — the holder lets the trace collector
 *  share one id with this sink for cross-stream join. */
export class BrowserGapSink implements GapSink {
  private readonly sessionId: string;

  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "knowdb-gaps",
    session: SessionContext = new SessionContext()
  ) {
    this.sessionId = session.id;
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
 * include the just-recorded gap, so a non-empty keyword always yields a
 * known_gap; returns null only when the keyword has no recorded gap — e.g. an
 * empty / whitespace-only keyword the sink skips, which the caller renders `[]`.
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

  // The probed *wording* came up empty, not the topic — so this is an honest
  // miss, not a coverage verdict (which would be a confident false gap).
  return {
    status: "known_gap",
    message: `Known gap: the keyword "${top.topic}" returned no results ${count} times.`,
    gap_info: { topic: top.topic, occurrence_count: count, first_seen: top.first_seen },
    recommendation:
      "The probed wording is uncovered in the current knowledge base; this does not confirm the topic is absent — the corpus may use different wording. Retry with alternative or related terms (synonyms, the corpus's own terminology, or the term in another language), or browse the structure (read_index / parent) to locate it.",
  };
}

// ── Index-only discovery miss (a hint, not a gap) ─────────────────────────

/**
 * Hint for an index_only search that matched no heading tree. NOT a gap and
 * never recorded: a heading miss is weaker evidence than a content miss (the
 * content may not appear in any heading), so counting it would pollute the gap
 * hotspot. The hint replaces a silent empty result so the agent escalates to a
 * content search instead of assuming the topic is absent.
 */
export function noIndexMatch(keyword: string): NoIndexMatchResponse {
  return {
    status: "no_index_match",
    message: `No document's heading tree matched "${keyword}".`,
    recommendation:
      "No heading matched the probed wording — this does not mean the content is absent (it may not appear in a heading). Broaden or rephrase the term, run a full-content search (index_only: false), call list_docs to see what exists, or browse a likely document's structure (read_index / parent).",
  };
}
