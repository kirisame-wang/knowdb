import { describe, it, expect } from "vitest";
import { computeReport } from "../../src/benchmark/compute-report.js";
import type {
  BenchmarkProblem,
  BenchmarkRun,
  HumanGrade,
  VariantAssignment,
} from "../../src/benchmark/types.js";
import type { QueryTrace, ToolCallEvent } from "../../src/types.js";

// ── Fixture: one 3-turn thread (t001), run under variants A and B ────────────
// turn0 answerable, standalone, within-doc; turn1 answerable, followup;
// turn2 unanswerable (gap), followup. decision_steps per turn = [1, 2, 3] so the
// degradation slope over turn_index [0,1,2] is exactly 1.

function call(tool: string, input: Record<string, unknown> = {}, output_summary = ""): ToolCallEvent {
  return { ordinal: 1, tool, input, output_summary, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
}

const KNOWN_GAP = JSON.stringify({ status: "known_gap", message: "x" });

function trace(query_id: string, calls: ToolCallEvent[], input: number, output: number): QueryTrace {
  return {
    source: "browser",
    query_id,
    user_question: "Q",
    started_at: "2026-06-03T00:00:00Z",
    ended_at: "2026-06-03T00:00:01Z",
    tool_calls: calls,
    api_rounds: [{ ordinal: 1, input_tokens: input, output_tokens: output, duration_ms: 0 }],
    final_answer: "answer",
  };
}

// Per-turn tool-call shapes shared by both variants (identical navigation, so
// classification / steps / coverage are variant-independent; only grades differ).
const turnCalls = [
  [call("read_chunk", { id: "abc/01" })], // turn0: within_doc, 1 step
  [call("read_chunk", { id: "abc/01" }), call("read_chunk", { id: "abc/03" })], // turn1: within_doc, 2 steps
  [call("search", { keyword: "z" }, KNOWN_GAP), call("search", { keyword: "z2" }), call("read_index", { id: "abc" })], // turn2: gap, within_doc, 3 steps
];

const problem: BenchmarkProblem = {
  id: "t001",
  domain: "mcp",
  thread_type: "symmetric",
  turns: [
    { turn_index: 0, question: "q0", is_followup: false, turn_type: "symmetric", answerable: true, expected_doc_ids: ["abc"], expected_chunk_ids: ["abc/01", "abc/02"], expected_answer_keypoints: ["k"], expected_classification: "within_doc" },
    { turn_index: 1, question: "q1", is_followup: true, turn_type: "symmetric", answerable: true, expected_doc_ids: ["abc"], expected_chunk_ids: ["abc/03"], expected_answer_keypoints: ["k"], expected_classification: "within_doc" },
    { turn_index: 2, question: "q2", is_followup: true, turn_type: "symmetric", answerable: false, expected_doc_ids: [], expected_chunk_ids: [], expected_answer_keypoints: ["report not found"], expected_classification: "within_doc" },
  ],
};

const run: BenchmarkRun = {
  run_id: "run-test",
  model: "claude-opus-4-7",
  temperature: 0,
  max_tokens: 4096,
  knowdb_commit_sha: "deadbeef",
  tool_set_version: "v1",
  problem_set_id: "corpus-test",
  variants: ["A", "B"],
  started_at: "2026-06-03T00:00:00Z",
  ended_at: "2026-06-03T01:00:00Z",
  reviewer: "tester",
};

// Variant A: tokens 100/50; turn1 fails rubric_2 → success_rate 2/3.
// Variant B: tokens 200/100; all pass → success_rate 1.
function buildVariant(v: string, input: number, output: number, failTurn1: boolean) {
  const traces: QueryTrace[] = turnCalls.map((calls, i) => trace(`q_${v}_${i}`, calls, input, output));
  const assignments: VariantAssignment[] = traces.map((t, i) => ({
    query_id: t.query_id,
    variant: v,
    problem_id: "t001",
    turn_index: i,
    assigned_at: "2026-06-03T00:00:00Z",
  }));
  const grades: HumanGrade[] = traces.map((t, i) => ({
    problem_id: "t001",
    turn_index: i,
    query_id: t.query_id,
    variant: v,
    rubric_1_covers_keypoints: true,
    rubric_2_citations_valid: !(failTurn1 && i === 1),
    reviewer: "tester",
    graded_at: "2026-06-03T00:30:00Z",
  }));
  return { traces, assignments, grades };
}

const A = buildVariant("A", 100, 50, true);
const B = buildVariant("B", 200, 100, false);

// A dogfooding trace with NO side-car assignment — must be skipped entirely.
const dogfooding = trace("q_dogfood", [call("read_chunk", { id: "zzz/01" })], 999, 999);

const report = computeReport(
  [...A.traces, ...B.traces, dogfooding],
  [], // gapEvents — reserved cross-check, unused here
  [...A.assignments, ...B.assignments],
  [problem],
  [...A.grades, ...B.grades],
  run,
);

describe("computeReport (B7/B11) — end-to-end pipeline", () => {
  it("skips traces absent from the side-car (dogfooding isolation)", () => {
    expect(report.results).toHaveLength(6);
    expect(report.results.some((r) => r.query_id === "q_dogfood")).toBe(false);
  });

  it("emits one aggregate per declared variant, in declared order", () => {
    expect(report.aggregates.map((a) => a.variant)).toEqual(["A", "B"]);
  });

  it("variant A rollup matches hand-computed values", () => {
    const a = report.aggregates.find((x) => x.variant === "A")!;
    expect(a.turn_count).toBe(3);
    expect(a.thread_count).toBe(1);
    expect(a.success_rate).toBeCloseTo(2 / 3);
    expect(a.within_doc_success_rate).toBeCloseTo(2 / 3); // all 3 within_doc
    expect(a.cross_doc_success_rate).toBe(0); // no cross_doc turns
    expect(a.explicit_gap_rate).toBeCloseTo(1 / 3); // only turn2
    expect(a.avg_decision_steps).toBe(2); // (1+2+3)/3
    expect(a.avg_tokens).toEqual({ input: 100, output: 50 });
    expect(a.read_chunk_pattern_usage_rate).toBe(0); // 3 read_chunk, none with pattern
    expect(a.followup_success_rate).toBeCloseTo(0.5); // turn1 fail, turn2 pass
    expect(a.turn_degradation_slope).toBeCloseTo(1); // steps [1,2,3]
    expect(a.cumulative_passage_coverage).toBeCloseTo(2 / 3); // hit {abc/01,abc/03} of {abc/01,abc/02,abc/03}
  });

  it("variant B rollup differs only where grades/tokens differ", () => {
    const b = report.aggregates.find((x) => x.variant === "B")!;
    expect(b.success_rate).toBe(1);
    expect(b.followup_success_rate).toBe(1);
    expect(b.avg_tokens).toEqual({ input: 200, output: 100 });
    expect(b.turn_degradation_slope).toBeCloseTo(1);
    expect(b.cumulative_passage_coverage).toBeCloseTo(2 / 3);
  });

  it("deltas: b_minus_a headline + undefined grep_cat ratio when baseline absent", () => {
    expect(report.deltas.b_minus_a_success_rate).toBeCloseTo(1 / 3);
    expect(report.deltas.knowdb_vs_grep_cat_token_ratio).toBeUndefined();
  });

  it("per-turn TurnResult carries classification / gap / followup", () => {
    const a2 = report.results.find((r) => r.query_id === "q_A_2")!;
    expect(a2.classification_actual).toBe("within_doc");
    expect(a2.explicit_gap_reported).toBe(true);
    expect(a2.is_followup).toBe(true);
    expect(a2.answerable).toBe(false);
    expect(a2.decision_steps).toBe(3);
  });
});

describe("computeReport — contract guards", () => {
  it("throws on a graded trace whose problem is unknown", () => {
    const orphan = trace("q_orphan", turnCalls[0]!, 100, 50);
    expect(() =>
      computeReport(
        [orphan], [],
        [{ query_id: "q_orphan", variant: "A", problem_id: "ghost", turn_index: 0, assigned_at: "x" }],
        [problem],
        [{ problem_id: "ghost", turn_index: 0, query_id: "q_orphan", variant: "A", rubric_1_covers_keypoints: true, rubric_2_citations_valid: true, reviewer: "t", graded_at: "x" }],
        run,
      ),
    ).toThrow(/ghost/);
  });

  it("throws when a benchmark trace has no grade", () => {
    const t = trace("q_ungraded", turnCalls[0]!, 100, 50);
    expect(() =>
      computeReport(
        [t], [],
        [{ query_id: "q_ungraded", variant: "A", problem_id: "t001", turn_index: 0, assigned_at: "x" }],
        [problem],
        [],
        run,
      ),
    ).toThrow(/grade/i);
  });
});
