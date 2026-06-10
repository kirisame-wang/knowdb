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

// Like scriptedClient, but records each create call's params (messages + tools) so a
// test can observe the conversation history and tool allowlist the agent actually saw.
function capturingClient(responses: Anthropic.Messages.Message[]): {
  client: MessagesClient;
  calls: { messages: Anthropic.Messages.MessageParam[]; tools: Anthropic.Messages.Tool[] }[];
} {
  const calls: { messages: Anthropic.Messages.MessageParam[]; tools: Anthropic.Messages.Tool[] }[] = [];
  let i = 0;
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        // Snapshot: params.messages is the loop's mutable chatHistory reference.
        calls.push({ messages: [...params.messages], tools: [...((params.tools ?? []) as Anthropic.Messages.Tool[])] });
        if (i >= responses.length) throw new Error("capturingClient: ran out of responses");
        return responses[i++]!;
      },
    },
  };
  return { client, calls };
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

  it("rejects the whole batch when any variant is unknown, before running the valid ones", async () => {
    const kv = new FakeKV();
    await expect(
      runBenchmark(
        config({ client: scriptedClient([]), store: kv, problems: [problem("t001", [turn(0, "q0")])], variants: ["full", "no_strcuture"], runId: "r5" }),
      ),
    ).rejects.toThrow(/unknown ablation variant/i);
    expect(benchmarkTraceSink(kv, "r5").readAll()).toHaveLength(0); // "full" never ran
    expect(kv.getItem(benchmarkVariantKey("r5"))).toBeNull();
  });

  it("carries one chatHistory across the turns of a problem", async () => {
    const kv = new FakeKV();
    // turn 0 issues a tool call then answers; turn 1 answers. If history reset per
    // turn, turn 1's request would not contain turn 0's question.
    const { client, calls } = capturingClient([
      msg([toolUse("t1", "search", { keyword: "BM25" })]),
      msg([text("a0")]),
      msg([text("a1")]),
    ]);
    await runBenchmark(
      config({ client, store: kv, problems: [problem("t001", [turn(0, "q0"), turn(1, "q1")])], variants: ["full"], runId: "rH" }),
    );

    expect(calls[0]!.messages).toHaveLength(1); // turn 0 starts with just its question
    const turn1Request = calls[2]!.messages; // turn 1's initial request
    expect(turn1Request.length).toBeGreaterThan(1);
    expect(JSON.stringify(turn1Request)).toContain("q0"); // turn 0's exchange carried forward
    expect(JSON.stringify(turn1Request)).toContain("q1");
  });

  it("starts each problem with a clean history (no cross-problem bleed)", async () => {
    const kv = new FakeKV();
    const { client, calls } = capturingClient([msg([text("a")]), msg([text("b")])]);
    await runBenchmark(
      config({
        client,
        store: kv,
        problems: [problem("t001", [turn(0, "qA")]), problem("t002", [turn(0, "qB")])],
        variants: ["full"],
        runId: "rP",
      }),
    );

    const assignments = new VariantSink(kv, benchmarkVariantKey("rP")).readAll();
    expect(assignments.map((a) => [a.problem_id, a.turn_index])).toEqual([
      ["t001", 0],
      ["t002", 0],
    ]);
    expect(calls[1]!.messages).toHaveLength(1); // problem t002 starts fresh
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("qA"); // t001's turn did not bleed in
  });

  it("withholds the tool its axis turns off from the agent (no_search lacks search)", async () => {
    const kv = new FakeKV();
    const { client, calls } = capturingClient([msg([text("x")]), msg([text("y")])]);
    await runBenchmark(
      config({ client, store: kv, problems: [problem("t001", [turn(0, "q0")])], variants: ["full", "no_search"], runId: "rT" }),
    );

    const toolNames = (i: number): string[] => calls[i]!.tools.map((t) => t.name);
    expect(toolNames(0)).toContain("search"); // full keeps the whole surface
    expect(toolNames(1)).not.toContain("search"); // no_search withholds it via the allowlist
  });

  it("reports progress after each turn with the right total (variants × turns)", async () => {
    const kv = new FakeKV();
    const client = scriptedClient([msg([text("a")]), msg([text("b")]), msg([text("c")]), msg([text("d")])]);
    const calls: [number, number][] = [];
    await runBenchmark(
      config({
        client,
        store: kv,
        problems: [problem("t001", [turn(0, "q0"), turn(1, "q1")])],
        variants: ["full", "no_search"], // 2 variants × 2 turns = 4
        runId: "rProg",
        onProgress: (done, total) => calls.push([done, total]),
      }),
    );
    expect(calls).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it("an already-aborted signal stops the batch before any turn runs", async () => {
    const kv = new FakeKV();
    const ac = new AbortController();
    ac.abort();
    await runBenchmark(
      config({
        client: scriptedClient([]),
        store: kv,
        problems: [problem("t001", [turn(0, "q0")])],
        variants: ["full"],
        runId: "rAbort",
        signal: ac.signal,
      }),
    );
    expect(benchmarkTraceSink(kv, "rAbort").readAll()).toHaveLength(0);
    expect(kv.getItem(benchmarkVariantKey("rAbort"))).toBeNull();
  });

  it("aborting mid-batch stops subsequent turns", async () => {
    const kv = new FakeKV();
    const ac = new AbortController();
    const client = scriptedClient([msg([text("a")]), msg([text("b")])]);
    await runBenchmark(
      config({
        client,
        store: kv,
        problems: [problem("t001", [turn(0, "q0"), turn(1, "q1")])],
        variants: ["full"],
        runId: "rMid",
        signal: ac.signal,
        onProgress: (done) => {
          if (done === 1) ac.abort(); // stop after the first turn settles
        },
      }),
    );
    // Only the first turn's trace + assignment were recorded.
    expect(benchmarkTraceSink(kv, "rMid").readAll()).toHaveLength(1);
    expect(new VariantSink(kv, benchmarkVariantKey("rMid")).readAll()).toHaveLength(1);
  });
});

describe("runBenchmark — concurrency", () => {
  // A client that returns immediately but yields once, so siblings overlap; it
  // tracks the peak number of in-flight create() calls.
  function trackingClient(): { client: MessagesClient; maxActive: () => number } {
    let active = 0;
    let max = 0;
    const client: MessagesClient = {
      messages: {
        create: async () => {
          active++;
          max = Math.max(max, active);
          await Promise.resolve();
          active--;
          return msg([text("ok")]);
        },
      },
    };
    return { client, maxActive: () => max };
  }

  it("runs (variant × problem) units concurrently up to the cap, and runs them all", async () => {
    const kv = new FakeKV();
    const { client, maxActive } = trackingClient();
    const problems = [
      problem("p1", [turn(0, "q")]),
      problem("p2", [turn(0, "q")]),
      problem("p3", [turn(0, "q")]),
      problem("p4", [turn(0, "q")]),
    ];
    await runBenchmark(config({ client, store: kv, problems, variants: ["full"], runId: "rc1", concurrency: 2 }));
    expect(benchmarkTraceSink(kv, "rc1").readAll()).toHaveLength(4); // every unit ran
    expect(maxActive()).toBe(2); // overlap happened and was capped at 2
  });

  it("concurrency 1 never overlaps (sequential, byte-identical default)", async () => {
    const kv = new FakeKV();
    const { client, maxActive } = trackingClient();
    const problems = [problem("p1", [turn(0, "q")]), problem("p2", [turn(0, "q")])];
    await runBenchmark(config({ client, store: kv, problems, variants: ["full"], runId: "rc2", concurrency: 1 }));
    expect(maxActive()).toBe(1);
  });

  it("keeps a thread's turns sequential and in order under concurrency", async () => {
    const kv = new FakeKV();
    const { client } = trackingClient();
    const problems = [
      problem("pA", [turn(0, "q0"), turn(1, "q1")]),
      problem("pB", [turn(0, "q0"), turn(1, "q1")]),
    ];
    await runBenchmark(config({ client, store: kv, problems, variants: ["full"], runId: "rc3", concurrency: 2 }));
    const assigns = new VariantSink(kv, benchmarkVariantKey("rc3")).readAll();
    for (const pid of ["pA", "pB"]) {
      const idxs = assigns.filter((a) => a.problem_id === pid).map((a) => a.turn_index);
      expect(idxs).toEqual([0, 1]); // each thread's turns recorded in turn order
    }
  });

  it("an already-aborted signal runs nothing even with concurrency", async () => {
    const kv = new FakeKV();
    const ac = new AbortController();
    ac.abort();
    const { client } = trackingClient();
    await runBenchmark(
      config({
        client,
        store: kv,
        problems: [problem("p1", [turn(0, "q")]), problem("p2", [turn(0, "q")])],
        variants: ["full"],
        runId: "rc4",
        concurrency: 2,
        signal: ac.signal,
      }),
    );
    expect(benchmarkTraceSink(kv, "rc4").readAll()).toHaveLength(0);
  });
});
