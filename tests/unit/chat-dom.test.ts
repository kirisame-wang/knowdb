// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { buildBubble, buildToolTrace } from "../../src/ui/chat-dom.js";

describe("chat-dom builders", () => {
  it("builds a role-tagged bubble with the text", () => {
    const u = buildBubble("user", "hello");
    expect(u.className).toBe("chat-bubble user");
    expect(u.textContent).toBe("hello");
    expect(buildBubble("assistant", "hi").className).toBe("chat-bubble assistant");
  });

  it("builds a collapsed tool-trace with a summary and Input/Result body", () => {
    const d = buildToolTrace("search", { keyword: "x" }, "3 hits") as HTMLDetailsElement;
    expect(d.className).toBe("tool-trace");
    expect(d.open).toBe(false);
    // tool name + compact input; any leading glyph is presentational, not asserted.
    expect(d.querySelector("summary")!.textContent).toContain('search({"keyword":"x"})');
    const body = d.querySelector(".tool-trace-body")!;
    expect(body.textContent).toContain("Input:");
    expect(body.textContent).toContain("Result:\n3 hits"); // result rendered verbatim
  });

  it("opens the trace when asked, and truncates a long input summary", () => {
    const open = buildToolTrace("read_chunk", { id: "a/01" }, "c", { open: true }) as HTMLDetailsElement;
    expect(open.open).toBe(true);

    const longInput = { q: "x".repeat(80) };
    const sum = buildToolTrace("search", longInput, "r").querySelector("summary")!.textContent!;
    expect(sum.endsWith("…)")).toBe(true);
    expect(sum.length).toBeLessThan(JSON.stringify(longInput).length + 20);
  });
});
