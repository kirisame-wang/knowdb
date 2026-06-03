import type { QueryTrace } from "../types.js";

// B2 — did the agent explicitly report a coverage gap (vs. silently hallucinate
// or give up without saying so)? Two signals, OR-combined ("任一觸發即算"):
//
//   strong (deterministic): a `search` call returned KnownGapResponse
//     ({status:"known_gap"}). The gap-recording layer already owns this shape.
//   weak (heuristic): the final answer phrases a not-found in EN/ZH.
//
// This measures agent behaviour — KnowDB's "explicit gap" vs vector RAG's silent
// failure — and does not depend on document structure.

const GAP_REGEX = /找不到|not covered|don['']?t have|couldn['']?t find|no\s+coverage|沒有(收錄|涵蓋)/i;

function isKnownGap(output_summary: string): boolean {
  try {
    const out: unknown = JSON.parse(output_summary);
    return typeof out === "object" && out !== null && (out as { status?: unknown }).status === "known_gap";
  } catch {
    return false;
  }
}

export function detectExplicitGap(trace: QueryTrace): boolean {
  const strongSignal = trace.tool_calls.some((c) => c.tool === "search" && isKnownGap(c.output_summary));
  const weakSignal = trace.final_answer ? GAP_REGEX.test(trace.final_answer) : false;
  return strongSignal || weakSignal;
}
