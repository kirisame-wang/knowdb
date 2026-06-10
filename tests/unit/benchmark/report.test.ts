import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "../../../src/agent/loop.js";
import { KNOWDB_TOOLS } from "../../../src/agent/tools.js";
import { runBenchmark } from "../../../src/benchmark/runner.js";
import {
  estimateRun,
  buildRun,
  toolSetVersionHash,
  collectReport,
  renderReportText,
  reportView,
  successRowCells,
  BENCHMARK_VARIANTS,
} from "../../../src/benchmark/report.js";
import { MODEL } from "../../../src/constants.js";
import { SessionContext } from "../../../src/utils.js";
import type { SearchIndex, Manifest } from "../../../src/types.js";
import type { BenchmarkProblem, BenchmarkTurn, BenchmarkReport, TurnResult, VariantAggregate } from "../../../src/benchmark/types.js";

class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const INDEX: SearchIndex = {
  "aaa00001/_index": "# Index\n- 00: intro",
  "aaa00001/00": "intro to BM25 ranking",
};
const MANIFEST: Manifest = { aaa00001: { originalFilename: "ir.md", title: "IR" } };

const text = (s: string): Anthropic.Messages.TextBlock => ({ type: "text", text: s, citations: null });
const msg = (s: string): Anthropic.Messages.Message => ({
  id: "msg_x",
  type: "message",
  role: "assistant",
  model: "stub",
  content: [text(s)],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Messages.Usage,
});
function scriptedClient(responses: Anthropic.Messages.Message[]): MessagesClient {
  let i = 0;
  return { messages: { create: async () => responses[i++] ?? msg("fallback") } };
}

function turn(turn_index: number, question: string): BenchmarkTurn {
  return {
    turn_index,
    question,
    is_followup: turn_index > 0,
    turn_type: "symmetric",
    answerable: true,
    expected_doc_ids: [],
    expected_answer_keypoints: ["(no ground truth)"],
    expected_classification: "within_doc",
  };
}
const problem = (id: string, turns: BenchmarkTurn[]): BenchmarkProblem => ({
  id,
  domain: "annual_report",
  thread_type: "symmetric",
  turns,
});

describe("estimateRun", () => {
  it("units = variants × Σ turns; tokens and cost scale with units", () => {
    const problems = [problem("t1", [turn(0, "q0"), turn(1, "q1")]), problem("t2", [turn(0, "q0")])];
    const est = estimateRun(problems, ["full", "no_search"]);
    expect(est.turnCount).toBe(3);
    expect(est.units).toBe(6); // 2 variants × 3 turns
    expect(est.estTokens.input).toBeGreaterThan(0);
    expect(est.estTokens.output).toBeGreaterThan(0);
    const expected =
      (est.estTokens.input / 1_000_000) * MODEL.pricing.inputPerMTok +
      (est.estTokens.output / 1_000_000) * MODEL.pricing.outputPerMTok;
    expect(est.estCostUsd).toBeCloseTo(expected, 6);
  });
});

describe("toolSetVersionHash", () => {
  it("is deterministic and sensitive to the tool set", () => {
    const h1 = toolSetVersionHash(KNOWDB_TOOLS);
    const h2 = toolSetVersionHash(KNOWDB_TOOLS);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(toolSetVersionHash(KNOWDB_TOOLS.slice(1))).not.toBe(h1);
  });
});

describe("buildRun", () => {
  it("wires baseline=full, external=baseline_search_read, full variant matrix", () => {
    const run = buildRun({
      runId: "run-x",
      knowdbCommitSha: "abc",
      tools: KNOWDB_TOOLS,
      problemSetId: "smoke",
      startedAt: "2026-06-10T00:00:00.000Z",
      endedAt: "2026-06-10T00:01:00.000Z",
      reviewer: "",
    });
    expect(run.baseline_variant).toBe("full");
    expect(run.external_variant).toBe("baseline_search_read");
    expect(run.model).toBe(MODEL.id);
    expect(run.variants).toEqual([...BENCHMARK_VARIANTS]);
  });
});

describe("collectReport + renderReportText (end-to-end, no live API)", () => {
  it("synthesizes a report from run-scoped sinks and renders only ground-truth-free metrics", async () => {
    const kv = new FakeKV();
    const variants = ["full", "baseline_search_read"];
    const problems = [problem("t1", [turn(0, "q0")])];
    await runBenchmark({
      client: scriptedClient([msg("a"), msg("b")]),
      store: kv,
      session: new SessionContext("sess-run"),
      searchIndex: INDEX,
      manifest: MANIFEST,
      model: "stub",
      system: "stub",
      maxTokens: 256,
      tools: KNOWDB_TOOLS,
      problems,
      variants,
      runId: "run-e2e",
    });

    const run = buildRun({
      runId: "run-e2e",
      knowdbCommitSha: "abc",
      tools: KNOWDB_TOOLS,
      problemSetId: "smoke",
      startedAt: "2026-06-10T00:00:00.000Z",
      endedAt: "2026-06-10T00:01:00.000Z",
      reviewer: "",
      variants,
    });
    const report = collectReport(kv, "run-e2e", problems, run);

    expect(report.aggregates.map((a) => a.variant).sort()).toEqual(["baseline_search_read", "full"]);
    expect(report.deltas.external_token_ratio).toBeDefined();

    const md = renderReportText(report);
    expect(md).toContain("ground-truth-free");
    expect(md).toContain("Token ratio");
    expect(md).toContain("decision-steps delta");

    // The per-variant table header must not expose any success-derived column.
    const header = md.split("\n").find((l) => l.includes("avg steps"))!;
    expect(header.toLowerCase()).not.toContain("success");
    expect(header.toLowerCase()).not.toContain("recovery");
    expect(header.toLowerCase()).not.toContain("abstention");
    // The doc-span column is raw counts, not a success rate — label says so.
    expect(header.toLowerCase()).toContain("count");
    // Realized usage is surfaced so the consent estimate can be reconciled.
    expect(md).toContain("Realized usage");
  });

  it("does not render a degenerate cost ratio when the floor variant produced no turns", async () => {
    // Simulate a Stop before the floor variant ran: only `full` has traces, but the
    // run still declares external=baseline_search_read. Its empty aggregate has
    // avg_tokens 0, so a naive ratio = full/0 = Infinity.
    const kv = new FakeKV();
    const problems = [problem("t1", [turn(0, "q0")])];
    await runBenchmark({
      client: scriptedClient([msg("a")]),
      store: kv,
      session: new SessionContext("sess-partial"),
      searchIndex: INDEX,
      manifest: MANIFEST,
      model: "stub",
      system: "stub",
      maxTokens: 256,
      tools: KNOWDB_TOOLS,
      problems,
      variants: ["full"], // floor never ran
      runId: "run-partial",
    });
    const run = buildRun({
      runId: "run-partial",
      knowdbCommitSha: "abc",
      tools: KNOWDB_TOOLS,
      problemSetId: "smoke",
      startedAt: "2026-06-10T00:00:00.000Z",
      endedAt: "2026-06-10T00:01:00.000Z",
      reviewer: "",
      variants: ["full", "baseline_search_read"], // declared but did not run
    });
    const report = collectReport(kv, "run-partial", problems, run);

    const md = renderReportText(report);
    expect(md).not.toContain("Infinity");
    expect(md).not.toContain("NaN");
    expect(md).toContain("produced no turns");
  });
});

describe("reportView (structured display data)", () => {
  async function reportFor(runId: string, variants: string[], ranVariants: string[]) {
    const kv = new FakeKV();
    const problems = [problem("t1", [turn(0, "q0")])];
    await runBenchmark({
      client: scriptedClient([msg("a"), msg("b"), msg("c")]),
      store: kv,
      session: new SessionContext(`sess-${runId}`),
      searchIndex: INDEX,
      manifest: MANIFEST,
      model: "stub",
      system: "stub",
      maxTokens: 256,
      tools: KNOWDB_TOOLS,
      problems,
      variants: ranVariants,
      runId,
    });
    const run = buildRun({
      runId,
      knowdbCommitSha: "abc",
      tools: KNOWDB_TOOLS,
      problemSetId: "smoke",
      startedAt: "2026-06-10T00:00:00.000Z",
      endedAt: "2026-06-10T00:01:00.000Z",
      reviewer: "",
      variants,
    });
    return collectReport(kv, runId, problems, run);
  }

  it("exposes one row per variant and a finite ratio when the floor ran", async () => {
    const view = reportView(
      await reportFor("view-full", ["full", "baseline_search_read"], ["full", "baseline_search_read"]),
    );
    expect(view.perVariant.rows.map((r) => r.variant).sort()).toEqual(["baseline_search_read", "full"]);
    expect(view.cost.ratio).not.toBeNull();
    expect(Number.isFinite(view.cost.ratio!.input)).toBe(true);
    expect(view.cost.realized.turns).toBe(2);
  });

  it("columns are success-free and include the count label", () => {
    // Pure check on the column labels (no run needed via the type's static columns).
    const cols = reportView({
      run: { run_id: "x" } as never,
      results: [],
      aggregates: [],
      deltas: { per_axis: [] },
    } as never).perVariant.columns.join(" ").toLowerCase();
    expect(cols).not.toContain("success");
    expect(cols).not.toContain("recovery");
    expect(cols).not.toContain("abstention");
    expect(cols).toContain("count");
  });

  it("ratio is null when the floor variant produced no turns", async () => {
    const view = reportView(await reportFor("view-partial", ["full", "baseline_search_read"], ["full"]));
    expect(view.cost.ratio).toBeNull();
  });
});

describe("reportView (pilot — ground truth present)", () => {
  const gtTurn = (over: Partial<BenchmarkTurn> = {}): BenchmarkTurn => ({
    ...turn(0, "q0"),
    expected_chunk_groups: [["aaa00001/00"]],
    expected_chunk_ids: ["aaa00001/00"],
    expected_doc_ids: ["aaa00001"],
    ...over,
  });
  const gtProblems = [problem("t1", [gtTurn()])];

  const result = (over: Partial<TurnResult>): TurnResult => ({
    problem_id: "t1", turn_index: 0, query_id: "q", variant: "full", is_followup: false,
    turn_type: "symmetric", answerable: true, success: true, classification_actual: "within_doc",
    explicit_gap_reported: false, encountered_gap_signal: false, decision_steps: 0,
    tokens: { input: 0, output: 0 }, ...over,
  });
  const agg = (over: Partial<VariantAggregate>): VariantAggregate => ({
    variant: "full", turn_count: 0, thread_count: 0, success_rate: 0, within_doc_success_rate: 0,
    cross_doc_success_rate: 0, explicit_gap_rate: 0, abstention_precision: null, recovery_rate: null,
    recovery_avg_decision_steps: null, avg_decision_steps: 0, avg_tokens: { input: 0, output: 0 },
    read_chunk_pattern_usage_rate: null, avg_read_chunk_output_chars: { with_pattern: 0, without_pattern: 0 },
    followup_success_rate: 0, turn_degradation_slope: 0, cumulative_passage_coverage: 0, ...over,
  });

  const report = {
    run: { run_id: "r", model: "m", knowdb_commit_sha: "c", tool_set_version: "t", problem_set_id: "pilot", started_at: "s", ended_at: "e" },
    results: [
      result({ variant: "full", success: true, decision_steps: 3, tokens: { input: 100, output: 20 } }),
      result({ variant: "full", success: false, decision_steps: 8, tokens: { input: 300, output: 40 } }),
      result({ variant: "no_search", success: false, decision_steps: 9, tokens: { input: 500, output: 60 } }),
    ],
    aggregates: [
      agg({ variant: "full", turn_count: 2, success_rate: 0.5, within_doc_success_rate: 0.5, cross_doc_success_rate: 0 }),
      agg({ variant: "no_search", turn_count: 1, success_rate: 0 }),
    ],
    deltas: { baseline_variant: "full", per_axis: [{ variant: "no_search", success_rate_delta: 0.5, decision_steps_delta: 1, explicit_gap_rate_delta: 0 }] },
  } as unknown as BenchmarkReport;

  it("surfaces a success view only when ground truth is present", () => {
    expect(reportView(report).success).toBeUndefined();        // no problems → GT-free
    expect(reportView(report, gtProblems).success).toBeDefined();
    expect(reportView(report, [problem("t1", [turn(0, "q0")])]).success).toBeUndefined(); // problems without GT
  });

  it("title and disclaimer switch to the pilot framing under ground truth", () => {
    const v = reportView(report, gtProblems);
    expect(v.title.toLowerCase()).toContain("pilot");
    expect(v.disclaimer.toLowerCase()).toContain("reach");
    expect(reportView(report).title.toLowerCase()).toContain("ground-truth-free");
  });

  it("splits steps and tokens by outcome (✓ succeeded / ✗ failed)", () => {
    const sv = reportView(report, gtProblems).success!;
    const full = sv.rows.find((r) => r.variant === "full")!;
    expect(full.successRate).toBe(0.5);
    expect(full.success).toMatchObject({ turns: 1, avgSteps: 3, avgIn: 100, avgOut: 20 });
    expect(full.failure).toMatchObject({ turns: 1, avgSteps: 8, avgIn: 300, avgOut: 40 });
    // a variant with no successes shows an empty success group, not a divide-by-zero
    const ns = sv.rows.find((r) => r.variant === "no_search")!;
    expect(ns.success.turns).toBe(0);
    expect(ns.failure).toMatchObject({ turns: 1, avgSteps: 9 });
    expect(sv.perAxis).toEqual([{ variant: "no_search", successRateDelta: 0.5 }]);
  });

  it("renders within✓/cross✓ as — when the variant had no such-classification turns", () => {
    const sv = reportView(report, gtProblems).success!;
    const full = sv.rows.find((r) => r.variant === "full")!;
    expect(full.withinTurns).toBe(2); // both results are within_doc
    expect(full.crossTurns).toBe(0);  // no cross_doc turns → cross✓ should render —
    expect(successRowCells(full)[3]).toBe("—"); // cross✓ cell
  });

  it("renderReportText shows the success section, — for an absent outcome, and a pp-unit delta", () => {
    const md = renderReportText(report, gtProblems);
    expect(md.toLowerCase()).toContain("pilot");
    expect(md).toMatch(/3\.00\/8\.00/);   // full: steps ✓/✗
    expect(md).toContain("—/9.00");        // no_search: no successes → — for the ✓ side
    expect(md).toContain("+50pp");         // success-rate delta in percentage points
    expect(md).not.toMatch(/\| no_search \| \+0\.50 \|/); // not a raw fraction
  });
});
