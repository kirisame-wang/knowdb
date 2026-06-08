import type { Tool } from "@anthropic-ai/sdk/resources/index.js";

// Seam A — ablation by tool allowlist: a variant removes the tools its axis
// turns off, so the agent simply lacks them. Content-transform axes leave the
// set whole (they ablate via Seam B); unknown variants default to the full set.

// The cost-floor variant keeps a flat search+read surface plus orientation tools.
const SEARCH_READ_FLOOR = new Set(["get_instructions", "list_docs", "search", "read_chunk"]);

export function toolsFor(variant: string, tools: Tool[]): Tool[] {
  switch (variant) {
    case "no_search":
      return tools.filter((t) => t.name !== "search");
    case "no_jump":
      return tools.filter((t) => t.name !== "jump_to_ref");
    case "baseline_search_read":
      return tools.filter((t) => SEARCH_READ_FLOOR.has(t.name));
    default:
      // full, the content-transform axes (Seam B), and unknown variants keep all.
      return tools;
  }
}

// Seam B — ablation by tool-result transform: a content axis rewrites a tool's
// output before it reaches the agent (and the trace). The agent loop applies this
// via deps.ablation before recordToolCall, so the trace reflects what the agent saw.

const STRUCTURE_STRIPPED = "Structure navigation is unavailable in this configuration.";
const TERMINAL_GAP = "The probed wording is not in the current knowledge base coverage.";

// Parse a tool result as a status-tagged object; null when it is not such JSON.
function asStatusObject(result: string): Record<string, unknown> | null {
  try {
    const obj: unknown = JSON.parse(result);
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Drop the hierarchy fields from each search hit, leaving flat retrieval data.
function stripHitStructure(result: string): string {
  const obj = asStatusObject(result);
  if (!obj || obj["status"] !== "results" || !Array.isArray(obj["hits"])) return result;
  const hits = (obj["hits"] as Record<string, unknown>[]).map((h) => {
    const flat = { ...h };
    delete flat["breadcrumb"];
    delete flat["siblings"];
    delete flat["parent_summary"];
    return flat;
  });
  return JSON.stringify({ ...obj, hits });
}

function suppressKnownGap(result: string): string {
  const obj = asStatusObject(result);
  return obj && obj["status"] === "known_gap" ? JSON.stringify({ status: "results", hits: [] }) : result;
}

function terminalizeKnownGap(result: string): string {
  const obj = asStatusObject(result);
  return obj && obj["status"] === "known_gap"
    ? JSON.stringify({ ...obj, recommendation: TERMINAL_GAP })
    : result;
}

export function ablateResult(variant: string, toolName: string, result: string): string {
  switch (variant) {
    case "no_structure":
      if (toolName === "read_index" || toolName === "read_chunks") return STRUCTURE_STRIPPED;
      if (toolName === "search") return stripHitStructure(result);
      return result;
    case "no_gap":
      return toolName === "search" ? suppressKnownGap(result) : result;
    case "no_retry_scaffold":
      return toolName === "search" ? terminalizeKnownGap(result) : result;
    default:
      return result;
  }
}
