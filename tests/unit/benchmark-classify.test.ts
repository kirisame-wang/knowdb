import { describe, it, expect } from "vitest";
import { classifyQuery } from "../../src/benchmark/classify.js";
import type { QueryTrace, ToolCallEvent } from "../../src/types.js";

function call(tool: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return {
    ordinal: 1,
    tool,
    input,
    output_summary: "",
    duration_ms: 0,
    timestamp: "2026-06-03T00:00:00Z",
  };
}

function trace(tool_calls: ToolCallEvent[]): QueryTrace {
  return {
    source: "browser",
    query_id: "q_x",
    user_question: "Q",
    started_at: "2026-06-03T00:00:00Z",
    ended_at: "2026-06-03T00:00:01Z",
    tool_calls,
    api_rounds: [],
  };
}

describe("classifyQuery (B3)", () => {
  it("search-only trace → within_doc (no locator)", () => {
    expect(classifyQuery(trace([call("search", { keyword: "x" })]))).toBe("within_doc");
  });

  it("single doc, multiple read_chunk → within_doc", () => {
    expect(
      classifyQuery(
        trace([call("read_chunk", { id: "abc/01" }), call("read_chunk", { id: "abc/02" })]),
      ),
    ).toBe("within_doc");
  });

  it("read_chunk across two docs → cross_doc", () => {
    expect(
      classifyQuery(
        trace([call("read_chunk", { id: "abc/01" }), call("read_chunk", { id: "def/01" })]),
      ),
    ).toBe("cross_doc");
  });

  it("jump_to_ref forces cross_doc even within one doc", () => {
    expect(
      classifyQuery(trace([call("read_chunk", { id: "abc/01" }), call("jump_to_ref", { id: "abc/02" })])),
    ).toBe("cross_doc");
  });

  it("empty trace → within_doc (degenerate)", () => {
    expect(classifyQuery(trace([]))).toBe("within_doc");
  });

  it("locator with doc_id field (no id) is honoured", () => {
    expect(
      classifyQuery(trace([call("read_index", { doc_id: "abc" }), call("parent", { doc_id: "def" })])),
    ).toBe("cross_doc");
  });

  it("unknown / non-locator tools are ignored for doc counting", () => {
    // list_docs + search are not locators → within_doc despite distinct shapes
    expect(
      classifyQuery(trace([call("list_docs"), call("search", { keyword: "y" }), call("read_chunk", { id: "abc/01" })])),
    ).toBe("within_doc");
  });

  it("locator missing any id contributes no doc → within_doc", () => {
    expect(classifyQuery(trace([call("read_chunk", {})]))).toBe("within_doc");
  });
});
