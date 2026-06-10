// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SmokeReportView } from "../../src/benchmark/smoke.js";

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
    expect(document.getElementById("knowdb-smoke")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mounts the overlay panel and loads the static set when ?benchmark=1", async () => {
    setUrl("?benchmark=1");
    const fetchSpy = vi.fn(async (url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("smoke") ? [] : {}),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await import("../../src/ui/benchmark-mode.js");
    // The panel is appended synchronously at mount start, before any await.
    expect(document.getElementById("knowdb-smoke")).not.toBeNull();
    // The inline API-key input is present (no prompt popup).
    expect(document.getElementById("smoke-api-key")).not.toBeNull();
    // Mount loads index + manifest + smoke.json (all three fetches fire synchronously).
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("smoke.json"))).toBe(true);
  });
});

describe("renderReport — DOM tables", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  const VIEW: SmokeReportView = {
    title: "Smoke run r1 — ground-truth-free metrics",
    disclaimer: "No-ground-truth run; success-derived metrics suppressed.",
    meta: "model: stub",
    perVariant: {
      columns: [
        "variant",
        "turns",
        "avg steps",
        "avg in-tok",
        "avg out-tok",
        "pattern-use",
        "read-chunk chars (pat/no-pat)",
        "gap-signal",
        "within/cross (count)",
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
    cost: {
      realized: { input: 200, output: 40, turns: 2 },
      ratio: { baseline: "full", external: "baseline_search_read", input: 1.5, output: 1.2 },
      perAxis: [{ variant: "no_search", stepsDelta: 0.5 }],
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
    expect(header).toContain("count");
    expect(header).not.toContain("success");
    expect(header).not.toContain("recovery");

    expect(tables[0]!.querySelector("tbody")?.textContent).toContain("full"); // a variant row
    expect(el.textContent).toContain("Realized usage"); // cost story present
  });
});
