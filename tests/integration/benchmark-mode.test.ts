// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReportView } from "../../src/benchmark/report.js";

// The module self-gates at import: it must be inert unless ?benchmark=1.
// These tests exercise that gate by importing the module under two URL states.

function setUrl(search: string): void {
  window.location.href = `https://localhost/${search}`;
}

describe("benchmark mode UI — flag gating", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is inert without ?benchmark=1: no panel mounted, no fetch issued", async () => {
    setUrl("");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await import("../../src/ui/benchmark-mode.js");
    expect(document.getElementById("knowdb-benchmark")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mounts the overlay panel and loads the static set when ?benchmark=1", async () => {
    setUrl("?benchmark=1");
    const fetchSpy = vi.fn(async (url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("pilot.json") ? [] : {}),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await import("../../src/ui/benchmark-mode.js");
    // The panel is appended synchronously at mount start, before any await.
    expect(document.getElementById("knowdb-benchmark")).not.toBeNull();
    // The inline API-key input is present (no prompt popup).
    expect(document.getElementById("benchmark-api-key")).not.toBeNull();
    // Mount loads index + manifest + pilot.json (all three fetches fire synchronously).
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("pilot.json"))).toBe(true);
  });
});

describe("renderReport — DOM tables", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  const VIEW: ReportView = {
    title: "Benchmark run r1 — ground-truth-free metrics",
    disclaimer: "No-ground-truth run; success-derived metrics suppressed.",
    meta: "model: stub",
    perVariant: {
      columns: [
        "variant",
        "turns",
        "avg steps",
        "avg in-tok",
        "avg out-tok",
        "pattern-use (of reads)",
        "read chars (pattern/plain)",
        "gap-signal",
        "docs read (1/>1)",
      ],
      rows: [
        {
          variant: "full",
          turns: 2,
          avgSteps: 3,
          avgIn: 100,
          avgOut: 20,
          patternUse: 0.5,
          readChunkChars: { withPattern: 10, withoutPattern: 20 },
          gapSignal: 0,
          within: 2,
          cross: 0,
        },
      ],
    },
    axisDeltas: [{ variant: "no_search", stepsDelta: 0.5 }],
    cost: {
      realized: { input: 200, output: 40, steps: 9, turns: 2 },
      ratio: { baseline: "full", external: "baseline_search_read", input: 1.5, output: 1.2, steps: 0.8 },
    },
  };

  it("renders the per-variant data as a real <table>, with no success column", async () => {
    setUrl(""); // no flag → no auto-mount; call renderReport directly
    const { renderReport } = await import("../../src/ui/benchmark-mode.js");
    const el = renderReport(VIEW);

    const tables = el.querySelectorAll("table");
    expect(tables.length).toBeGreaterThanOrEqual(1);

    const header = (tables[0]!.querySelector("thead")?.textContent ?? "").toLowerCase();
    expect(header).toContain("avg steps");
    expect(header).toContain("docs read"); // behavioural read count, not a success rate
    expect(header).not.toContain("success");
    expect(header).not.toContain("recovery");

    expect(tables[0]!.querySelector("tbody")?.textContent).toContain("full"); // a variant row
    expect(el.textContent).toContain("Realized usage"); // cost story present
  });

  it("renders a success table with the outcome split when ground truth is present", async () => {
    setUrl("");
    const { renderReport } = await import("../../src/ui/benchmark-mode.js");
    const view: ReportView = {
      ...VIEW,
      title: "Benchmark run r1 — pilot (hand-filled ground truth)",
      axisDeltas: [{ variant: "no_search", stepsDelta: 0.5, successDelta: -0.5 }],
      success: {
        columns: ["variant", "success", "within✓", "cross✓", "steps ✓/✗", "in-tok ✓/✗", "out-tok ✓/✗"],
        rows: [
          { variant: "full", role: "baseline", successRate: 0.5, successPass: 1, withinSuccess: 0.5, withinPass: 1, withinTurns: 2, crossSuccess: 0, crossPass: 0, crossTurns: 0, success: { turns: 1, avgSteps: 3, avgIn: 100, avgOut: 20 }, failure: { turns: 1, avgSteps: 8, avgIn: 300, avgOut: 40 }, overflow: 0, overflowAfterReach: 0 },
          { variant: "no_search", successRate: 0, successPass: 0, withinSuccess: 0, withinPass: 0, withinTurns: 1, crossSuccess: 0, crossPass: 0, crossTurns: 0, success: { turns: 0, avgSteps: 0, avgIn: 0, avgOut: 0 }, failure: { turns: 1, avgSteps: 9, avgIn: 500, avgOut: 60 }, overflow: 0, overflowAfterReach: 0 },
        ],
      },
    };
    const el = renderReport(view);
    const headers = Array.from(el.querySelectorAll("table thead")).map((h) => h.textContent ?? "");
    expect(headers.some((h) => h.includes("within✓") && h.includes("steps ✓/✗"))).toBe(true);
    const allText = el.textContent ?? "";
    expect(allText).toContain("3.00/8.00"); // full: succeeded/failed steps
    expect(allText).toContain("—/9.00"); // no_search: no successes → — on the ✓ side
    expect(allText).toContain("-50pp"); // success delta (axis-off − baseline) in percentage points
  });

  it("renders no success table without ground truth (GT-free view)", async () => {
    setUrl("");
    const { renderReport } = await import("../../src/ui/benchmark-mode.js");
    const headers = Array.from(renderReport(VIEW).querySelectorAll("table thead")).map((h) => (h.textContent ?? "").toLowerCase());
    expect(headers.some((h) => h.includes("success"))).toBe(false);
  });

  it("renders a loud banner when a run did no work (0 tokens)", async () => {
    setUrl("");
    const { renderErrors } = await import("../../src/ui/benchmark-mode.js");
    const el = renderErrors(["full · t1#0: 401 invalid x-api-key"], true);
    expect(el.textContent).toContain("no successful API call");
    expect(el.textContent).toContain("401 invalid x-api-key");
  });
});
