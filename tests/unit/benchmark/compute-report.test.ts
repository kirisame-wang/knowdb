import { describe, it, expect } from "vitest";
import { computeReport } from "../../../src/benchmark/compute-report.js";
import { rollupVariant, successOf } from "../../../src/benchmark/metrics.js";
import type {
  BenchmarkProblem,
  BenchmarkRun,
  BenchmarkTurn,
  HumanGrade,
  TurnResult,
  VariantAssignment,
} from "../../../src/benchmark/types.js";
import type { QueryTrace, ToolCallEvent } from "../../../src/types.js";

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
  variants: ["full", "no_search", "baseline_search_read"], // ablation axes + cost floor
  baseline_variant: "full",                                 // injected baseline role
  external_variant: "baseline_search_read",                 // injected cost-floor role
  started_at: "2026-06-03T00:00:00Z",
  ended_at: "2026-06-03T01:00:00Z",
  reviewer: "tester",
};

// full: tokens 200/100, all pass → success_rate 1 (the baseline).
// no_search (search-off axis): tokens 100/50, turn1 fails → success_rate 2/3.
// baseline_search_read (cost floor): tokens 400/200, all pass → drives token ratio.
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

const FULL = buildVariant("full", 200, 100, false);
const NOSEARCH = buildVariant("no_search", 100, 50, true);
const FLOOR = buildVariant("baseline_search_read", 400, 200, false);

// A dogfooding trace with NO side-car assignment — must be skipped entirely.
const dogfooding = trace("q_dogfood", [call("read_chunk", { id: "zzz/01" })], 999, 999);

const report = computeReport(
  [...FULL.traces, ...NOSEARCH.traces, ...FLOOR.traces, dogfooding],
  [], // gapEvents — reserved cross-check, unused here
  [...FULL.assignments, ...NOSEARCH.assignments, ...FLOOR.assignments],
  [problem],
  [...FULL.grades, ...NOSEARCH.grades, ...FLOOR.grades],
  run,
);

describe("computeReport — end-to-end pipeline", () => {
  it("skips traces absent from the side-car (dogfooding isolation)", () => {
    expect(report.results).toHaveLength(9); // 3 variants × 3 turns
    expect(report.results.some((r) => r.query_id === "q_dogfood")).toBe(false);
  });

  it("emits one aggregate per declared variant, in declared order", () => {
    expect(report.aggregates.map((a) => a.variant)).toEqual(["full", "no_search", "baseline_search_read"]);
  });

  it("no_search axis rollup matches hand-computed values", () => {
    const a = report.aggregates.find((x) => x.variant === "no_search")!;
    expect(a.turn_count).toBe(3);
    expect(a.thread_count).toBe(1);
    expect(a.success_rate).toBeCloseTo(2 / 3);
    expect(a.within_doc_success_rate).toBeCloseTo(2 / 3); // all 3 within_doc
    expect(a.cross_doc_success_rate).toBe(0); // no cross_doc turns
    expect(a.explicit_gap_rate).toBeCloseTo(1 / 3); // only turn2
    expect(a.avg_decision_steps).toBe(2); // (1+2+3)/3
    expect(a.avg_tokens).toEqual({ input: 100, output: 50 });
    expect(a.read_chunk_pattern_usage_rate).toBe(0); // 3 read_chunk, none with pattern
    expect(a.avg_read_chunk_output_chars).toEqual({ with_pattern: 0, without_pattern: 0 }); // empty output_summary, no output_chars
    expect(a.abstention_precision).toBe(1); // only reported gap is turn2 (answerable=false)
    expect(a.recovery_rate).toBeNull(); // turn2 hit known_gap but is unanswerable → not a recovery candidate
    expect(a.recovery_avg_decision_steps).toBeNull();
    expect(a.followup_success_rate).toBeCloseTo(0.5); // turn1 fail, turn2 pass
    expect(a.turn_degradation_slope).toBeCloseTo(1); // steps [1,2,3]
    expect(a.cumulative_passage_coverage).toBeCloseTo(2 / 3); // hit {abc/01,abc/03} of {abc/01,abc/02,abc/03}
  });

  it("full baseline rollup differs only where grades/tokens differ", () => {
    const b = report.aggregates.find((x) => x.variant === "full")!;
    expect(b.success_rate).toBe(1);
    expect(b.followup_success_rate).toBe(1);
    expect(b.avg_tokens).toEqual({ input: 200, output: 100 });
    expect(b.turn_degradation_slope).toBeCloseTo(1);
    expect(b.cumulative_passage_coverage).toBeCloseTo(2 / 3);
  });

  it("deltas: per-axis baseline − axis-off, cost floor excluded from axes", () => {
    expect(report.deltas.baseline_variant).toBe("full");
    expect(report.deltas.external_variant).toBe("baseline_search_read");
    // only no_search is an ablation axis; baseline_search_read is the cost floor
    expect(report.deltas.per_axis.map((d) => d.variant)).toEqual(["no_search"]);
    const ns = report.deltas.per_axis[0]!;
    expect(ns.success_rate_delta).toBeCloseTo(1 / 3); // full 1 − no_search 2/3 (search net contribution)
    expect(ns.decision_steps_delta).toBe(0); // both avg 2
    expect(ns.explicit_gap_rate_delta).toBeCloseTo(0); // both 1/3
  });

  it("deltas: external_token_ratio = baseline / external when the cost floor ran", () => {
    expect(report.deltas.external_token_ratio).toEqual({ input: 0.5, output: 0.5 }); // 200/400, 100/200
  });

  it("per-turn TurnResult carries classification / gap / followup", () => {
    const a2 = report.results.find((r) => r.query_id === "q_no_search_2")!;
    expect(a2.classification_actual).toBe("within_doc");
    expect(a2.explicit_gap_reported).toBe(true);
    expect(a2.encountered_gap_signal).toBe(true); // turn2's search returned known_gap
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

  it("no grade → success derived from reach oracle (B1), not a throw", () => {
    // problem turn0 is answerable, expected_chunk_ids = [abc/01, abc/02]; reach both → success.
    const t = trace("q_ungraded", [call("read_chunk", { id: "abc/01" }), call("read_chunk", { id: "abc/02" })], 100, 50);
    const rep = computeReport(
      [t], [],
      [{ query_id: "q_ungraded", variant: "A", problem_id: "t001", turn_index: 0, assigned_at: "x" }],
      [problem],
      [], // no grades — MVP reach oracle
      { ...run, variants: ["A"] },
    );
    expect(rep.results[0]!.success).toBe(true);
  });
});

// The compute layer is domain-agnostic: baseline / cost-floor roles come from the
// run, not hardcoded variant strings. Arbitrary role names ("cfg_a"/"cfg_b") must
// compute the same deltas — proof no variant literal survives in the compute layer.
describe("computeReport — variant roles injected (domain-agnostic)", () => {
  const A = buildVariant("cfg_a", 200, 100, false);      // baseline role
  const X = buildVariant("cfg_axisoff", 100, 50, true);  // an ablation axis
  const F = buildVariant("cfg_b", 400, 200, false);      // cost-floor role
  const rolesRun: BenchmarkRun = {
    ...run, variants: ["cfg_a", "cfg_axisoff", "cfg_b"], baseline_variant: "cfg_a", external_variant: "cfg_b",
  };
  const rep = computeReport(
    [...A.traces, ...X.traces, ...F.traces], [],
    [...A.assignments, ...X.assignments, ...F.assignments],
    [problem],
    [...A.grades, ...X.grades, ...F.grades],
    rolesRun,
  );

  it("baseline / external echo the injected role names", () => {
    expect(rep.deltas.baseline_variant).toBe("cfg_a");
    expect(rep.deltas.external_variant).toBe("cfg_b");
  });

  it("per_axis excludes both the injected baseline and the injected cost-floor role", () => {
    expect(rep.deltas.per_axis.map((d) => d.variant)).toEqual(["cfg_axisoff"]);
  });

  it("external_token_ratio = injected-baseline / injected-external tokens", () => {
    expect(rep.deltas.external_token_ratio).toEqual({ input: 0.5, output: 0.5 }); // 200/400, 100/200
  });

  it("external_token_ratio absent when the declared cost floor did not run", () => {
    const rep2 = computeReport(
      [...A.traces, ...X.traces], [],
      [...A.assignments, ...X.assignments],
      [problem],
      [...A.grades, ...X.grades],
      { ...rolesRun, variants: ["cfg_a", "cfg_axisoff"] }, // cfg_b declared as role but absent from this run
    );
    expect(rep2.deltas.external_token_ratio).toBeUndefined();
    expect(rep2.deltas.external_variant).toBe("cfg_b"); // role still echoed
  });

  it("a run that declares no cost floor omits both the external role and the ratio", () => {
    const noFloorRun: BenchmarkRun = { ...rolesRun, variants: ["cfg_a", "cfg_axisoff"] };
    delete (noFloorRun as { external_variant?: string }).external_variant;
    const rep3 = computeReport(
      [...A.traces, ...X.traces], [],
      [...A.assignments, ...X.assignments],
      [problem],
      [...A.grades, ...X.grades],
      noFloorRun,
    );
    expect(rep3.deltas.external_variant).toBeUndefined();
    expect(rep3.deltas.external_token_ratio).toBeUndefined();
    expect(rep3.deltas.per_axis.map((d) => d.variant)).toEqual(["cfg_axisoff"]);
  });

  it("a run whose baseline variant did not run yields empty deltas, not a throw", () => {
    const rep4 = computeReport(
      [...X.traces], [],
      [...X.assignments],
      [problem],
      [...X.grades],
      { ...rolesRun, variants: ["cfg_axisoff"] }, // baseline cfg_a absent from this run
    );
    expect(rep4.deltas.per_axis).toEqual([]);
    expect(rep4.deltas.external_token_ratio).toBeUndefined();
  });
});

// B1 — judge-free reach oracle: success ＝ answerable turn reaches its minimal
// sufficient chunk set (⊇), unanswerable turn correctly reports the gap. An
// optional human grade overrides it for answer-quality claims.
describe("successOf — reach oracle (B1) + optional grade override", () => {
  function aTurn(over: Partial<BenchmarkTurn>): BenchmarkTurn {
    return {
      turn_index: 0, question: "q", is_followup: false, turn_type: "symmetric",
      answerable: true, expected_doc_ids: ["abc"], expected_chunk_ids: ["abc/01", "abc/02"],
      expected_answer_keypoints: ["k"], expected_classification: "within_doc", ...over,
    };
  }
  const tr = (calls: ToolCallEvent[]) => trace("q", calls, 0, 0);

  it("answerable: success when all expected_chunk_ids reached (⊇)", () => {
    expect(successOf(aTurn({}), tr([call("read_chunk", { id: "abc/01" }), call("read_chunk", { id: "abc/02" })]))).toBe(true);
  });

  it("answerable: fail when an expected chunk is missed", () => {
    expect(successOf(aTurn({}), tr([call("read_chunk", { id: "abc/01" })]))).toBe(false);
  });

  it("answerable: read_chunks (plural) ids count toward reach", () => {
    expect(successOf(aTurn({ expected_chunk_ids: ["a", "b"] }), tr([call("read_chunks", { ids: ["a", "b"] })]))).toBe(true);
  });

  it("answerable without chunk-level ground truth → false (cannot confirm reach)", () => {
    expect(successOf(aTurn({ expected_chunk_ids: [] }), tr([call("read_chunk", { id: "x" })]))).toBe(false);
  });

  it("unanswerable: success when the gap is reported", () => {
    expect(successOf(aTurn({ answerable: false, expected_chunk_ids: [] }), tr([call("search", { keyword: "z" }, KNOWN_GAP)]))).toBe(true);
  });

  it("unanswerable: fail when no gap reported (fabricated answer)", () => {
    expect(successOf(aTurn({ answerable: false, expected_chunk_ids: [] }), tr([call("read_chunk", { id: "x" })]))).toBe(false);
  });

  it("unanswerable: prose 'not found' alone no longer counts — structured known_gap required", () => {
    const t: QueryTrace = { ...tr([call("read_chunk", { id: "x" })]), final_answer: "Sorry, not covered here." };
    expect(successOf(aTurn({ answerable: false, expected_chunk_ids: [] }), t)).toBe(false);
  });

  it("grade overrides reach (answer-quality layer)", () => {
    const grade: HumanGrade = { problem_id: "p", turn_index: 0, query_id: "q", variant: "V", rubric_1_covers_keypoints: true, rubric_2_citations_valid: true, reviewer: "r", graded_at: "x" };
    // reach would fail (missed abc/02), but grade says pass → success
    expect(successOf(aTurn({}), tr([call("read_chunk", { id: "abc/01" })]), grade)).toBe(true);
  });
});

describe("computeReport — recovery_rate end-to-end (non-null path through real detection)", () => {
  it("an answerable turn whose search false-alarmed a gap, then recovered, yields recovery_rate 1", () => {
    const recProblem: BenchmarkProblem = {
      id: "trec", domain: "mcp", thread_type: "lexical_gap",
      turns: [{ turn_index: 0, question: "q", is_followup: false, turn_type: "lexical_gap", answerable: true, expected_doc_ids: ["abc"], expected_answer_keypoints: ["k"], expected_classification: "within_doc" }],
    };
    // search known_gap (false alarm on answerable content) → read_chunk → answered.
    const recTrace = trace("q_rec", [call("search", { keyword: "cashflow" }, KNOWN_GAP), call("read_chunk", { id: "abc/01" })], 50, 25);
    const rep = computeReport(
      [recTrace], [],
      [{ query_id: "q_rec", variant: "full", problem_id: "trec", turn_index: 0, assigned_at: "x" }],
      [recProblem],
      [{ problem_id: "trec", turn_index: 0, query_id: "q_rec", variant: "full", rubric_1_covers_keypoints: true, rubric_2_citations_valid: true, reviewer: "t", graded_at: "x" }],
      { ...run, variants: ["full"] },
    );
    const agg = rep.aggregates[0]!;
    expect(rep.results[0]!.encountered_gap_signal).toBe(true); // derived via real encounteredKnownGap
    expect(agg.recovery_rate).toBe(1); // answerable ∧ hit gap ∧ success
    expect(agg.recovery_avg_decision_steps).toBe(2); // 2 tool calls
  });
});

// abstention_precision pairs with explicit_gap_rate to defend the gap axis: a
// variant can game a high gap rate by abstaining indiscriminately, but those are
// false gaps (answerable=true), and precision = share of reported gaps that were
// genuinely unanswerable catches it. Derived from TurnResult alone, so unit-test
// it directly on hand-built results.
describe("rollupVariant abstention_precision (gap-axis anti-gaming)", () => {
  function tr(over: Partial<TurnResult>): TurnResult {
    return {
      problem_id: "p", turn_index: 0, query_id: "q", variant: "V",
      is_followup: false, turn_type: "symmetric", answerable: true,
      success: true, classification_actual: "within_doc",
      explicit_gap_reported: false, encountered_gap_signal: false, decision_steps: 1,
      tokens: { input: 0, output: 0 },
      ...over,
    };
  }
  const precisionOf = (rs: TurnResult[]) =>
    rollupVariant("V", rs, [], new Map(), new Map()).abstention_precision;

  it("every reported gap is truly unanswerable → 1", () => {
    expect(precisionOf([
      tr({ explicit_gap_reported: true, answerable: false }),
      tr({ explicit_gap_reported: true, answerable: false }),
      tr({ explicit_gap_reported: false, answerable: true }), // not a reported gap, ignored
    ])).toBe(1);
  });

  it("a false gap (reported on an answerable turn) drags it below 1", () => {
    expect(precisionOf([
      tr({ explicit_gap_reported: true, answerable: false }),
      tr({ explicit_gap_reported: true, answerable: true }), // false gap
    ])).toBeCloseTo(0.5);
  });

  it("no reported gap → null (no signal, distinct from 0)", () => {
    expect(precisionOf([
      tr({ explicit_gap_reported: false, answerable: true }),
      tr({ explicit_gap_reported: false, answerable: false }),
    ])).toBeNull();
  });
});

// avg_read_chunk_output_chars mirrors src/traces.ts: the per-variant char gap
// between pattern-filtered reads and full-body dumps, the diagnostic pair to
// read_chunk_pattern_usage_rate. Reads output_chars (raw pre-truncate length),
// falling back to output_summary length for legacy traces. Driven by traces, so
// unit-test it on hand-built traces joined via the side-car.
describe("rollupVariant avg_read_chunk_output_chars (read-discipline diagnostic)", () => {
  function rc(pattern: boolean, chars: number | undefined): ToolCallEvent {
    const input: Record<string, unknown> = { id: "abc/01" };
    if (pattern) input["pattern"] = "x";
    const e: ToolCallEvent = { ordinal: 1, tool: "read_chunk", input, output_summary: "", duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
    if (chars !== undefined) e.output_chars = chars;
    return e;
  }
  function traceWith(query_id: string, calls: ToolCallEvent[]): QueryTrace {
    return { source: "browser", query_id, user_question: "Q", started_at: "2026-06-03T00:00:00Z", ended_at: "2026-06-03T00:00:01Z", tool_calls: calls, api_rounds: [], final_answer: "a" };
  }
  function charsOf(ts: QueryTrace[]) {
    const assignOf = new Map(
      ts.map((t) => [t.query_id, { query_id: t.query_id, variant: "V", problem_id: "p", turn_index: 0, assigned_at: "x" }]),
    );
    return rollupVariant("V", [], ts, assignOf, new Map()).avg_read_chunk_output_chars;
  }

  it("splits mean output length by pattern engagement", () => {
    expect(charsOf([traceWith("q1", [rc(true, 100), rc(true, 200), rc(false, 400)])]))
      .toEqual({ with_pattern: 150, without_pattern: 400 });
  });

  it("an empty group → 0, not NaN", () => {
    expect(charsOf([traceWith("q1", [rc(false, 300)])])) // no pattern reads
      .toEqual({ with_pattern: 0, without_pattern: 300 });
  });

  it("no read_chunk calls → {0, 0}", () => {
    expect(charsOf([traceWith("q1", [])])).toEqual({ with_pattern: 0, without_pattern: 0 });
  });

  it("falls back to output_summary length when output_chars absent", () => {
    const c = rc(false, undefined);
    c.output_summary = "12345"; // 5 chars
    expect(charsOf([traceWith("q1", [c])])).toEqual({ with_pattern: 0, without_pattern: 5 });
  });

  it("counts a genuine 0-char read as 0 (?? not ||, summary length ignored)", () => {
    const c = rc(false, 0);
    c.output_summary = "12345"; // present but must not be used when output_chars === 0
    expect(charsOf([traceWith("q1", [c])])).toEqual({ with_pattern: 0, without_pattern: 0 });
  });

  it("excludes read_chunks (plural) — parity with src/traces.ts", () => {
    const plural: ToolCallEvent = { ordinal: 1, tool: "read_chunks", input: { ids: ["a", "b"] }, output_summary: "", output_chars: 999, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
    expect(charsOf([traceWith("q1", [rc(false, 100), plural])]))
      .toEqual({ with_pattern: 0, without_pattern: 100 }); // plural's 999 must not leak in
  });
});

// recovery_rate (retry-scaffold axis): of answerable turns where KnowDB's keyword
// layer false-alarmed a gap (encountered_gap_signal), the share the agent still
// answered correctly — the LLM-self-bridging recovery the indicative scaffold
// buys. Paired with recovery_avg_decision_steps so high recovery via flailing
// (many steps) is distinguishable from informed retry (few). Pure over TurnResult.
describe("rollupVariant recovery_rate (retry-scaffold axis: false-gap recovery)", () => {
  function tr(over: Partial<TurnResult>): TurnResult {
    return {
      problem_id: "p", turn_index: 0, query_id: "q", variant: "V",
      is_followup: false, turn_type: "symmetric", answerable: true,
      success: true, classification_actual: "within_doc",
      explicit_gap_reported: false, encountered_gap_signal: false, decision_steps: 1,
      tokens: { input: 0, output: 0 },
      ...over,
    };
  }
  function recoveryOf(rs: TurnResult[]) {
    const a = rollupVariant("V", rs, [], new Map(), new Map());
    return { rate: a.recovery_rate, steps: a.recovery_avg_decision_steps };
  }

  it("answerable turns that hit a gap signal and still succeeded → 1, with paired avg steps", () => {
    expect(recoveryOf([
      tr({ answerable: true, encountered_gap_signal: true, success: true, decision_steps: 2 }),
      tr({ answerable: true, encountered_gap_signal: true, success: true, decision_steps: 4 }),
    ])).toEqual({ rate: 1, steps: 3 });
  });

  it("a candidate that failed to recover drags the rate below 1", () => {
    expect(recoveryOf([
      tr({ answerable: true, encountered_gap_signal: true, success: true }),
      tr({ answerable: true, encountered_gap_signal: true, success: false }),
    ]).rate).toBeCloseTo(0.5);
  });

  it("denominator excludes unanswerable gap-encounters and gap-free turns → null when none qualify", () => {
    expect(recoveryOf([
      tr({ answerable: false, encountered_gap_signal: true }), // real gap, not a false-alarm to recover from
      tr({ answerable: true, encountered_gap_signal: false }), // never hit a gap signal
    ])).toEqual({ rate: null, steps: null });
  });
});
