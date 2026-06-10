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
  BENCHMARK_VARIANTS,
} from "../../../src/benchmark/report.js";
import { MODEL } from "../../../src/constants.js";
import { SessionContext } from "../../../src/utils.js";
import type { SearchIndex, Manifest } from "../../../src/types.js";
import type { BenchmarkProblem, BenchmarkTurn } from "../../../src/benchmark/types.js";

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
    // cost = input/1e6*inRate + output/1e6*outRate
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
