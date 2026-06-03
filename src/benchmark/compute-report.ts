import type { GapEvent, QueryTrace } from "../types.js";
import { classifyQuery } from "./classify.js";
import { detectExplicitGap } from "./detect-gap.js";
import { rollupVariant } from "./rollup.js";
import type {
  BenchmarkProblem,
  BenchmarkReport,
  BenchmarkRun,
  HumanGrade,
  TurnResult,
  VariantAssignment,
} from "./types.js";

// B7 — pure synthesis from raw trace + side-car + rubric. Same inputs → same
// output; this is the single official source for published numbers.
//
// Variant association rides the side-car (B4): a trace absent from the side-car
// is treated as non-benchmark (e.g. dogfooding) and skipped, so a dogfooding
// dump accidentally merged in cannot move the numbers.
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
      const grade = gradeOf.get(t.query_id);
      if (!grade) throw new Error(`Missing grade for query ${t.query_id}`);
      return {
        problem_id: a.problem_id,
        turn_index: a.turn_index,
        query_id: t.query_id,
        variant: a.variant,
        is_followup: turn.is_followup,
        turn_type: turn.turn_type,
        answerable: turn.answerable,
        success: grade.rubric_1_covers_keypoints && grade.rubric_2_citations_valid,
        classification_actual: classifyQuery(t),
        explicit_gap_reported: detectExplicitGap(t),
        decision_steps: t.tool_calls.length,
        tokens: {
          input: t.api_rounds.reduce((s, r) => s + r.input_tokens, 0),
          output: t.api_rounds.reduce((s, r) => s + r.output_tokens, 0),
        },
      };
    });

  const aggregates = run.variants.map((v) => rollupVariant(v, results, traces, assignOf, problemOf));
  const a = aggregates.find((x) => x.variant === "A");
  const b = aggregates.find((x) => x.variant === "B");
  const baseline = aggregates.find((x) => x.variant === "baseline_grep_cat");

  return {
    run,
    results,
    aggregates,
    deltas: {
      b_minus_a_success_rate: b && a ? b.success_rate - a.success_rate : NaN,
      ...(b && baseline
        ? {
            knowdb_vs_grep_cat_token_ratio: {
              input: b.avg_tokens.input / baseline.avg_tokens.input,
              output: b.avg_tokens.output / baseline.avg_tokens.output,
            },
          }
        : {}),
    },
  };
}
