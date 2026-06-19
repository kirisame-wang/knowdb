import { describe, it, expect } from "vitest";
import { COMPARE_ARMS } from "../../src/ui/compare-mode.js";
import { ABLATION_VARIANTS } from "../../src/benchmark/ablation.js";

describe("compare-mode arms", () => {
  it("the fixed arms are three valid ablation variants incl. the floor", () => {
    expect(COMPARE_ARMS).toHaveLength(3);
    // Each must be a known variant, or toolsFor/ablateResult would silently default to full.
    for (const v of COMPARE_ARMS) expect(ABLATION_VARIANTS.has(v)).toBe(true);
    expect(COMPARE_ARMS).toContain("baseline_search_read"); // the search+read floor
  });
});
