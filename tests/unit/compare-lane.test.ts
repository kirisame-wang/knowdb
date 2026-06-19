import { describe, it, expect } from "vitest";
import { reduceLane, initialLane } from "../../src/ui/compare-lane.js";
import type { TraceCollectorEvent } from "../../src/traces.js";
import { qStart, tool, round, end } from "../lane-events.js";

const fold = (events: TraceCollectorEvent[]) => events.reduce(reduceLane, initialLane("full"));

describe("compare-lane reduceLane", () => {
  it("assembles user → tool → answer items and counts tool calls", () => {
    const s = fold([
      qStart("FY2024?"),
      tool(1, "search", { keyword: "x" }, "3 hits"),
      tool(2, "read_chunk", { id: "a/01" }, "content"),
      end({ final_answer: "the answer" }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool", "tool", "answer"]);
    expect(s.items[0]).toEqual({ kind: "user", text: "FY2024?" });
    expect(s.items[1]).toMatchObject({ kind: "tool", ordinal: 1, tool: "search", result: "3 hits" });
    expect(s.items[3]).toEqual({ kind: "answer", text: "the answer" });
    expect(s.toolCalls).toBe(2);
    expect(s.status).toBe("answered");
  });

  it("starts idle and flips to running on query_start", () => {
    expect(initialLane("full").status).toBe("idle");
    expect(fold([qStart("Q")]).status).toBe("running");
  });

  it("accumulates tokens from api rounds (hover-only)", () => {
    const s = fold([qStart(), round(100, 30), round(80, 25)]);
    expect(s.tokens).toEqual({ input: 180, output: 55 });
    expect(s.status).toBe("running"); // not ended yet
  });

  it("marks overflow when the turn ended on a context-window 400", () => {
    const s = fold([qStart(), tool(1, "search", { keyword: "x" }), end({ error: "400 prompt is too long" })]);
    expect(s.status).toBe("overflow");
    expect(s.items.at(-1)!.kind).toBe("overflow");
  });

  it("marks aborted when the user stopped the turn", () => {
    const s = fold([qStart(), end({ aborted: true })]);
    expect(s.status).toBe("aborted");
    expect(s.items.at(-1)!.kind).toBe("aborted");
  });

  it("marks a non-overflow API error as errored (honest, not 'answered') and keeps the message", () => {
    const s = fold([qStart(), end({ error: "401 invalid x-api-key" })]);
    expect(s.status).toBe("errored");
    expect(s.items.at(-1)).toEqual({ kind: "errored", text: "401 invalid x-api-key" });
  });

  it("a clean end with no answer text terminates as answered without a stray bubble", () => {
    const s = fold([qStart("Q"), end({})]);
    expect(s.status).toBe("answered");
    expect(s.items.map((i) => i.kind)).toEqual(["user"]); // no terminal item appended
  });

  it("accumulates across turns: a follow-up appends to the same lane and tokens sum over the conversation", () => {
    const s = fold([
      qStart("first?", "q1"),
      round(100, 30, "q1"),
      end({ query_id: "q1", final_answer: "a1" }, "q1"),
      qStart("follow-up?", "q2"), // a second query folded onto the populated lane (multi-turn)
      round(50, 20, "q2"),
      end({ query_id: "q2", final_answer: "a2" }, "q2"),
    ]);
    // History is not reset on the second query_start — both turns are present.
    expect(s.items.map((i) => i.kind)).toEqual(["user", "answer", "user", "answer"]);
    expect(s.items[0]).toEqual({ kind: "user", text: "first?" });
    expect(s.items[2]).toEqual({ kind: "user", text: "follow-up?" });
    // tokens are a conversation-wide running total, not per-query.
    expect(s.tokens).toEqual({ input: 150, output: 50 });
    expect(s.status).toBe("answered");
  });
});
