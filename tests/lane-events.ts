// Shared TraceCollectorEvent builders for the compare-lane tests (unit + integration),
// so the event shapes and their magic literals live in one place.
import type { TraceCollectorEvent } from "../src/traces.js";
import type { QueryTrace } from "../src/types.js";

export const qStart = (q = "Q", query_id = "q1"): TraceCollectorEvent => ({
  kind: "query_start",
  query_id,
  user_question: q,
  started_at: "t",
});

export const tool = (
  ordinal: number,
  t: string,
  input: Record<string, unknown>,
  output = "…",
  query_id = "q1",
): TraceCollectorEvent => ({
  kind: "tool_call_added",
  query_id,
  event: { ordinal, tool: t, input, output_summary: output, duration_ms: 1, timestamp: "t" },
});

export const round = (i: number, o: number, query_id = "q1"): TraceCollectorEvent => ({
  kind: "api_round_added",
  query_id,
  round: { ordinal: 1, input_tokens: i, output_tokens: o, duration_ms: 1 },
});

export const end = (over: Partial<QueryTrace>, query_id = "q1"): TraceCollectorEvent => ({
  kind: "query_end",
  trace: {
    source: "browser",
    query_id,
    user_question: "Q",
    started_at: "t",
    ended_at: "t",
    tool_calls: [],
    api_rounds: [],
    ...over,
  },
});
