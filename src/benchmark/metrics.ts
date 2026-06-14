import type { QueryTrace, ToolCallEvent } from "../types.js";
import type {
  BenchmarkProblem,
  BenchmarkTurn,
  HumanGrade,
  TurnResult,
  VariantAggregate,
  VariantAssignment,
} from "./types.js";

// Leaf pure functions: the per-turn / per-variant values computeReport assembles.
// The orchestrator imports from here, never the reverse.

function rate(pass: number, total: number): number {
  return total === 0 ? 0 : pass / total;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Least-squares slope of y over x. Returns null when x has no spread — a
// single-turn thread can't show degradation.
function linregSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const xbar = mean(xs);
  const ybar = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xbar;
    num += dx * (ys[i]! - ybar);
    den += dx * dx;
  }
  return den === 0 ? null : num / den;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const bucket = m.get(k);
    if (bucket) bucket.push(it);
    else m.set(k, [it]);
  }
  return m;
}

// Pure classification from `tool_calls` — the *actual* path the agent took, no
// ground truth needed: cross_doc when the agent read chunk content in >1 doc.
// Locators are the chunk-content reads, the same calls the reach oracle counts
// (readChunkIds), so the within/cross split stays consistent with the success it
// buckets; discovery and structural calls don't count.
const LOCATORS = new Set(["read_chunk", "read_chunks"]);

function docIdOf(input: Record<string, unknown>): string | undefined {
  const id = input["id"];
  if (typeof id !== "string") return undefined;
  return id.split("/")[0];
}

export function classifyQuery(trace: QueryTrace): "within_doc" | "cross_doc" {
  const docIds = new Set<string>();
  for (const c of trace.tool_calls) {
    if (!LOCATORS.has(c.tool)) continue;
    const docId = docIdOf(c.input);
    if (docId) docIds.add(docId);
  }
  return docIds.size > 1 ? "cross_doc" : "within_doc";
}

// A coverage gap is read only from the structured `known_gap` a `search` returns
// — judge-free, decided by the index, not the agent's own wording.

function isKnownGap(output_summary: string): boolean {
  try {
    const out: unknown = JSON.parse(output_summary);
    return typeof out === "object" && out !== null && (out as { status?: unknown }).status === "known_gap";
  } catch {
    return false;
  }
}

// Did any `search` this turn return known_gap? Serves as both the explicit-gap
// signal and the recovery denominator ("hit a gap", regardless of how the turn ended).
export function encounteredKnownGap(trace: QueryTrace): boolean {
  return trace.tool_calls.some((c) => c.tool === "search" && isKnownGap(c.output_summary));
}

// A turn reports a gap as its terminal outcome: an unanswerable turn that hit the
// gap signal (a correct abstention), or an answerable turn that hit a gap and did
// not recover to an answer. A recovered answerable turn is not a reported gap.
export function terminalGapReported(turn: BenchmarkTurn, trace: QueryTrace, success: boolean): boolean {
  const encountered = encounteredKnownGap(trace);
  return turn.answerable ? encountered && !success : encountered;
}

// Chunk ids the agent actually read (read_chunk / read_chunks). Discovery and
// index reads don't count as passage hits. Shared by the reach oracle and rollup.
export function readChunkIds(trace: QueryTrace): string[] {
  const ids: string[] = [];
  for (const c of trace.tool_calls) {
    if (c.tool !== "read_chunk" && c.tool !== "read_chunks") continue;
    const id = c.input["id"];
    if (typeof id === "string") ids.push(id);
    const many = c.input["ids"];
    if (Array.isArray(many)) for (const m of many) if (typeof m === "string") ids.push(m);
  }
  return ids;
}

// Success oracle, judge-free. Answerable turn: reads ≥1 chunk from each expected
// group (any-of within a group, all groups required), so multi-candidate answers
// don't false-fail; falls back to ⊇-all over expected_chunk_ids when no groups.
// Unanswerable turn: reports the gap.
export function reachSuccess(turn: BenchmarkTurn, trace: QueryTrace): boolean {
  if (turn.answerable) {
    const read = new Set(readChunkIds(trace));
    const groups = turn.expected_chunk_groups;
    if (groups && groups.length > 0) {
      return groups.every((g) => g.some((id) => read.has(id)));
    }
    const expected = turn.expected_chunk_ids ?? [];
    if (expected.length === 0) return false;
    return expected.every((id) => read.has(id));
  }
  return encounteredKnownGap(trace);
}

// Defaults to the reach oracle; an optional human grade overrides it per-turn,
// so graded and reach-scored turns coexist.
export function successOf(turn: BenchmarkTurn, trace: QueryTrace, grade?: HumanGrade): boolean {
  // An overflow (the recorded 400) delivered no answer in budget, so it is never
  // a success — overriding the reach proxy (reading a chunk ≠ answering).
  if (isContextOverflow(trace)) return false;
  if (grade) return grade.rubric_1_covers_keypoints && grade.rubric_2_citations_valid;
  return reachSuccess(turn, trace);
}

// The turn ran out of context budget: messages.create returned a 400 "prompt is
// too long" and the loop recorded it on trace.error. The user got no answer in
// budget, so it is a navigation failure (never a success — see successOf).
export function isContextOverflow(trace: QueryTrace): boolean {
  return /prompt is too long/i.test(trace.error ?? "");
}

// Mirrors src/traces.ts aggregateMetrics: fraction of read_chunk calls that
// engaged the `pattern` filter. null when there are no read_chunk calls.
function patternUsageRate(traces: QueryTrace[]): number | null {
  const readChunks = traces.flatMap((t) => t.tool_calls).filter((c) => c.tool === "read_chunk");
  if (readChunks.length === 0) return null;
  const withPattern = readChunks.filter((c) => Boolean(c.input["pattern"]));
  return withPattern.length / readChunks.length;
}

// Mirrors src/traces.ts: mean read_chunk output length split by `pattern` use.
// output_chars is the pre-truncate length; fall back to summary length if absent.
function readChunkOutputChars(traces: QueryTrace[]): { with_pattern: number; without_pattern: number } {
  const readChunks = traces.flatMap((t) => t.tool_calls).filter((c) => c.tool === "read_chunk");
  const rawChars = (c: ToolCallEvent) => c.output_chars ?? c.output_summary.length;
  return {
    with_pattern: mean(readChunks.filter((c) => Boolean(c.input["pattern"])).map(rawChars)),
    without_pattern: mean(readChunks.filter((c) => !c.input["pattern"]).map(rawChars)),
  };
}

export function rollupVariant(
  variant: string,
  results: TurnResult[],
  traces: QueryTrace[],
  assignOf: Map<string, VariantAssignment>,
  problemOf: Map<string, BenchmarkProblem>,
): VariantAggregate {
  const rs = results.filter((r) => r.variant === variant);
  const ts = traces.filter((t) => assignOf.get(t.query_id)?.variant === variant);
  const traceOf = new Map(ts.map((t) => [t.query_id, t]));

  // Success-by-class partitions on the question's designed type (a stable invariant),
  // not on how many docs the agent happened to read — that varies with stochastic
  // navigation, making classification_actual non-comparable across variants/runs.
  const within = rs.filter((r) => r.expected_classification === "within_doc");
  const cross = rs.filter((r) => r.expected_classification === "cross_doc");
  const followups = rs.filter((r) => r.is_followup);
  const reportedGaps = rs.filter((r) => r.explicit_gap_reported);
  // Answerable turns whose search false-alarmed a gap — the recovery denominator.
  const recoveryCandidates = rs.filter((r) => r.answerable && r.encountered_gap_signal);

  const byThread = groupBy(rs, (r) => r.problem_id);
  const slopes: number[] = [];
  const coverages: number[] = [];
  for (const [problemId, threadResults] of byThread) {
    const ordered = [...threadResults].sort((a, b) => a.turn_index - b.turn_index);
    const slope = linregSlope(
      ordered.map((r) => r.turn_index),
      ordered.map((r) => r.decision_steps),
    );
    if (slope !== null) slopes.push(slope);

    const problem = problemOf.get(problemId);
    if (problem) {
      // Only answerable turns have passages to reach; unanswerable turns' stray
      // expected_chunk_ids (if any) don't count toward coverage.
      const expected = new Set(
        problem.turns.filter((t) => t.answerable).flatMap((t) => t.expected_chunk_ids ?? []),
      );
      if (expected.size > 0) {
        const read = new Set(
          ordered.flatMap((r) => {
            const tr = traceOf.get(r.query_id);
            return tr ? readChunkIds(tr) : [];
          }),
        );
        let hit = 0;
        for (const id of expected) if (read.has(id)) hit++;
        coverages.push(hit / expected.size);
      }
    }
  }

  return {
    variant,
    turn_count: rs.length,
    thread_count: byThread.size,
    success_rate: rate(rs.filter((r) => r.success).length, rs.length),
    within_doc_success_rate: rate(within.filter((r) => r.success).length, within.length),
    cross_doc_success_rate: rate(cross.filter((r) => r.success).length, cross.length),
    // Overflow failures (successOf makes every overflow a non-success, so no
    // !success guard needed), split by navigation: overflow_after_reach = found
    // the chunks then over-searched into the wall; the rest never reached.
    context_overflow_count: rs.filter((r) => r.context_overflow).length,
    overflow_after_reach_count: rs.filter((r) => r.overflow_after_reach).length,
    explicit_gap_rate: rate(reportedGaps.length, rs.length),
    // null when no gaps reported; 0 already means "every reported gap was false".
    abstention_precision:
      reportedGaps.length === 0
        ? null
        : reportedGaps.filter((r) => !r.answerable).length / reportedGaps.length,
    // Both null (not 0) when no candidate — paired, so the steps guard shares
    // recovery_rate's no-signal state (0 would misread as "recovered in 0 steps").
    recovery_rate:
      recoveryCandidates.length === 0
        ? null
        : recoveryCandidates.filter((r) => r.success).length / recoveryCandidates.length,
    recovery_avg_decision_steps:
      recoveryCandidates.length === 0 ? null : mean(recoveryCandidates.map((r) => r.decision_steps)),
    avg_decision_steps: mean(rs.map((r) => r.decision_steps)),
    avg_tokens: {
      input: mean(rs.map((r) => r.tokens.input)),
      output: mean(rs.map((r) => r.tokens.output)),
    },
    read_chunk_pattern_usage_rate: patternUsageRate(ts),
    avg_read_chunk_output_chars: readChunkOutputChars(ts),
    followup_success_rate: rate(followups.filter((r) => r.success).length, followups.length),
    turn_degradation_slope: mean(slopes),
    cumulative_passage_coverage: mean(coverages),
  };
}
