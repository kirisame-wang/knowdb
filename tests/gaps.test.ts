import { describe, it, expect } from "vitest";
import {
  normalizeKeyword,
  makeGapId,
  nextDailySeq,
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
    expect(r.recommendation).toContain("alternative");
  });

  it("between MID and HIGH stays in the alternative-keyword tier", () => {
    const r = checkKnownGap(many("sharding", MID + 1), "sharding")!;
    expect(r.recommendation).toContain("alternative");
    expect(r.recommendation).not.toContain("coverage");
  });

  it("at/above HIGH recommends out-of-coverage", () => {
    const r = checkKnownGap(many("federation", HIGH), "federation")!;
    expect(r.gap_info.occurrence_count).toBe(HIGH);
    expect(r.recommendation).toContain("coverage");
    const r2 = checkKnownGap(many("federation", HIGH + 5), "federation")!;
    expect(r2.recommendation).toContain("coverage");
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
  const SID = "sess-test-1";

  it("records and reads back events round-trip (stamped with the session id)", () => {
    const sink = new BrowserGapSink(new FakeKV(), "knowdb-gaps", SID);
    const a = ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" });
    const b = ev({ keyword: "y", timestamp: "2026-05-16T11:00:00Z", gap_id: "gap_20260516_002" });
    sink.record(a);
    sink.record(b);
    expect(sink.readAll()).toEqual([
      { ...a, session_id: SID },
      { ...b, session_id: SID },
    ]);
  });

  it("dump() returns the raw JSONL for export", () => {
    const sink = new BrowserGapSink(new FakeKV(), "knowdb-gaps", SID);
    const a = ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" });
    sink.record(a);
    expect(sink.dump()).toBe(JSON.stringify({ ...a, session_id: SID }) + "\n");
  });

  it("starts empty", () => {
    expect(new BrowserGapSink(new FakeKV()).readAll()).toEqual([]);
  });

  it("stamps an ephemeral session id: stable within an instance, distinct across instances", () => {
    const s1 = new BrowserGapSink(new FakeKV());
    const s2 = new BrowserGapSink(new FakeKV());
    s1.record(ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" }));
    s1.record(ev({ keyword: "y", timestamp: "2026-05-16T11:00:00Z" }));
    s2.record(ev({ keyword: "z", timestamp: "2026-05-16T12:00:00Z" }));
    const a1 = s1.readAll();
    const a2 = s2.readAll();
    expect(typeof a1[0]!.session_id).toBe("string");
    expect(a1[0]!.session_id).toBe(a1[1]!.session_id); // stable within instance
    expect(a1[0]!.session_id).not.toBe(a2[0]!.session_id); // distinct across instances
  });
});

describe("threshold constants", () => {
  it("HIGH > MID > 0", () => {
    expect(HIGH).toBeGreaterThan(MID);
    expect(MID).toBeGreaterThan(0);
  });
});

describe("gap key canonicalization (|-alternation)", () => {
  it("aggregates |-alternation regardless of order/case/spacing into one topic", () => {
    const agg = aggregate([
      ev({ keyword: "redis|memcached", timestamp: "2026-05-20T01:00:00Z" }),
      ev({ keyword: "memcached|redis", timestamp: "2026-05-20T02:00:00Z" }),
      ev({ keyword: "Redis | Memcached", timestamp: "2026-05-20T03:00:00Z" }),
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.occurrence_count).toBe(3);
  });

  it("checkKnownGap counts |-alternation variants as one topic (reaches MID)", () => {
    const variants = ["a|b", "b|a", "a | b", "B|A", "b |  a"]; // all → key "a|b"
    const evs = Array.from({ length: MID }, (_, i) =>
      ev({
        keyword: variants[i % variants.length]!,
        timestamp: new Date(Date.UTC(2026, 4, 20, 0, 0, i)).toISOString(),
      })
    );
    const r = checkKnownGap(evs, "B | A");
    expect(r).not.toBeNull();
    expect(r!.gap_info.occurrence_count).toBe(MID);
  });

  it("keeps a phrase distinct from an OR (whitespace is literal)", () => {
    const agg = aggregate([
      ev({ keyword: "cache eviction", timestamp: "2026-05-20T01:00:00Z" }),
      ev({ keyword: "cache|eviction", timestamp: "2026-05-20T02:00:00Z" }),
    ]);
    expect(agg).toHaveLength(2);
  });
});
