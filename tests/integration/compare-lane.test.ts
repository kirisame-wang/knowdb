// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { mountLane } from "../../src/ui/compare-lane.js";
import type { TraceCollectorEvent } from "../../src/traces.js";
import { qStart, tool, round, end } from "../lane-events.js";

class FakeCollector {
  private subs = new Set<(e: TraceCollectorEvent) => void>();
  subscribe(cb: (e: TraceCollectorEvent) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(e: TraceCollectorEvent): void {
    for (const cb of this.subs) cb(e);
  }
}

const col = (id: string): HTMLElement => document.getElementById(id)!;

beforeEach(() => {
  document.body.innerHTML = `<div id="lane-full"></div><div id="lane-ns"></div>`;
});

describe("compare-lane DOM", () => {
  it("renders the question as a user bubble, tool calls as traces, and the answer as an assistant bubble", () => {
    const c = new FakeCollector();
    mountLane("full", c, col("lane-full"));
    c.emit(qStart("FY2024?"));
    c.emit(tool(1, "search", { keyword: "x" }, "3 hits"));
    c.emit(tool(2, "read_chunk", { id: "a/01" }, "content"));
    c.emit(round(100, 30));
    c.emit(end({ final_answer: "the answer" }));

    const root = col("lane-full");
    expect(root.querySelector(".chat-bubble.user")!.textContent).toBe("FY2024?");
    expect(root.querySelectorAll(".tool-trace")).toHaveLength(2);
    expect(root.querySelector(".chat-bubble.assistant")!.textContent).toBe("the answer");
    expect(root.querySelector(".badge")!.textContent).toBe("answered");
    expect(root.querySelector(".badge")!.classList.contains("answered")).toBe(true);
    expect(root.querySelector(".lane-status")!.textContent).toContain("2 tool calls");
    // token total is hover-only (title), never standing text
    expect(root.querySelector<HTMLElement>(".tok")!.title).toBe("this lane — tokens in 100 / out 30");
  });

  it("auto-expands only the latest tool trace", () => {
    const c = new FakeCollector();
    mountLane("full", c, col("lane-full"));
    c.emit(qStart());
    c.emit(tool(1, "search", { keyword: "x" }));
    c.emit(tool(2, "read_chunk", { id: "a/01" }));

    const traces = col("lane-full").querySelectorAll<HTMLDetailsElement>(".tool-trace");
    expect(traces[0]!.open).toBe(false);
    expect(traces[1]!.open).toBe(true); // newest open
  });

  it("shows a red overflow line and badge when the arm hit the context wall, no answer bubble", () => {
    const c = new FakeCollector();
    mountLane("no_structure", c, col("lane-ns"));
    c.emit(qStart());
    c.emit(tool(1, "read_index", { doc_id: "d" }, "unavailable"));
    c.emit(end({ error: "400 prompt is too long" }));

    const root = col("lane-ns");
    expect(root.querySelector(".status-text.overflow")).not.toBeNull();
    expect(root.querySelector(".chat-bubble.assistant")).toBeNull();
    expect(root.querySelector(".badge")!.textContent).toBe("overflow · no answer");
  });

  it("renders two arms independently in their own columns", () => {
    const a = new FakeCollector();
    const b = new FakeCollector();
    mountLane("full", a, col("lane-full"));
    mountLane("no_structure", b, col("lane-ns"));
    a.emit(qStart());
    a.emit(end({ final_answer: "done" }));
    b.emit(qStart());

    expect(col("lane-full").querySelector(".badge")!.textContent).toBe("answered");
    expect(col("lane-ns").querySelector(".badge")!.textContent).toBe("running…");
  });

  it("stops updating after teardown", () => {
    const c = new FakeCollector();
    const unmount = mountLane("full", c, col("lane-full"));
    c.emit(qStart());
    c.emit(tool(1, "search", { keyword: "x" }));
    unmount();
    c.emit(tool(2, "read_chunk", { id: "a/01" }));

    expect(col("lane-full").querySelectorAll(".tool-trace")).toHaveLength(1);
  });

  it("renders the aborted and errored status lines with their distinct classes", () => {
    const a = new FakeCollector();
    mountLane("full", a, col("lane-full"));
    a.emit(qStart());
    a.emit(end({ aborted: true }));
    const ab = col("lane-full").querySelector(".status-text")!;
    expect(ab.textContent).toBe("stopped");
    expect(ab.classList.contains("overflow")).toBe(false); // aborted is not styled like overflow

    const b = new FakeCollector();
    mountLane("no_structure", b, col("lane-ns"));
    b.emit(qStart());
    b.emit(end({ error: "401 invalid x-api-key" }));
    expect(col("lane-ns").querySelector(".status-text.overflow")!.textContent).toBe("401 invalid x-api-key");
    expect(col("lane-ns").querySelector(".badge")!.textContent).toBe("error · no answer");
  });

  it("adds the estimated-cost line to the token title when pricing is supplied", () => {
    const c = new FakeCollector();
    mountLane("full", c, col("lane-full"), { inputPerMTok: 1, outputPerMTok: 5 });
    c.emit(qStart());
    c.emit(round(1_000_000, 200_000)); // $1.00 in + $1.00 out
    expect(col("lane-full").querySelector<HTMLElement>(".tok")!.title).toBe(
      "this lane — tokens in 1000000 / out 200000\nest. cost — $2.0000",
    );
  });
});
