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
