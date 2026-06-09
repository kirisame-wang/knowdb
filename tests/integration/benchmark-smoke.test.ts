// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The harness self-gates at import: it must be inert unless ?benchmark=1.
// These tests exercise that gate by importing the module under two URL states.

function setUrl(search: string): void {
  window.location.href = `https://localhost/${search}`;
}

describe("benchmark smoke harness — flag gating", () => {
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
    await import("../../src/ui/benchmark-smoke.js");
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
    await import("../../src/ui/benchmark-smoke.js");
    // The panel is appended synchronously at mount start, before any await.
    expect(document.getElementById("knowdb-smoke")).not.toBeNull();
    // Mount loads index + manifest + smoke.json (all three fetches fire synchronously).
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("smoke.json"))).toBe(true);
  });
});
