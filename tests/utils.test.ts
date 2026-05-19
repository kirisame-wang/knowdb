import { describe, it, expect } from "vitest";
import { utcYmd, newSessionId, toJsonLine, parseJsonl } from "../src/utils.js";

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
