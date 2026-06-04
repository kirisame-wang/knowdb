import { describe, it, expect } from "vitest";
import {
  normalizeKeyword,
  gapTopicKey,
  makeGapId,
  aggregate,
  checkKnownGap,
  BrowserGapSink,
} from "../../src/gaps.js";
import { SessionContext } from "../../src/utils.js";
import type { GapEvent } from "../../src/types.js";

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

  it("a single recorded miss already returns known_gap (no threshold)", () => {
    const r = checkKnownGap(many("ksql", 1), "ksql")!;
    expect(r).not.toBeNull();
    expect(r.status).toBe("known_gap");
    expect(r.gap_info.occurrence_count).toBe(1);
  });

  it("returns null when the keyword has never been a gap", () => {
    expect(checkKnownGap(many("other", 20), "never asked")).toBeNull();
  });

  it("returns a known_gap recommending alternative wording", () => {
    const r = checkKnownGap(many("sharding", 4), "sharding")!;
    expect(r.status).toBe("known_gap");
    expect(r.gap_info.occurrence_count).toBe(4);
    expect(r.recommendation).toContain("alternative");
  });

  it("recommendation is count-independent (frequency lives in occurrence_count, not the wording)", () => {
    const low = checkKnownGap(many("sharding", 1), "sharding")!;
    const high = checkKnownGap(many("sharding", 25), "sharding")!;
    expect(low.recommendation).toBe(high.recommendation);
    expect(high.gap_info.occurrence_count).toBe(25);
  });

  it("reports probe facts (uncovered wording), not an over-claimed coverage verdict", () => {
    const r = checkKnownGap(many("federation", 12), "federation")!;
    // honest bounded statement: report what was probed; do NOT claim the topic is absent (community feedback 5)
    expect(r.recommendation).toContain("does not confirm the topic is absent");
    expect(r.recommendation).toContain("alternative");
    // regression guard: the old over-claim ("not within ... coverage") must be gone
    expect(r.recommendation).not.toContain("not within the current knowledge base's coverage");
  });

  it("matches via normalized keyword and reports the count + topic", () => {
    const n = 12;
    const r = checkKnownGap(many("Advanced  Config", n), "  advanced config ")!;
    expect(r.gap_info.topic).toBe("advanced config");
    expect(r.gap_info.occurrence_count).toBe(n);
    expect(r.message).toContain(String(n));
  });

  it("propagates first_seen into gap_info", () => {
    const evs = many("backup", 2);
    const r = checkKnownGap(evs, "backup")!;
    expect(r.gap_info.first_seen).toBe(evs[0]!.timestamp);
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
    const sink = new BrowserGapSink(new FakeKV(), "knowdb-gaps", new SessionContext(SID));
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
    const sink = new BrowserGapSink(new FakeKV(), "knowdb-gaps", new SessionContext(SID));
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

  it("rejects events whose canonical key is empty (empty / |-only / pure whitespace)", () => {
    const sink = new BrowserGapSink(new FakeKV(), "knowdb-gaps", new SessionContext("sess-x"));
    sink.record(ev({ keyword: "", timestamp: "2026-05-20T01:00:00Z" }));
    sink.record(ev({ keyword: "|", timestamp: "2026-05-20T02:00:00Z" }));
    sink.record(ev({ keyword: "  |  ", timestamp: "2026-05-20T03:00:00Z" }));
    expect(sink.readAll()).toEqual([]);
  });

  // A SessionContext passed in stamps every event with its id, so a trace
  // collector sharing the same SessionContext produces events joinable on
  // session_id with this sink's gap events.
  it("accepts a SessionContext and stamps its id (cross-stream join enabler)", () => {
    const ctx = new SessionContext("shared-ctx-1");
    const sink = new BrowserGapSink(new FakeKV(), "knowdb-gaps", ctx);
    sink.record(ev({ keyword: "x", timestamp: "2026-05-16T10:00:00Z" }));
    sink.record(ev({ keyword: "y", timestamp: "2026-05-16T11:00:00Z", gap_id: "gap_20260516_002" }));
    const all = sink.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.session_id).toBe("shared-ctx-1");
    expect(all[1]!.session_id).toBe("shared-ctx-1");
  });

  // The third arg must be a SessionContext; a bare-string id would silently
  // bypass the holder, breaking cross-stream session_id sharing.
  it("type-level rejects bare string as third argument", () => {
    // @ts-expect-error — wrap in new SessionContext(id) instead.
    new BrowserGapSink(new FakeKV(), "knowdb-gaps", "raw-string-id");
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

  it("checkKnownGap matches via per-alternative aggregate (record-time split view)", () => {
    // Real flow: record-time emits one event per simple-OR alternative;
    // aggregate then has single-term topics. A simple-OR query should find
    // whichever alternative has accumulated misses.
    const evs = Array.from({ length: 2 }, (_, i) =>
      ev({
        keyword: "alpha",
        timestamp: new Date(Date.UTC(2026, 4, 20, 0, 0, i)).toISOString(),
      })
    );
    const r = checkKnownGap(evs, "alpha|beta");
    expect(r).not.toBeNull();
    expect(r!.gap_info.topic).toBe("alpha");
    expect(r!.gap_info.occurrence_count).toBe(2);
  });

  it("keeps a phrase distinct from an OR (whitespace is literal)", () => {
    const agg = aggregate([
      ev({ keyword: "cache eviction", timestamp: "2026-05-20T01:00:00Z" }),
      ev({ keyword: "cache|eviction", timestamp: "2026-05-20T02:00:00Z" }),
    ]);
    expect(agg).toHaveLength(2);
  });

  it("canonical topic string is lexicographic, joined with `|`", () => {
    const agg = aggregate([
      ev({ keyword: "redis|memcached", timestamp: "2026-05-20T01:00:00Z" }),
      ev({ keyword: "memcached|redis", timestamp: "2026-05-20T02:00:00Z" }),
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.topic).toBe("memcached|redis"); // sorted, not insertion order
  });

  // Out-of-contract regex (any metachar beyond `|`) is treated as one topic —
  // a naive `|` split would otherwise produce garbage like "b)|foo(a".
  it("treats complex regex as one topic — no split across regex metacharacters", () => {
    expect(gapTopicKey("foo(a|b)")).toBe("foo(a|b)");
    expect(gapTopicKey("z(a|b)")).toBe("z(a|b)");
    expect(gapTopicKey("[abc]")).toBe("[abc]");
    expect(gapTopicKey("foo\\b")).toBe("foo\\b");
  });
});
