import { describe, it, expect } from "vitest";
import { BrowserGapSink } from "../../src/gaps.js";
import { BrowserTraceCollector } from "../../src/traces.js";
import { SessionContext } from "../../src/utils.js";
import type { GapEvent } from "../../src/types.js";

// In-memory KeyValueStore — mirrors localStorage for the gap sink.
class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const gap = (keyword: string, timestamp: string): GapEvent => ({
  source: "browser",
  gap_id: "gap_x",
  scope: null,
  keyword,
  timestamp,
});

// The gap sink and trace collector share one SessionContext, the way the UI
// wires them; New session rotates it. This pins the composed contract — a rotate
// re-groups BOTH streams onto the same new id, so the session_id join survives.
describe("session rotation — trace × gap join across New session", () => {
  it("rotating the shared SessionContext re-groups gap sink and trace collector together", () => {
    const ctx = new SessionContext("s0");
    const gaps = new BrowserGapSink(new FakeKV(), "knowdb-gaps", ctx);
    const traces = new BrowserTraceCollector(ctx);

    gaps.record(gap("a", "2026-05-16T10:00:00Z"));
    const t0 = traces.endQuery(
      traces.startQuery("Q0", new Date("2026-05-16T10:00:00Z")),
      "A0",
      undefined,
      new Date("2026-05-16T10:00:01Z"),
    );
    expect(gaps.readAll()[0]!.session_id).toBe("s0");
    expect(t0.session_id).toBe("s0");

    ctx.rotate();

    gaps.record(gap("b", "2026-05-16T11:00:00Z"));
    const t1 = traces.endQuery(
      traces.startQuery("Q1", new Date("2026-05-16T11:00:00Z")),
      "A1",
      undefined,
      new Date("2026-05-16T11:00:01Z"),
    );
    const recorded = gaps.readAll();
    expect(recorded[1]!.session_id).toBe(ctx.id);
    expect(t1.session_id).toBe(ctx.id);
    expect(recorded[1]!.session_id).toBe(t1.session_id); // both streams on the new id → join holds
  });
});
