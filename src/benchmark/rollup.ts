import type { QueryTrace, ToolCallEvent } from "../types.js";
import type {
  BenchmarkProblem,
  TurnResult,
  VariantAggregate,
  VariantAssignment,
} from "./types.js";

// ── small numeric helpers (rates over empty sets → 0, documented) ──────────

function rate(pass: number, total: number): number {
  return total === 0 ? 0 : pass / total;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Least-squares slope of y over x. Undefined (returns null) when x has no
// spread — a single-turn thread can't show degradation.
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

// Chunk ids the agent actually read (read_chunk / read_chunks). Discovery and
// index reads don't count as passage hits.
function readChunkIds(trace: QueryTrace): string[] {
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

// T15 — mirrors src/traces.ts aggregateMetrics: fraction of read_chunk calls
// that engaged the `pattern` filter. null when there are no read_chunk calls.
function patternUsageRate(traces: QueryTrace[]): number | null {
  const readChunks = traces.flatMap((t) => t.tool_calls).filter((c) => c.tool === "read_chunk");
  if (readChunks.length === 0) return null;
  const withPattern = readChunks.filter((c) => Boolean(c.input["pattern"]));
  return withPattern.length / readChunks.length;
}

// Mirrors src/traces.ts: mean read_chunk output length split by pattern use —
// the char-cost gap between a filtered window and a full-body dump. Prefers the
// raw pre-truncate length; falls back to summary length for legacy traces.
// Empty group → 0 (mean of []).
function readChunkOutputChars(traces: QueryTrace[]): { with_pattern: number; without_pattern: number } {
  const readChunks = traces.flatMap((t) => t.tool_calls).filter((c) => c.tool === "read_chunk");
  const rawChars = (c: ToolCallEvent) => c.output_chars ?? c.output_summary.length;
  return {
    with_pattern: mean(readChunks.filter((c) => Boolean(c.input["pattern"])).map(rawChars)),
    without_pattern: mean(readChunks.filter((c) => !c.input["pattern"]).map(rawChars)),
  };
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

  const within = rs.filter((r) => r.classification_actual === "within_doc");
  const cross = rs.filter((r) => r.classification_actual === "cross_doc");
  const followups = rs.filter((r) => r.is_followup);
  const reportedGaps = rs.filter((r) => r.explicit_gap_reported);

  // ── B11 per-thread metrics ──
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
      const expected = new Set(problem.turns.flatMap((t) => t.expected_chunk_ids ?? []));
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
    explicit_gap_rate: rate(reportedGaps.length, rs.length),
    // null when no gaps reported; 0 already means "every reported gap was false".
    abstention_precision:
      reportedGaps.length === 0
        ? null
        : reportedGaps.filter((r) => !r.answerable).length / reportedGaps.length,
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
