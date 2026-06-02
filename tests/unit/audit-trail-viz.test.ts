import { describe, it, expect } from "vitest";
import {
  extractChunkId,
  summarizeInput,
  reduce,
  initialState,
  type VizState,
} from "../../src/ui/audit-trail-viz.js";
import type { QueryTrace } from "../../src/types.js";
import type { TraceCollectorEvent } from "../../src/traces.js";

describe("extractChunkId (spec §3)", () => {
  it("read_chunk → input.id", () => {
    expect(extractChunkId("read_chunk", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("read_chunks → input.id", () => {
    expect(extractChunkId("read_chunks", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("read_index → input.doc_id + '/_index'", () => {
    expect(extractChunkId("read_index", { doc_id: "aaa00001" })).toBe("aaa00001/_index");
  });
  it("parent → input.id", () => {
    expect(extractChunkId("parent", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("jump_to_ref → input.id (source chunk)", () => {
    expect(extractChunkId("jump_to_ref", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("search → undefined (not a read-class tool)", () => {
    expect(extractChunkId("search", { keyword: "BM25" })).toBeUndefined();
  });
  it("unknown tool → undefined", () => {
    expect(extractChunkId("get_instructions", {})).toBeUndefined();
  });
});

describe("summarizeInput (spec §4)", () => {
  it("search: keyword only", () => {
    expect(summarizeInput("search", { keyword: "BM25" })).toBe("BM25");
  });
  it("search: keyword + scope", () => {
    expect(summarizeInput("search", { keyword: "BM25", scope: "aaa00001" })).toBe(
      "BM25, scope=aaa00001"
    );
  });
  it("read_chunk: id only", () => {
    expect(summarizeInput("read_chunk", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("read_chunk: id + pattern (T15 affordance visible)", () => {
    expect(summarizeInput("read_chunk", { id: "aaa00001/01", pattern: "Gap" })).toBe(
      'aaa00001/01, pattern="Gap"'
    );
  });
  it("read_chunk: empty-string pattern counts as NOT set (mirrors metric truthy check)", () => {
    expect(summarizeInput("read_chunk", { id: "aaa00001/01", pattern: "" })).toBe("aaa00001/01");
  });
  it("read_chunk: long pattern truncated to 20 chars + ellipsis (UR3)", () => {
    const long = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    expect(summarizeInput("read_chunk", { id: "aaa00001/01", pattern: long })).toBe(
      'aaa00001/01, pattern="abcdefghijklmnopqrst…"'
    );
  });
  it("read_chunks: id + level", () => {
    expect(summarizeInput("read_chunks", { id: "aaa00001/01", level: 2 })).toBe(
      "aaa00001/01, level=2"
    );
  });
  it("read_index: doc_id", () => {
    expect(summarizeInput("read_index", { doc_id: "aaa00001" })).toBe("aaa00001");
  });
  it("parent: id", () => {
    expect(summarizeInput("parent", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("jump_to_ref: id + default top_k=3", () => {
    expect(summarizeInput("jump_to_ref", { id: "aaa00001/01" })).toBe("aaa00001/01, top_k=3");
  });
  it("jump_to_ref: id + explicit top_k", () => {
    expect(summarizeInput("jump_to_ref", { id: "aaa00001/01", top_k: 5 })).toBe(
      "aaa00001/01, top_k=5"
    );
  });
  it("unknown tool: truncated JSON of input", () => {
    expect(summarizeInput("get_instructions", {})).toBe("{}");
  });
});

const tc = (ordinal: number, tool: string, input: Record<string, unknown>): TraceCollectorEvent => ({
  kind: "tool_call_added",
  query_id: "q1",
  event: { ordinal, tool, input, output_summary: "…", duration_ms: 1, timestamp: "2026-06-02T00:00:00.000Z" },
});
const round = (input_tokens: number, output_tokens: number): TraceCollectorEvent => ({
  kind: "api_round_added",
  query_id: "q1",
  round: { ordinal: 1, input_tokens, output_tokens, duration_ms: 10 },
});
const qStart: TraceCollectorEvent = {
  kind: "query_start",
  query_id: "q1",
  user_question: "Q",
  started_at: "2026-06-02T00:00:00.000Z",
};
const qEnd: TraceCollectorEvent = { kind: "query_end", trace: {} as QueryTrace };

describe("reduce (VizState reducer, spec §2)", () => {
  it("query_start resets state (footprint + tokens cleared, query_id set)", () => {
    const dirty: VizState = {
      current_query_id: "old",
      current_node_chunk_id: "x/1",
      footprint: [{ ordinal: 1, tool: "search", input_summary: "k" }],
      tokens: { input: 5, output: 5 },
    };
    expect(reduce(dirty, qStart)).toEqual({
      current_query_id: "q1",
      current_node_chunk_id: null,
      footprint: [],
      tokens: { input: 0, output: 0 },
    });
  });

  it("tool_call_added (read-class) pushes entry and updates current node", () => {
    const s = reduce(initialState(), tc(1, "read_chunk", { id: "aaa/01" }));
    expect(s.footprint).toEqual([
      { ordinal: 1, tool: "read_chunk", input_summary: "aaa/01", chunk_id: "aaa/01" },
    ]);
    expect(s.current_node_chunk_id).toBe("aaa/01");
  });

  it("tool_call_added (search, no chunk_id) pushes entry, leaves current node unchanged", () => {
    const afterRead = reduce(initialState(), tc(1, "read_chunk", { id: "aaa/01" }));
    const afterSearch = reduce(afterRead, tc(2, "search", { keyword: "BM25" }));
    expect(afterSearch.footprint.map((f) => f.ordinal)).toEqual([1, 2]);
    expect(afterSearch.footprint[1]!.chunk_id).toBeUndefined();
    expect(afterSearch.current_node_chunk_id).toBe("aaa/01"); // unchanged
  });

  it("api_round_added accumulates tokens across rounds (U6)", () => {
    const s2 = reduce(reduce(initialState(), round(100, 30)), round(80, 25));
    expect(s2.tokens).toEqual({ input: 180, output: 55 });
  });

  it("query_end is noop — footprint retained until next query_start (U3)", () => {
    const before = reduce(reduce(initialState(), qStart), tc(1, "parent", { id: "aaa/01" }));
    expect(reduce(before, qEnd)).toEqual(before);
  });

  it("reduce is pure — does not mutate the input state", () => {
    const s = initialState();
    const snapshot = JSON.parse(JSON.stringify(s));
    reduce(s, tc(1, "read_chunk", { id: "aaa/01" }));
    expect(s).toEqual(snapshot);
  });
});
