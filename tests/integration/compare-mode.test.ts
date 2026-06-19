// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The module self-gates at import: inert unless ?compare=1.

function setUrl(search: string): void {
  window.location.href = `https://localhost/${search}`;
}

describe("compare mode — flag gating", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is inert without ?compare=1: no panel, no fetch", async () => {
    setUrl("");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await import("../../src/ui/compare-mode.js");
    expect(document.getElementById("knowdb-compare")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mounts the full-screen panel and loads db index + manifest when ?compare=1", async () => {
    setUrl("?compare=1");
    const fetchSpy = vi.fn(async (_url: unknown) => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy);
    await import("../../src/ui/compare-mode.js");
    // Panel + its own api-key input + composer mount synchronously, before any await.
    expect(document.getElementById("knowdb-compare")).not.toBeNull();
    expect(document.getElementById("compare-api-key")).not.toBeNull();
    expect(document.getElementById("compare-q")).not.toBeNull();
    expect(document.getElementById("compare-run")).not.toBeNull();
    // Loads the two static files the agent navigates (no question set — free-form).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("_search_index.json"))).toBe(true);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("_manifest.json"))).toBe(true);
    // The three lanes are painted from the start, each labelled with its arm
    // (the arm name is the first text node; an ⓘ child follows it).
    const lanes = document.querySelectorAll("#compare-lanes .lane");
    expect(lanes).toHaveLength(3);
    expect(Array.from(lanes).map((l) => l.querySelector(".lane-name")!.firstChild!.textContent)).toEqual([
      "full",
      "no_structure",
      "baseline_search_read",
    ]);
    expect(lanes[0]!.querySelector(".badge")!.textContent).toBe("ready");
    // A dedicated info element next to the arm name carries the tools / ablation
    // hint on hover (its glyph is presentational and deliberately not asserted).
    const info0 = lanes[0]!.querySelector(".lane-info") as HTMLElement;
    expect(info0.title).toContain("Full tool set");
  });

  it("disables Run and warns when db/ fails to load", async () => {
    setUrl("?compare=1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await import("../../src/ui/compare-mode.js");
    await new Promise((r) => setTimeout(r)); // let the failed load settle
    expect((document.getElementById("compare-run") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("compare-warn")!.textContent).toContain("Failed to load");
  });
});
