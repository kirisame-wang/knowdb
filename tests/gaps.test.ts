import { describe, it, expect } from "vitest";
import {
  normalizeKeyword,
  makeGapId,
  nextDailySeq,
  serializeGap,
  parseGapsJsonl,
  aggregate,
  checkKnownGap,
  BrowserGapSink,
  HIGH,
  MID,
} from "../src/gaps.js";
import type { GapEvent } from "../src/types.js";

const ev = (over: Partial<GapEvent> & Pick<GapEvent, "keyword" | "timestamp">): GapEvent => ({
  source: "browser",
  gap_id: "gap_20260516_001",
  scope: null,
  ...over,
});

describe("normalizeKeyword", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeKeyword("  Advanced   Config ")).toBe("advanced config");
    expect(normalizeKeyword("FOO")).toBe("foo");
    expect(normalizeKeyword("a\t b\n c")).toBe("a b c");
  });

  it("is idempotent", () => {
    const once = normalizeKeyword("  Backup  Strategy ");
    expect(normalizeKeyword(once)).toBe(once);
  });
});

describe("makeGapId", () => {
  it("formats gap_<yyyymmdd>_<seq3> in UTC", () => {
    expect(makeGapId(new Date("2026-05-16T12:00:00Z"), 1)).toBe("gap_20260516_001");
    expect(makeGapId(new Date("2026-01-09T23:59:59Z"), 42)).toBe("gap_20260109_042");
  });

  it("pads the day sequence to three digits", () => {
    expect(makeGapId(new Date("2026-12-31T00:00:00Z"), 7)).toBe("gap_20261231_007");
    expect(makeGapId(new Date("2026-12-31T00:00:00Z"), 123)).toBe("gap_20261231_123");
  });
});

describe("serializeGap / parseGapsJsonl", () => {
  it("round-trips a full event including optional context", () => {
    const e: GapEvent = {
      source: "local",
      gap_id: "gap_20260516_002",
      keyword: "進階配置",
      scope: "aaa00001",
      timestamp: "2026-05-16T10:00:00.000Z",
      user_question: "如何優化效能？",
      current_document: "aaa00001",
      navigation_path: ["list_docs", "search"],
      query_id: "q_1",
    };
    const line = serializeGap(e);
    expect(line.includes("\n")).toBe(false); // one JSONL line
    expect(parseGapsJsonl(line)).toEqual([e]);
  });

  it("parses multi-line JSONL and ignores blank/trailing lines", () => {
    const a = ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" });
    const b = ev({ keyword: "y", timestamp: "2026-05-16T11:00:00Z", gap_id: "gap_20260516_002" });
    const text = serializeGap(a) + "\n" + serializeGap(b) + "\n\n";
    expect(parseGapsJsonl(text)).toEqual([a, b]);
  });

  it("returns [] for empty input", () => {
    expect(parseGapsJsonl("")).toEqual([]);
    expect(parseGapsJsonl("\n  \n")).toEqual([]);
  });

  it("skips malformed lines instead of throwing (corrupt-append tolerance)", () => {
    const a = ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" });
    const b = ev({ keyword: "y", timestamp: "2026-05-16T11:00:00Z", gap_id: "gap_20260516_002" });
    const text =
      serializeGap(a) + "\n" + '{"gap_id":"gap_2026' + "\n" + "not json" + "\n" + serializeGap(b) + "\n";
    expect(parseGapsJsonl(text)).toEqual([a, b]);
  });
});

describe("aggregate", () => {
  const events: GapEvent[] = [
    ev({ keyword: "Advanced Config", timestamp: "2026-05-10T08:00:00Z", scope: null }),
    ev({ keyword: "advanced   config", timestamp: "2026-05-12T09:00:00Z", scope: "aaa00001" }),
    ev({ keyword: "Backup", timestamp: "2026-05-11T10:00:00Z", scope: null }),
    ev({ keyword: "ADVANCED config", timestamp: "2026-05-09T07:00:00Z", scope: "aaa00001" }),
  ];

  it("groups by normalized keyword", () => {
    const agg = aggregate(events);
    const topics = agg.map((a) => a.topic);
    expect(topics).toContain("advanced config");
    expect(topics).toContain("backup");
    expect(agg).toHaveLength(2);
  });

  it("counts occurrences and tracks first/last seen across the group", () => {
    const a = aggregate(events).find((x) => x.topic === "advanced config")!;
    expect(a.occurrence_count).toBe(3);
    expect(a.first_seen).toBe("2026-05-09T07:00:00Z");
    expect(a.last_seen).toBe("2026-05-12T09:00:00Z");
  });

  it("de-duplicates scopes within a topic", () => {
    const a = aggregate(events).find((x) => x.topic === "advanced config")!;
    expect([...a.scopes].sort()).toEqual([null, "aaa00001"].sort());
    expect(a.scopes.length).toBe(2);
  });

  it("sorts by occurrence_count descending", () => {
    const agg = aggregate(events);
    for (let i = 1; i < agg.length; i++) {
      expect(agg[i - 1]!.occurrence_count).toBeGreaterThanOrEqual(agg[i]!.occurrence_count);
    }
    expect(agg[0]!.topic).toBe("advanced config");
  });

  it("returns [] for no events", () => {
    expect(aggregate([])).toEqual([]);
  });
});

describe("checkKnownGap", () => {
  const many = (kw: string, n: number): GapEvent[] =>
    Array.from({ length: n }, (_, i) =>
      ev({ keyword: kw, timestamp: new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString() })
    );

  it("returns null below MID (caller falls back to [])", () => {
    expect(checkKnownGap(many("ksql", MID - 1), "ksql")).toBeNull();
  });

  it("returns null when the keyword has never been a gap", () => {
    expect(checkKnownGap(many("other", 20), "never asked")).toBeNull();
  });

  it("at MID returns a known_gap recommending alternative keywords", () => {
    const r = checkKnownGap(many("sharding", MID), "sharding")!;
    expect(r).not.toBeNull();
    expect(r.status).toBe("known_gap");
    expect(r.gap_info.occurrence_count).toBe(MID);
    expect(r.recommendation).toContain("替代");
  });

  it("between MID and HIGH stays in the alternative-keyword tier", () => {
    const r = checkKnownGap(many("sharding", MID + 1), "sharding")!;
    expect(r.recommendation).toContain("替代");
    expect(r.recommendation).not.toContain("覆蓋範圍");
  });

  it("at/above HIGH recommends out-of-coverage", () => {
    const r = checkKnownGap(many("federation", HIGH), "federation")!;
    expect(r.gap_info.occurrence_count).toBe(HIGH);
    expect(r.recommendation).toContain("覆蓋範圍");
    const r2 = checkKnownGap(many("federation", HIGH + 5), "federation")!;
    expect(r2.recommendation).toContain("覆蓋範圍");
  });

  it("matches via normalized keyword and reports the count + topic", () => {
    const r = checkKnownGap(many("Advanced  Config", HIGH), "  advanced config ")!;
    expect(r.gap_info.topic).toBe("advanced config");
    expect(r.gap_info.occurrence_count).toBe(HIGH);
    expect(r.message).toContain(String(HIGH));
  });

  it("propagates first_seen into gap_info", () => {
    const evs = many("backup", MID);
    const r = checkKnownGap(evs, "backup")!;
    expect(r.gap_info.first_seen).toBe(evs[0]!.timestamp);
  });
});

describe("nextDailySeq", () => {
  const day = new Date("2026-05-16T12:00:00Z");

  it("is 1 when no events exist for that UTC day", () => {
    expect(nextDailySeq([], day)).toBe(1);
    expect(nextDailySeq([ev({ keyword: "x", timestamp: "2026-05-15T23:59:59Z" })], day)).toBe(1);
  });

  it("counts only same-UTC-day events", () => {
    const events = [
      ev({ keyword: "a", timestamp: "2026-05-16T00:00:01Z" }),
      ev({ keyword: "b", timestamp: "2026-05-16T18:00:00Z" }),
      ev({ keyword: "c", timestamp: "2026-05-15T10:00:00Z" }),
    ];
    expect(nextDailySeq(events, day)).toBe(3);
  });
});

class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

describe("BrowserGapSink", () => {
  it("records and reads back events round-trip", () => {
    const sink = new BrowserGapSink(new FakeKV());
    const a = ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" });
    const b = ev({ keyword: "y", timestamp: "2026-05-16T11:00:00Z", gap_id: "gap_20260516_002" });
    sink.record(a);
    sink.record(b);
    expect(sink.readAll()).toEqual([a, b]);
  });

  it("dump() returns the raw JSONL for export", () => {
    const kv = new FakeKV();
    const sink = new BrowserGapSink(kv);
    const a = ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" });
    sink.record(a);
    expect(sink.dump()).toBe(serializeGap(a) + "\n");
  });

  it("starts empty", () => {
    expect(new BrowserGapSink(new FakeKV()).readAll()).toEqual([]);
  });
});

describe("threshold constants", () => {
  it("HIGH > MID > 0", () => {
    expect(HIGH).toBeGreaterThan(MID);
    expect(MID).toBeGreaterThan(0);
  });
});
