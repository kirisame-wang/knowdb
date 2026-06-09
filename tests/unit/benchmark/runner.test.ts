import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "../../../src/agent/loop.js";
import { KNOWDB_TOOLS } from "../../../src/agent/tools.js";
import { runBenchmark, type BenchmarkRunnerConfig } from "../../../src/benchmark/runner.js";
import {
  benchmarkTraceSink,
  benchmarkGapKey,
  benchmarkVariantKey,
  VariantSink,
} from "../../../src/benchmark/sink.js";
import { SessionContext, parseJsonl } from "../../../src/utils.js";
import type { GapEvent, Manifest, SearchIndex } from "../../../src/types.js";
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
  "aaa00001/_index": "# Index\n- 00: intro\n- 01: bm25",
  "aaa00001/00": "intro to BM25 ranking",
  "aaa00001/01": "BM25 is a retrieval function",
};
const MANIFEST: Manifest = { aaa00001: { originalFilename: "ir.md", title: "IR" } };

function scriptedClient(responses: Anthropic.Messages.Message[]): MessagesClient {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= responses.length) throw new Error("scriptedClient: ran out of responses");
        return responses[i++]!;
      },
    },
  };
}

const text = (s: string): Anthropic.Messages.TextBlock => ({ type: "text", text: s, citations: null });
const toolUse = (id: string, name: string, input: object): Anthropic.Messages.ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const msg = (
  content: (Anthropic.Messages.TextBlock | Anthropic.Messages.ToolUseBlock)[],
): Anthropic.Messages.Message => ({
  id: "msg_x",
  type: "message",
  role: "assistant",
  model: "stub",
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Messages.Usage,
});

function turn(turn_index: number, question: string): BenchmarkTurn {
  return {
    turn_index,
    question,
    is_followup: turn_index > 0,
    turn_type: "symmetric",
    answerable: true,
    expected_doc_ids: ["aaa00001"],
    expected_answer_keypoints: ["k"],
    expected_classification: "within_doc",
  };
}
const problem = (id: string, turns: BenchmarkTurn[]): BenchmarkProblem => ({
  id,
  domain: "mcp",
  thread_type: "symmetric",
  turns,
});

function config(over: Partial<BenchmarkRunnerConfig> & Pick<BenchmarkRunnerConfig, "client" | "store" | "problems" | "variants" | "runId">): BenchmarkRunnerConfig {
  return {
    session: new SessionContext("sess-bench"),
    searchIndex: INDEX,
    manifest: MANIFEST,
    model: "stub-model",
    system: "stub-system",
    maxTokens: 1024,
    tools: KNOWDB_TOOLS,
    ...over,
  };
}

describe("runBenchmark — orchestration", () => {
  it("records one trace + one variant assignment per turn, joined by query_id", async () => {
    const kv = new FakeKV();
    const client = scriptedClient([msg([text("a0")]), msg([text("a1")])]); // 2 turns, final-only
    await runBenchmark(
      config({ client, store: kv, problems: [problem("t001", [turn(0, "q0"), turn(1, "q1")])], variants: ["full"], runId: "r1" }),
    );

    const traces = benchmarkTraceSink(kv, "r1").readAll();
    expect(traces).toHaveLength(2);
    const assignments = new VariantSink(kv, benchmarkVariantKey("r1")).readAll();
    expect(assignments.map((a) => [a.query_id, a.variant, a.problem_id, a.turn_index])).toEqual([
      [traces[0]!.query_id, "full", "t001", 0],
      [traces[1]!.query_id, "full", "t001", 1],
    ]);
    // Dogfooding streams untouched.
    expect(kv.getItem("knowdb-traces")).toBeNull();
    expect(kv.getItem("knowdb-gaps")).toBeNull();
  });

  it("applies the variant's ablation to tool results (no_gap suppresses known_gap)", async () => {
    const kv = new FakeKV();
    // A content search that misses → processToolCall returns known_gap; no_gap must
    // rewrite it to bare empty results in the recorded trace.
    const client = scriptedClient([msg([toolUse("t1", "search", { keyword: "absent_kw" })]), msg([text("done")])]);
    await runBenchmark(
      config({ client, store: kv, problems: [problem("t001", [turn(0, "q0")])], variants: ["no_gap"], runId: "r2" }),
    );

    const search = benchmarkTraceSink(kv, "r2").readAll()[0]!.tool_calls.find((c) => c.tool === "search")!;
    expect(JSON.parse(search.output_summary)).toEqual({ status: "results", hits: [] });
    // the GapEvent is still written, to the run-scoped gap key (not the dogfooding key).
    expect(parseJsonl<GapEvent>(kv.getItem(benchmarkGapKey("r2")) ?? "").length).toBeGreaterThanOrEqual(1);
    expect(kv.getItem("knowdb-gaps")).toBeNull();
  });

  it("replays the thread once per variant, labelling each assignment", async () => {
    const kv = new FakeKV();
    const client = scriptedClient([msg([text("x")]), msg([text("y")])]); // 2 variants × 1 turn
    await runBenchmark(
      config({ client, store: kv, problems: [problem("t001", [turn(0, "q0")])], variants: ["full", "no_search"], runId: "r3" }),
    );

    expect(benchmarkTraceSink(kv, "r3").readAll()).toHaveLength(2);
    expect(new VariantSink(kv, benchmarkVariantKey("r3")).readAll().map((a) => a.variant)).toEqual([
      "full",
      "no_search",
    ]);
  });

  it("rejects an unknown ablation variant before running (no side effects)", async () => {
    const kv = new FakeKV();
    await expect(
      runBenchmark(
        config({ client: scriptedClient([]), store: kv, problems: [problem("t001", [turn(0, "q0")])], variants: ["no_strcuture"], runId: "r4" }),
      ),
    ).rejects.toThrow(/unknown ablation variant/i);
    expect(kv.getItem(benchmarkVariantKey("r4"))).toBeNull();
  });
});
