import { describe, it, expect } from "vitest";
import { detectExplicitGap } from "../../src/benchmark/detect-gap.js";
import type { QueryTrace, ToolCallEvent } from "../../src/types.js";

function searchCall(output_summary: string): ToolCallEvent {
  return { ordinal: 1, tool: "search", input: { keyword: "x" }, output_summary, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
}

const KNOWN_GAP = JSON.stringify({ status: "known_gap", message: "no coverage" });
const NORMAL_HITS = JSON.stringify([{ id: "abc/01", score: 3 }]);

function trace(opts: { calls?: ToolCallEvent[]; final_answer?: string }): QueryTrace {
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

describe("detectExplicitGap (B2) — strong × weak signal matrix", () => {
  // strong = search returned {status:"known_gap"}; weak = final_answer matches GAP_REGEX
  it("strong=no, weak=no → false", () => {
    expect(detectExplicitGap(trace({ calls: [searchCall(NORMAL_HITS)], final_answer: "Here is the answer." }))).toBe(false);
  });

  it("strong=yes, weak=no → true", () => {
    expect(detectExplicitGap(trace({ calls: [searchCall(KNOWN_GAP)], final_answer: "Here is the answer." }))).toBe(true);
  });

  it("strong=no, weak=yes → true", () => {
    expect(detectExplicitGap(trace({ calls: [searchCall(NORMAL_HITS)], final_answer: "Sorry, I couldn't find that." }))).toBe(true);
  });

  it("strong=yes, weak=yes → true", () => {
    expect(detectExplicitGap(trace({ calls: [searchCall(KNOWN_GAP)], final_answer: "not covered here" }))).toBe(true);
  });
});

describe("detectExplicitGap — signal robustness", () => {
  it("matches Chinese gap phrasing in final_answer", () => {
    expect(detectExplicitGap(trace({ final_answer: "文件中找不到相關內容" }))).toBe(true);
    expect(detectExplicitGap(trace({ final_answer: "目前沒有收錄這個主題" }))).toBe(true);
  });

  it("missing final_answer (interrupted) → weak signal off", () => {
    expect(detectExplicitGap(trace({ calls: [searchCall(NORMAL_HITS)] }))).toBe(false);
  });

  it("malformed search output is not a strong signal (no throw)", () => {
    expect(detectExplicitGap(trace({ calls: [searchCall("not json <<")], final_answer: "ok" }))).toBe(false);
  });

  it("known_gap shape on a non-search tool is ignored", () => {
    const call: ToolCallEvent = { ordinal: 1, tool: "read_chunk", input: {}, output_summary: KNOWN_GAP, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
    expect(detectExplicitGap(trace({ calls: [call], final_answer: "ok" }))).toBe(false);
  });

  it("regex is case-insensitive", () => {
    expect(detectExplicitGap(trace({ final_answer: "NOT COVERED in the docs" }))).toBe(true);
  });
});
