import { describe, it, expect } from "vitest";
import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import { toolsFor, ablateResult } from "../../../src/benchmark/ablation.js";

// The full KnowDB tool surface (names only; toolsFor filters by name, preserving order and identity).
const NAMES = [
  "get_instructions",
  "list_docs",
  "read_index",
  "search",
  "read_chunk",
  "read_chunks",
  "parent",
  "jump_to_ref",
  "reconstruct_document",
] as const;

const TOOLS: Tool[] = NAMES.map((name) => ({
  name,
  description: `desc:${name}`,
  input_schema: { type: "object", properties: {} },
}));

const namesOf = (ts: Tool[]) => ts.map((t) => t.name);

describe("toolsFor — tool allowlist per ablation variant", () => {
  it("full keeps every tool, in order, by identity", () => {
    const out = toolsFor("full", TOOLS);
    expect(namesOf(out)).toEqual([...NAMES]);
    expect(out[0]).toBe(TOOLS[0]); // same object, not a copy
  });

  it("no_search drops only search", () => {
    expect(namesOf(toolsFor("no_search", TOOLS))).toEqual(
      NAMES.filter((n) => n !== "search"),
    );
  });

  it("no_jump drops only jump_to_ref", () => {
    expect(namesOf(toolsFor("no_jump", TOOLS))).toEqual(
      NAMES.filter((n) => n !== "jump_to_ref"),
    );
  });

  it("baseline_search_read keeps only {search, read_chunk} + orientation tools", () => {
    expect(namesOf(toolsFor("baseline_search_read", TOOLS))).toEqual([
      "get_instructions",
      "list_docs",
      "search",
      "read_chunk",
    ]);
  });

  it("content-transform axes do not touch the tool list", () => {
    for (const v of ["no_structure", "no_gap", "no_retry_scaffold"]) {
      expect(namesOf(toolsFor(v, TOOLS))).toEqual([...NAMES]);
    }
  });

  it("an unknown variant defaults to the full tool set", () => {
    expect(namesOf(toolsFor("mystery", TOOLS))).toEqual([...NAMES]);
  });

  it("does not mutate the input array", () => {
    const before = namesOf(TOOLS);
    toolsFor("no_search", TOOLS);
    toolsFor("baseline_search_read", TOOLS);
    expect(namesOf(TOOLS)).toEqual(before);
  });
});

// Search-result fixtures matching the real tool output shapes.
const resultsJson = JSON.stringify({
  status: "results",
  hits: [
    {
      id: "a/1",
      score: 3,
      excerpt: "first matching line",
      doc_title: "Doc A",
      breadcrumb: [{ title: "Root", id: "a/0" }],
      siblings: ["a/2", "a/3"],
      parent_summary: "Parent section",
    },
  ],
});
const knownGapJson = JSON.stringify({
  status: "known_gap",
  message: 'Known gap: the keyword "x" returned no results.',
  gaps: [{ topic: "x", occurrence_count: 1, first_seen: "2026-06-01T00:00:00Z" }],
  recommendation: "Retry with synonyms or related terms, or browse read_index / parent.",
});

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("ablateResult — result transforms per ablation variant", () => {
  it("non-ablating variants pass any result through unchanged", () => {
    for (const v of ["full", "no_search", "no_jump", "baseline_search_read", "mystery"]) {
      expect(ablateResult(v, "search", resultsJson)).toBe(resultsJson);
      expect(ablateResult(v, "read_index", "# tree")).toBe("# tree");
    }
  });

  describe("no_structure", () => {
    it("strips breadcrumb / siblings / parent_summary from search hits, keeps the rest", () => {
      const out = parse(ablateResult("no_structure", "search", resultsJson));
      const hit = (out["hits"] as Record<string, unknown>[])[0]!;
      expect(hit).toEqual({ id: "a/1", score: 3, excerpt: "first matching line", doc_title: "Doc A" });
      expect(out["status"]).toBe("results");
    });

    it("replaces read_index, read_chunks, and parent output with a constant structure-unavailable note", () => {
      const a = ablateResult("no_structure", "read_index", "# heading tree\n- 00");
      const b = ablateResult("no_structure", "read_chunks", JSON.stringify([{ id: "a/2", preview: "x" }]));
      const c = ablateResult("no_structure", "parent", JSON.stringify("a/0"));
      expect(a).toMatch(/structure/i);
      expect(a).toBe(b); // constant, independent of the stripped input
      expect(a).toBe(c); // parent (a structural step) is blanked too
      expect(a).not.toContain("heading tree");
    });

    it("leaves read_chunk content and a known_gap search untouched (gap is the gap axis)", () => {
      expect(ablateResult("no_structure", "read_chunk", "full chunk body")).toBe("full chunk body");
      expect(ablateResult("no_structure", "search", knownGapJson)).toBe(knownGapJson);
    });

    it("returns an unparseable search result as-is (defensive)", () => {
      expect(ablateResult("no_structure", "search", "not json")).toBe("not json");
    });
  });

  describe("no_gap", () => {
    it("turns a known_gap search into bare empty results", () => {
      expect(parse(ablateResult("no_gap", "search", knownGapJson))).toEqual({ status: "results", hits: [] });
    });

    it("leaves a normal results search and non-search tools untouched", () => {
      expect(ablateResult("no_gap", "search", resultsJson)).toBe(resultsJson);
      expect(ablateResult("no_gap", "read_index", "# tree")).toBe("# tree");
    });
  });

  describe("no_retry_scaffold", () => {
    it("keeps the known_gap status but rewrites the recommendation to a terminal one", () => {
      const out = parse(ablateResult("no_retry_scaffold", "search", knownGapJson));
      expect(out["status"]).toBe("known_gap"); // status preserved; only the recommendation is swapped
      expect(out["message"]).toBe('Known gap: the keyword "x" returned no results.');
      expect(out["gaps"]).toEqual([{ topic: "x", occurrence_count: 1, first_seen: "2026-06-01T00:00:00Z" }]);
      expect(out["recommendation"]).not.toContain("Retry");
      expect(String(out["recommendation"]).length).toBeGreaterThan(0);
    });

    it("leaves a normal results search untouched", () => {
      expect(ablateResult("no_retry_scaffold", "search", resultsJson)).toBe(resultsJson);
    });
  });
});
