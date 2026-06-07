import type { QueryTrace } from "../types.js";

// Did the agent explicitly report a coverage gap? Two signals, OR-combined:
//   strong: a `search` returned {status:"known_gap"}.
//   weak:   the final answer phrases a not-found in EN/ZH (GAP_REGEX).

const GAP_REGEX = /找不到|not covered|don['']?t have|couldn['']?t find|no\s+coverage|沒有(收錄|涵蓋)/i;

function isKnownGap(output_summary: string): boolean {
  try {
    const out: unknown = JSON.parse(output_summary);
    return typeof out === "object" && out !== null && (out as { status?: unknown }).status === "known_gap";
  } catch {
    return false;
  }
}

// The strong signal alone: did any `search` this turn return known_gap? "Hit a
// gap signal", regardless of how the turn ended (≠ terminal report).
export function encounteredKnownGap(trace: QueryTrace): boolean {
  return trace.tool_calls.some((c) => c.tool === "search" && isKnownGap(c.output_summary));
}

export function detectExplicitGap(trace: QueryTrace): boolean {
  const weakSignal = trace.final_answer ? GAP_REGEX.test(trace.final_answer) : false;
  return encounteredKnownGap(trace) || weakSignal;
}
