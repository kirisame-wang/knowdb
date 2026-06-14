import { describe, it, expect } from "vitest";
import { classifyQuery, encounteredKnownGap, isContextOverflow, reachSuccess, successOf, terminalGapReported } from "../../../src/benchmark/metrics.js";
import type { QueryTrace, ToolCallEvent } from "../../../src/types.js";
import type { BenchmarkTurn } from "../../../src/benchmark/types.js";

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

// "Did this turn ever hit a known_gap?" — the mid-turn signal: the recovery
// denominator and the unanswerable-success oracle. final_answer phrasing is
// irrelevant (a turn can hit a gap then recover); only the structured signal counts.
describe("encounteredKnownGap (mid-turn gap signal)", () => {
  it("true when a search returned known_gap, regardless of a substantive final answer", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall(KNOWN_GAP)], final_answer: "Here is the answer." }))).toBe(true);
  });

  it("false when no search returned known_gap, even if final_answer phrases a gap (EN/ZH)", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall(NORMAL_HITS)], final_answer: "not covered" }))).toBe(false);
    expect(encounteredKnownGap(gapTrace({ final_answer: "文件中找不到相關內容" }))).toBe(false);
  });

  it("true when one of several searches returned known_gap (.some short-circuit)", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall(NORMAL_HITS), searchCall(KNOWN_GAP)] }))).toBe(true);
  });

  it("malformed search output is not a signal (no throw)", () => {
    expect(encounteredKnownGap(gapTrace({ calls: [searchCall("not json <<")] }))).toBe(false);
  });

  it("known_gap shape on a non-search tool is ignored", () => {
    const c: ToolCallEvent = { ordinal: 1, tool: "read_chunk", input: {}, output_summary: KNOWN_GAP, duration_ms: 0, timestamp: "2026-06-03T00:00:00Z" };
    expect(encounteredKnownGap(gapTrace({ calls: [c] }))).toBe(false);
  });
});

// explicit_gap_reported is terminal: an unanswerable turn that hit the gap signal
// (a correct abstention), or an answerable turn that hit a gap and did NOT recover.
// A recovered answerable turn (hit a gap, then answered) is NOT a reported gap.
describe("terminalGapReported — terminal abstention signal", () => {
  const aTurn = (answerable: boolean): BenchmarkTurn => ({
    turn_index: 0, question: "q", is_followup: false, turn_type: "symmetric",
    answerable, expected_doc_ids: [], expected_answer_keypoints: [], expected_classification: "within_doc",
  });
  const hitGap = gapTrace({ calls: [searchCall(KNOWN_GAP)] });
  const noGap = gapTrace({ calls: [searchCall(NORMAL_HITS)] });

  it("unanswerable + hit gap → true regardless of success (correct abstention counts)", () => {
    expect(terminalGapReported(aTurn(false), hitGap, true)).toBe(true);
    expect(terminalGapReported(aTurn(false), hitGap, false)).toBe(true);
  });

  it("unanswerable without a gap signal → false (fabricated, not a reported gap)", () => {
    expect(terminalGapReported(aTurn(false), noGap, false)).toBe(false);
  });

  it("answerable + hit gap + recovered (success) → false (the retry-scaffold fix)", () => {
    expect(terminalGapReported(aTurn(true), hitGap, true)).toBe(false);
  });

  it("answerable + hit gap + failed → true (a false gap on answerable content)", () => {
    expect(terminalGapReported(aTurn(true), hitGap, false)).toBe(true);
  });

  it("answerable without a gap signal → false", () => {
    expect(terminalGapReported(aTurn(true), noGap, true)).toBe(false);
  });
});

describe("reachSuccess — chunk groups (any-of within a group, all groups required)", () => {
  const turn = (over: Partial<BenchmarkTurn> = {}): BenchmarkTurn => ({
    turn_index: 0, question: "q", is_followup: false, turn_type: "symmetric",
    answerable: true, expected_doc_ids: [], expected_answer_keypoints: [], expected_classification: "within_doc",
    ...over,
  });
  const read = (...ids: string[]): QueryTrace => trace(ids.map((id) => call("read_chunk", { id })));

  it("each group satisfied by ≥1 read → success", () => {
    const t = turn({ expected_chunk_groups: [["a", "b"], ["c"]] });
    expect(reachSuccess(t, read("b", "c"))).toBe(true);
  });

  it("a group with nothing read → failure", () => {
    const t = turn({ expected_chunk_groups: [["a", "b"], ["c"]] });
    expect(reachSuccess(t, read("a"))).toBe(false);
  });

  it("multi-element group is any-of: either candidate satisfies it", () => {
    const t = turn({ expected_chunk_groups: [["a", "b"]] });
    expect(reachSuccess(t, read("a"))).toBe(true);
    expect(reachSuccess(t, read("b"))).toBe(true);
    expect(reachSuccess(t, read("d"))).toBe(false);
  });

  it("singleton group is a required chunk", () => {
    const t = turn({ expected_chunk_groups: [["a"]] });
    expect(reachSuccess(t, read("a"))).toBe(true);
    expect(reachSuccess(t, read("b"))).toBe(false);
  });

  it("no groups → legacy ⊇-all over expected_chunk_ids", () => {
    const t = turn({ expected_chunk_ids: ["a", "b"] });
    expect(reachSuccess(t, read("a"))).toBe(false);
    expect(reachSuccess(t, read("a", "b"))).toBe(true);
  });

  it("groups take precedence over expected_chunk_ids when both present", () => {
    const t = turn({ expected_chunk_ids: ["a", "b", "c"], expected_chunk_groups: [["a", "b"]] });
    expect(reachSuccess(t, read("b"))).toBe(true); // legacy ⊇-all would need a,b,c
  });

  it("an empty group is unsatisfiable → failure (malformed GT fails rather than free-passes)", () => {
    expect(reachSuccess(turn({ expected_chunk_groups: [[]] }), read("a"))).toBe(false);
    expect(reachSuccess(turn({ expected_chunk_groups: [["a"], []] }), read("a"))).toBe(false);
  });

  it("unanswerable turns ignore chunk groups; success = reported gap", () => {
    const t = turn({ answerable: false, expected_chunk_groups: [["a"]] });
    expect(reachSuccess(t, trace([searchCall(KNOWN_GAP)]))).toBe(true);
    expect(reachSuccess(t, read("a"))).toBe(false);
  });
});

describe("isContextOverflow", () => {
  const withError = (error: string): QueryTrace => ({ ...trace([]), error });

  it("true when the turn ended on a 'prompt is too long' 400", () => {
    expect(
      isContextOverflow(withError('400 {"type":"error","error":{"message":"prompt is too long: 207358 tokens > 200000 maximum"}}')),
    ).toBe(true);
  });

  it("false for an unrelated error (a real reach-miss / other failure)", () => {
    expect(isContextOverflow(withError("network error"))).toBe(false);
  });

  it("false when the phrase appears outside a 400 (overflow is the 400 subtype, not any echo of the words)", () => {
    expect(
      isContextOverflow(withError('529 {"type":"error","error":{"message":"overloaded; prompt is too long to retry"}}')),
    ).toBe(false);
  });

  it("false for a completed turn with no error", () => {
    expect(isContextOverflow(trace([]))).toBe(false);
  });
});

describe("successOf — an overflowed turn delivered no answer, so reach is overridden", () => {
  const answerable = (): BenchmarkTurn => ({
    turn_index: 0, question: "q", is_followup: false, turn_type: "symmetric",
    answerable: true, expected_doc_ids: ["d"], expected_chunk_groups: [["d/01"]],
    expected_answer_keypoints: [], expected_classification: "within_doc",
  });
  const reached = (error?: string): QueryTrace => ({
    ...trace([call("read_chunk", { id: "d/01" })]),
    ...(error ? { error } : {}),
  });
  const OVERFLOW = "400 prompt is too long: 207358 tokens > 200000 maximum";

  it("reached its chunks but overflowed → not a success (over-search / no delivery)", () => {
    const t = answerable();
    expect(reachSuccess(t, reached())).toBe(true);        // navigation did reach
    expect(successOf(t, reached(OVERFLOW))).toBe(false);  // but no answer delivered in budget
  });

  it("reached and terminated within budget → success", () => {
    expect(successOf(answerable(), reached())).toBe(true);
  });
});
