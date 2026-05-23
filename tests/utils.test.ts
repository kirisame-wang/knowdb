import { describe, it, expect } from "vitest";
import {
  utcYmd,
  newSessionId,
  toJsonLine,
  parseJsonl,
  truncateOutput,
  SessionContext,
  nextDailySeq,
} from "../src/utils.js";

describe("utcYmd", () => {
  it("formats UTC yyyymmdd, zero-padded", () => {
    expect(utcYmd(new Date("2026-05-16T12:00:00Z"))).toBe("20260516");
    expect(utcYmd(new Date("2026-01-09T23:59:59Z"))).toBe("20260109");
  });

  it("uses UTC, not local time", () => {
    expect(utcYmd(new Date("2026-05-16T23:30:00Z"))).toBe("20260516");
  });
});

describe("newSessionId", () => {
  it("returns a non-empty string, distinct across calls", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

interface Rec {
  id: number;
  tag: string;
}

describe("toJsonLine / parseJsonl", () => {
  it("round-trips a value on a single line", () => {
    const r: Rec = { id: 1, tag: "x" };
    const line = toJsonLine(r);
    expect(line.includes("\n")).toBe(false);
    expect(parseJsonl<Rec>(line)).toEqual([r]);
  });

  it("parses multi-line JSONL and ignores blank/trailing lines", () => {
    const a: Rec = { id: 1, tag: "a" };
    const b: Rec = { id: 2, tag: "b" };
    const text = toJsonLine(a) + "\n" + toJsonLine(b) + "\n\n";
    expect(parseJsonl<Rec>(text)).toEqual([a, b]);
  });

  it("returns [] for empty input", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("\n  \n")).toEqual([]);
  });

  it("skips malformed lines instead of throwing", () => {
    const a: Rec = { id: 1, tag: "a" };
    const b: Rec = { id: 2, tag: "b" };
    const text = toJsonLine(a) + "\n" + '{"id":2' + "\n" + "not json" + "\n" + toJsonLine(b) + "\n";
    expect(parseJsonl<Rec>(text)).toEqual([a, b]);
  });
});

describe("truncateOutput", () => {
  it("returns the input unchanged when within the limit", () => {
    expect(truncateOutput("hello", 600)).toBe("hello");
    expect(truncateOutput("x".repeat(600), 600)).toBe("x".repeat(600));
  });

  it("truncates with the canonical suffix when over the limit", () => {
    const out = truncateOutput("x".repeat(601), 600);
    expect(out.startsWith("x".repeat(600))).toBe(true);
    expect(out.endsWith("… (truncated)")).toBe(true);
    expect(out).toBe("x".repeat(600) + "\n… (truncated)");
  });

  it("defaults the limit to 600 chars", () => {
    expect(truncateOutput("x".repeat(600))).toBe("x".repeat(600));
    expect(truncateOutput("x".repeat(601)).endsWith("… (truncated)")).toBe(true);
  });
});

describe("SessionContext", () => {
  it("generates an ephemeral id by default", () => {
    const a = new SessionContext();
    const b = new SessionContext();
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
  });

  it("accepts an explicit id", () => {
    expect(new SessionContext("fixed-id").id).toBe("fixed-id");
  });
});

describe("nextDailySeq (generic timestamped counter)", () => {
  const day = new Date("2026-05-16T12:00:00Z");
  const at = (ts: string) => ({ timestamp: ts });

  it("is 1 when no items exist for that UTC day", () => {
    expect(nextDailySeq([], day)).toBe(1);
    expect(nextDailySeq([at("2026-05-15T23:59:59Z")], day)).toBe(1);
  });

  it("counts only same-UTC-day items", () => {
    expect(
      nextDailySeq(
        [at("2026-05-16T00:00:01Z"), at("2026-05-16T18:00:00Z"), at("2026-05-15T10:00:00Z")],
        day
      )
    ).toBe(3);
  });

  it("works on any shape with a timestamp string field (generic)", () => {
    const traces = [
      { query_id: "q1", started_at: "2026-05-16T01:00:00Z", timestamp: "2026-05-16T01:00:00Z" },
      { query_id: "q2", started_at: "2026-05-16T02:00:00Z", timestamp: "2026-05-16T02:00:00Z" },
    ];
    expect(nextDailySeq(traces, day)).toBe(3);
  });
});
