import { describe, it, expect } from "vitest";
import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import { toolsFor } from "../../../src/benchmark/ablation.js";

// The full KnowDB tool surface (names only — toolsFor filters by name, never by
// schema). Order matters: toolsFor must preserve the input order and identity.
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

describe("toolsFor — Seam A tool allowlist per ablation variant", () => {
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

  it("content-transform axes do not touch the tool list (they use Seam B)", () => {
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
