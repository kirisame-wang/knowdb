import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import type { ResultsResponse, SearchResult } from "../types.js";

// The known ablation axes — the single source of truth the runner validates
// against, so a misspelled variant fails loud instead of degrading to full.
export const ABLATION_VARIANTS = new Set<string>([
  "full",
  "no_structure",
  "no_search",
  "no_jump",
  "no_gap",
  "no_retry_scaffold",
  "baseline_search_read",
]);

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

// The hierarchy fields stripped from each search hit. Typed against SearchResult
// so a rename in the data-layer schema breaks here rather than silently no-opping.
const STRUCTURE_FIELDS: (keyof SearchResult)[] = ["breadcrumb", "siblings", "parent_summary"];

// Drop the hierarchy fields from each search hit, leaving flat retrieval data.
function stripHitStructure(result: string): string {
  const obj = asStatusObject(result);
  if (!obj || obj["status"] !== "results" || !Array.isArray(obj["hits"])) return result;
  const hits = (obj["hits"] as Record<string, unknown>[]).map((h) => {
    const flat = { ...h };
    for (const f of STRUCTURE_FIELDS) delete flat[f];
    return flat;
  });
  return JSON.stringify({ ...obj, hits });
}

function suppressKnownGap(result: string): string {
  const obj = asStatusObject(result);
  return obj && obj["status"] === "known_gap"
    ? JSON.stringify({ status: "results", hits: [] } satisfies ResultsResponse)
    : result;
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
      // read_index/read_chunks/parent ARE the structure (tree, siblings, parent
      // step) — blank them outright; search keeps its hits but loses hierarchy.
      if (toolName === "read_index" || toolName === "read_chunks" || toolName === "parent")
        return STRUCTURE_STRIPPED;
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
