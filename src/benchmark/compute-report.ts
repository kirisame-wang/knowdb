import type { GapEvent, QueryTrace } from "../types.js";
import { classifyQuery } from "./classify.js";
import { detectExplicitGap, encounteredKnownGap } from "./detect-gap.js";
import { readChunkIds, rollupVariant } from "./rollup.js";
import type {
  AxisDelta,
  BenchmarkProblem,
  BenchmarkReport,
  BenchmarkRun,
  BenchmarkTurn,
  HumanGrade,
  TurnResult,
  VariantAssignment,
} from "./types.js";

// B1 — MVP success oracle, judge-free. An answerable turn succeeds when the agent
// read the turn's minimal sufficient chunk set (⊇); an unanswerable turn succeeds
// when it reported the gap rather than fabricating. An answerable turn without
// chunk-level ground truth can't be confirmed → false (corpus must author
// expected_chunk_ids for answerable turns).
export function reachSuccess(turn: BenchmarkTurn, trace: QueryTrace): boolean {
  if (turn.answerable) {
    const expected = turn.expected_chunk_ids ?? [];
    if (expected.length === 0) return false;
    const read = new Set(readChunkIds(trace));
    return expected.every((id) => read.has(id));
  }
  return detectExplicitGap(trace);
}

// MVP derives success from reachSuccess (judge-free); an optional human grade
// overrides it for answer-quality / hallucination claims (per-turn, so a graded
// sample and reach-scored rest coexist).
export function successOf(turn: BenchmarkTurn, trace: QueryTrace, grade?: HumanGrade): boolean {
  if (grade) return grade.rubric_1_covers_keypoints && grade.rubric_2_citations_valid;
  return reachSuccess(turn, trace);
}

// Ablation convention: the full-config variant is the baseline every axis-off
// variant is measured against. grep+cat is an external comparison, not an
// ablation axis, so it is excluded from per_axis.
const BASELINE_VARIANT = "full";
const EXTERNAL_VARIANT = "baseline_grep_cat";

// Pure synthesis from raw trace + side-car + rubric. Same inputs → same output;
// this is the single official source for published numbers.
//
// Variant association rides the side-car: a trace absent from the side-car is
// treated as non-benchmark (e.g. dogfooding) and skipped, so a dogfooding dump
// accidentally merged in cannot move the numbers.
//
// `gapEvents` is reserved for the trace × gap cross-check (parity with
// data-layer's GapEvent.query_id join); the headline pipeline does not consume
// it yet.
export function computeReport(
  traces: QueryTrace[],
  gapEvents: GapEvent[],
  variantAssignments: VariantAssignment[],
  problems: BenchmarkProblem[],
  grades: HumanGrade[],
  run: BenchmarkRun,
): BenchmarkReport {
  void gapEvents;

  const assignOf = new Map(variantAssignments.map((a) => [a.query_id, a]));
  const problemOf = new Map(problems.map((p) => [p.id, p]));
  const gradeOf = new Map(grades.map((g) => [g.query_id, g]));

  const results: TurnResult[] = traces
    .filter((t) => assignOf.has(t.query_id)) // not in side-car → non-benchmark, skip
    .map((t) => {
      const a = assignOf.get(t.query_id)!;
      const problem = problemOf.get(a.problem_id);
      if (!problem) throw new Error(`Unknown problem ${a.problem_id}`);
      const turn = problem.turns.find((x) => x.turn_index === a.turn_index);
      if (!turn) throw new Error(`Unknown turn ${a.problem_id}#${a.turn_index}`);
      const grade = gradeOf.get(t.query_id); // optional: present → answer-quality override; absent → reach oracle
      return {
        problem_id: a.problem_id,
        turn_index: a.turn_index,
        query_id: t.query_id,
        variant: a.variant,
        is_followup: turn.is_followup,
        turn_type: turn.turn_type,
        answerable: turn.answerable,
        success: successOf(turn, t, grade),
        classification_actual: classifyQuery(t),
        explicit_gap_reported: detectExplicitGap(t),
        encountered_gap_signal: encounteredKnownGap(t),
        decision_steps: t.tool_calls.length,
        tokens: {
          input: t.api_rounds.reduce((s, r) => s + r.input_tokens, 0),
          output: t.api_rounds.reduce((s, r) => s + r.output_tokens, 0),
        },
      };
    });

  const aggregates = run.variants.map((v) => rollupVariant(v, results, traces, assignOf, problemOf));
  const full = aggregates.find((x) => x.variant === BASELINE_VARIANT);
  const external = aggregates.find((x) => x.variant === EXTERNAL_VARIANT);

  // per-axis delta = full − axis-off (the external grep+cat comparison is not an axis)
  const per_axis: AxisDelta[] = full
    ? aggregates
        .filter((x) => x.variant !== BASELINE_VARIANT && x.variant !== EXTERNAL_VARIANT)
        .map((x) => ({
          variant: x.variant,
          success_rate_delta: full.success_rate - x.success_rate,
          decision_steps_delta: x.avg_decision_steps - full.avg_decision_steps,
          explicit_gap_rate_delta: full.explicit_gap_rate - x.explicit_gap_rate,
        }))
    : [];

  return {
    run,
    results,
    aggregates,
    deltas: {
      baseline_variant: BASELINE_VARIANT,
      per_axis,
      ...(full && external
        ? {
            knowdb_vs_grep_cat_token_ratio: {
              input: full.avg_tokens.input / external.avg_tokens.input,
              output: full.avg_tokens.output / external.avg_tokens.output,
            },
          }
        : {}),
    },
  };
}
