import { describe, it, expect } from "vitest";
import { classifyQuery, detectExplicitGap, encounteredKnownGap } from "../../../src/benchmark/metrics.js";
import type { QueryTrace, ToolCallEvent } from "../../../src/types.js";

// classifyQuery and the gap detectors are the leaf signal functions. successOf
// and rollupVariant (also in metrics.ts) are exercised in compute-report.test.ts,
// where the shared trace/problem fixtures live.

function call(tool: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { ordinal: 1, tool, input, output_summary: "", duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
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

describe("classifyQuery", () => {
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

  it("jump_to_ref alone is discovery, not a locator → within_doc", () => {
    expect(
      classifyQuery(trace([call("read_chunk", { id: "abc/01" }), call("jump_to_ref", { id: "abc/02" })])),
    ).toBe("within_doc");
  });

  it("jump_to_ref then reading another doc → cross_doc (via the read, not the jump)", () => {
    expect(
      classifyQuery(
        trace([call("read_chunk", { id: "abc/01" }), call("jump_to_ref", { id: "abc/01" }), call("read_chunk", { id: "def/03" })]),
      ),
    ).toBe("cross_doc");
  });

  it("empty trace → within_doc (degenerate)", () => {
    expect(classifyQuery(trace([]))).toBe("within_doc");
  });

  it("read_chunks counts as a locator (consistent with the reach oracle)", () => {
    expect(
      classifyQuery(trace([call("read_chunk", { id: "abc/01" }), call("read_chunks", { id: "def/05" })])),
    ).toBe("cross_doc");
  });

  it("read_index / parent are not locators — a TOC survey or structural move doesn't cross docs", () => {
    expect(
      classifyQuery(trace([call("read_chunk", { id: "abc/01" }), call("read_index", { doc_id: "def" }), call("parent", { id: "def/03" })])),
    ).toBe("within_doc");
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

function searchCall(output_summary: string): ToolCallEvent {
  return { ordinal: 1, tool: "search", input: { keyword: "x" }, output_summary, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
}

const KNOWN_GAP = JSON.stringify({ status: "known_gap", message: "no coverage" });
const NORMAL_HITS = JSON.stringify([{ id: "abc/01", score: 3 }]);

function gapTrace(opts: { calls?: ToolCallEvent[]; final_answer?: string }): QueryTrace {
  const base: QueryTrace = {
    source: "browser",
    query_id: "q_x",
    user_question: "Q",
    started_at: "2026-06-03T00:00:00Z",
    ended_at: "2026-06-03T00:00:01Z",
    tool_calls: opts.calls ?? [],
    api_rounds: [],
  };
  return opts.final_answer === undefined ? base : { ...base, final_answer: opts.final_answer };
}

describe("detectExplicitGap — structured known_gap signal only (no prose regex)", () => {
  it("a search returned known_gap → true", () => {
    expect(detectExplicitGap(gapTrace({ calls: [searchCall(KNOWN_GAP)], final_answer: "Here is the answer." }))).toBe(true);
  });

  it("no known_gap → false, even when the final answer phrases a not-found (EN/ZH)", () => {
    expect(detectExplicitGap(gapTrace({ calls: [searchCall(NORMAL_HITS)], final_answer: "Sorry, I couldn't find that." }))).toBe(false);
    expect(detectExplicitGap(gapTrace({ final_answer: "文件中找不到相關內容" }))).toBe(false);
  });

  it("malformed search output is not a signal (no throw)", () => {
    expect(detectExplicitGap(gapTrace({ calls: [searchCall("not json <<")], final_answer: "ok" }))).toBe(false);
  });

  it("known_gap shape on a non-search tool is ignored", () => {
    const c: ToolCallEvent = { ordinal: 1, tool: "read_chunk", input: {}, output_summary: KNOWN_GAP, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
    expect(detectExplicitGap(gapTrace({ calls: [c], final_answer: "ok" }))).toBe(false);
  });
});

// The strong-signal half, exposed on its own: "did this turn ever hit a
// known_gap?" — the recovery-metric denominator. Distinct from detectExplicitGap
// in that final_answer phrasing is irrelevant (a turn can hit a gap then recover).
describe("encounteredKnownGap (recovery-denominator helper)", () => {
  it("true when a search returned known_gap, regardless of a substantive final answer", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall(KNOWN_GAP)], final_answer: "Here is the answer." }))).toBe(true);
  });

  it("false when no search returned known_gap, even if final_answer phrases a gap", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall(NORMAL_HITS)], final_answer: "not covered" }))).toBe(false);
  });

  it("true when one of several searches returned known_gap (.some short-circuit)", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall(NORMAL_HITS), searchCall(KNOWN_GAP)] }))).toBe(true);
  });

  it("known_gap shape on a non-search tool is ignored", () => {
    const c: ToolCallEvent = { ordinal: 1, tool: "read_chunk", input: {}, output_summary: KNOWN_GAP, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
    expect(encounteredKnownGap(gapTrace({ calls: [c] }))).toBe(false);
  });
});
