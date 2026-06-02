import { describe, it, expect } from "vitest";
import {
  BrowserTraceCollector,
  BrowserTraceSink,
  aggregateLocalSession,
  aggregateMetrics,
  newCommandId,
  newQueryId,
  type TraceCollectorEvent,
} from "../../src/traces.js";
import { SessionContext } from "../../src/utils.js";
import type { GapEvent, LocalCommandEvent, QueryTrace } from "../../src/types.js";

class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

describe("newQueryId / newCommandId", () => {
  it("each call returns a distinct opaque id", () => {
    expect(new Set([newQueryId(), newQueryId(), newQueryId()]).size).toBe(3);
    expect(new Set([newCommandId(), newCommandId(), newCommandId()]).size).toBe(3);
  });

  it("carries a `q_` / `c_` namespace prefix for at-a-glance JSONL triage", () => {
    expect(newQueryId().startsWith("q_")).toBe(true);
    expect(newCommandId().startsWith("c_")).toBe(true);
  });

  it("body after the prefix is opaque (not the previous q_<yyyymmdd>_<seq3> format)", () => {
    expect(newQueryId()).not.toMatch(/^q_\d{8}_\d{3}$/);
    expect(newCommandId()).not.toMatch(/^c_\d{8}_\d{3}$/);
  });
});

describe("BrowserTraceSink", () => {
  it("flush + readAll round-trip matches insertion order", () => {
    const sink = new BrowserTraceSink(new FakeKV());
    const t1: QueryTrace = {
      source: "browser",
      query_id: "q_20260516_001",
      user_question: "Q1",
      started_at: "2026-05-16T10:00:00Z",
      ended_at: "2026-05-16T10:00:05Z",
      tool_calls: [],
      api_rounds: [],
      final_answer: "A1",
    };
    const t2: QueryTrace = { ...t1, query_id: "q_20260516_002", user_question: "Q2" };
    sink.flush(t1);
    sink.flush(t2);
    expect(sink.readAll()).toEqual([t1, t2]);
  });

  it("dump() returns raw JSONL for export", () => {
    const sink = new BrowserTraceSink(new FakeKV());
    const t: QueryTrace = {
      source: "browser",
      query_id: "q_20260516_001",
      user_question: "Q",
      started_at: "2026-05-16T10:00:00Z",
      ended_at: "2026-05-16T10:00:01Z",
      tool_calls: [],
      api_rounds: [],
    };
    sink.flush(t);
    expect(sink.dump()).toBe(JSON.stringify(t) + "\n");
  });

  it("starts empty", () => {
    expect(new BrowserTraceSink(new FakeKV()).readAll()).toEqual([]);
  });

  it("readAll() returns a snapshot — later flush() does not mutate a prior result", () => {
    const sink = new BrowserTraceSink(new FakeKV());
    const t1: QueryTrace = {
      source: "browser",
      query_id: "q_20260516_001",
      user_question: "Q1",
      started_at: "2026-05-16T10:00:00Z",
      ended_at: "2026-05-16T10:00:01Z",
      tool_calls: [],
      api_rounds: [],
    };
    sink.flush(t1);
    const snap = sink.readAll();
    expect(snap).toHaveLength(1);
    // Subsequent flush must not bleed into the snapshot already returned.
    sink.flush({ ...t1, query_id: "q_20260516_002" });
    expect(snap).toHaveLength(1);
    expect(snap[0]!.query_id).toBe("q_20260516_001");
  });

  it("respects a custom key", () => {
    const kv = new FakeKV();
    const sink = new BrowserTraceSink(kv, "custom-traces");
    const t: QueryTrace = {
      source: "browser",
      query_id: "q_20260516_001",
      user_question: "Q",
      started_at: "2026-05-16T10:00:00Z",
      ended_at: "2026-05-16T10:00:01Z",
      tool_calls: [],
      api_rounds: [],
    };
    sink.flush(t);
    expect(kv.getItem("custom-traces")).toContain('"query_id":"q_20260516_001"');
    expect(kv.getItem("knowdb-traces")).toBeNull();
  });
});

describe("BrowserTraceCollector lifecycle", () => {
  const SID = "sess-test-trace";

  it("startQuery returns an opaque unique id per call (not a daily sequence)", () => {
    const collector = new BrowserTraceCollector(new SessionContext("S"));
    const t = new Date("2026-05-16T10:00:00Z");
    const q1 = collector.startQuery("Q1", t);
    const q2 = collector.startQuery("Q2", t);  // same Date — id must still differ
    const q3 = collector.startQuery("Q3", t);
    // Distinct: each call yields a unique id even at the same wall-clock.
    expect(new Set([q1, q2, q3]).size).toBe(3);
    // Body after the q_ prefix is opaque — not a yyyymmdd/seq pattern that
    // a caller might try to parse for ordering. Audit walks session_id +
    // timestamp; query_id just needs to be unique.
    expect(q1).not.toMatch(/^q_\d{8}_\d{3}$/);
    expect(q2).not.toMatch(/^q_\d{8}_\d{3}$/);
    expect(q3).not.toMatch(/^q_\d{8}_\d{3}$/);
  });

  it("startQuery → recordToolCall/recordApiRound → endQuery produces a complete QueryTrace", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    const t0 = new Date("2026-05-16T10:00:00Z");
    const t1 = new Date("2026-05-16T10:00:03Z");

    const q = collector.startQuery("how to back up?", t0);
    expect(q).toMatch(/^q_/);  // opaque body — uniqueness covered by newQueryId tests above

    collector.recordApiRound(q, { input_tokens: 50, output_tokens: 20, duration_ms: 800 });
    collector.recordToolCall(q, {
      tool: "search",
      input: { keyword: "backup" },
      output_summary: '[{"id":"d1/01","score":2}]',
      duration_ms: 30,
      timestamp: "2026-05-16T10:00:01Z",
    });
    collector.recordToolCall(q, {
      tool: "read_chunk",
      input: { id: "d1/01" },
      output_summary: "…",
      duration_ms: 10,
      timestamp: "2026-05-16T10:00:02Z",
    });

    const trace = collector.endQuery(q, "Use backup.sh weekly.", undefined, t1);
    expect(trace.source).toBe("browser");
    expect(trace.query_id).toBe(q);
    expect(trace.session_id).toBe(SID);
    expect(trace.user_question).toBe("how to back up?");
    expect(trace.started_at).toBe(t0.toISOString());
    expect(trace.ended_at).toBe(t1.toISOString());
    expect(trace.tool_calls.map((c) => [c.ordinal, c.tool])).toEqual([
      [1, "search"],
      [2, "read_chunk"],
    ]);
    expect(trace.api_rounds.map((r) => r.ordinal)).toEqual([1]);
    expect(trace.final_answer).toBe("Use backup.sh weekly.");
    expect(trace.error).toBeUndefined();
  });

  it("propagates session_id from a SessionContext", () => {
    const ctx = new SessionContext("ctx-1");
    const collector = new BrowserTraceCollector(ctx);
    const q = collector.startQuery("Q", new Date("2026-05-16T10:00:00Z"));
    const t = collector.endQuery(q, "A", undefined, new Date("2026-05-16T10:00:01Z"));
    expect(t.session_id).toBe("ctx-1");
  });

  it("endQuery on error records error and omits final_answer", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    const q = collector.startQuery("Q", new Date("2026-05-16T10:00:00Z"));
    const t = collector.endQuery(q, undefined, "boom", new Date("2026-05-16T10:00:01Z"));
    expect(t.final_answer).toBeUndefined();
    expect(t.error).toBe("boom");
  });

  it("recordToolCall on unknown query_id throws", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    expect(() =>
      collector.recordToolCall("q_nope", {
        tool: "x",
        input: {},
        output_summary: "",
        duration_ms: 0,
        timestamp: "2026-05-16T10:00:00Z",
      })
    ).toThrow(/unknown query_id/);
  });

  it("endQuery on unknown query_id throws", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    expect(() => collector.endQuery("q_nope")).toThrow(/unknown query_id/);
  });

  it("recordApiRound on unknown query_id throws", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    expect(() =>
      collector.recordApiRound("q_nope", { input_tokens: 1, output_tokens: 1, duration_ms: 1 })
    ).toThrow(/unknown query_id/);
  });

  it("subscribe emits events in operation order; unsubscribe stops delivery", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    const log: string[] = [];
    const unsub = collector.subscribe((e: TraceCollectorEvent) => log.push(e.kind));

    const q = collector.startQuery("Q", new Date("2026-05-16T10:00:00Z"));
    collector.recordApiRound(q, { input_tokens: 1, output_tokens: 1, duration_ms: 1 });
    collector.recordToolCall(q, {
      tool: "t",
      input: {},
      output_summary: "",
      duration_ms: 1,
      timestamp: "2026-05-16T10:00:00Z",
    });
    collector.endQuery(q, "A", undefined, new Date("2026-05-16T10:00:01Z"));
    expect(log).toEqual(["query_start", "api_round_added", "tool_call_added", "query_end"]);

    unsub();
    const q2 = collector.startQuery("Q2", new Date("2026-05-16T11:00:00Z"));
    collector.endQuery(q2, "A2", undefined, new Date("2026-05-16T11:00:01Z"));
    expect(log).toEqual(["query_start", "api_round_added", "tool_call_added", "query_end"]); // unchanged
  });

  it("endQuery clears internal partial state — same query_id cannot be ended twice", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    const q = collector.startQuery("Q", new Date("2026-05-16T10:00:00Z"));
    collector.endQuery(q, "A", undefined, new Date("2026-05-16T10:00:01Z"));
    // Second endQuery on the same id must throw (partial was deleted).
    expect(() => collector.endQuery(q)).toThrow(/unknown query_id/);
    // recordToolCall on a finalized id likewise rejected.
    expect(() =>
      collector.recordToolCall(q, {
        tool: "x",
        input: {},
        output_summary: "",
        duration_ms: 0,
        timestamp: "2026-05-16T10:00:02Z",
      })
    ).toThrow(/unknown query_id/);
  });
});

describe("aggregateLocalSession", () => {
  const cmd = (over: Partial<LocalCommandEvent> & Pick<LocalCommandEvent, "command" | "timestamp">): LocalCommandEvent => ({
    source: "local",
    command_id: "c_20260516_001",
    args: [],
    duration_ms: 5,
    exit_code: 0,
    ...over,
  });

  it("groups events by session_id and sorts commands by timestamp within a group", () => {
    const evs: LocalCommandEvent[] = [
      cmd({ command: "search", timestamp: "2026-05-16T10:00:02Z", session_id: "S1" }),
      cmd({ command: "expand", timestamp: "2026-05-16T10:00:01Z", session_id: "S1" }),
      cmd({ command: "search", timestamp: "2026-05-16T11:00:00Z", session_id: "S2" }),
    ];
    const sessions = aggregateLocalSession(evs);
    const s2 = sessions.find((s) => s.session_id === "S2")!;
    const s1 = sessions.find((s) => s.session_id === "S1")!;
    expect(s1.command_count).toBe(2);
    expect(s1.commands.map((c) => c.command)).toEqual(["expand", "search"]);
    expect(s1.duration_ms).toBe(1000); // 1s between 10:00:01 and 10:00:02
    expect(s2.command_count).toBe(1);
    expect(s2.duration_ms).toBe(0);
  });

  it("treats events without session_id as one group keyed by ''", () => {
    const evs = [
      cmd({ command: "search", timestamp: "2026-05-16T10:00:00Z" }),
      cmd({ command: "parent", timestamp: "2026-05-16T10:00:01Z" }),
    ];
    const sessions = aggregateLocalSession(evs);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe("");
    expect(sessions[0]!.command_count).toBe(2);
  });

  it("groups explicit session_id: '' together with undefined under the '' sentinel", () => {
    const evs = [
      cmd({ command: "search", timestamp: "2026-05-16T10:00:00Z" }),                     // undefined
      cmd({ command: "expand", timestamp: "2026-05-16T10:00:01Z", session_id: "" }),    // explicit ""
      cmd({ command: "parent", timestamp: "2026-05-16T10:00:02Z", session_id: "S" }),   // named
    ];
    const sessions = aggregateLocalSession(evs);
    expect(sessions).toHaveLength(2);
    const sentinel = sessions.find((s) => s.session_id === "")!;
    expect(sentinel.command_count).toBe(2);
    expect(sentinel.commands.map((c) => c.command)).toEqual(["search", "expand"]);
  });

  it("returns sessions newest-first by earliest command timestamp", () => {
    const evs: LocalCommandEvent[] = [
      cmd({ command: "search", timestamp: "2026-05-16T08:00:00Z", session_id: "OLD" }),
      cmd({ command: "search", timestamp: "2026-05-16T12:00:00Z", session_id: "NEW" }),
    ];
    const sessions = aggregateLocalSession(evs);
    expect(sessions.map((s) => s.session_id)).toEqual(["NEW", "OLD"]);
  });

  it("returns [] for no events", () => {
    expect(aggregateLocalSession([])).toEqual([]);
  });
});

describe("aggregateMetrics", () => {
  const baseTrace = (over: Partial<QueryTrace>): QueryTrace => ({
    source: "browser",
    query_id: "q_20260516_001",
    user_question: "Q",
    started_at: "2026-05-16T10:00:00Z",
    ended_at: "2026-05-16T10:00:02Z",
    tool_calls: [],
    api_rounds: [],
    ...over,
  });

  it("computes browser metrics across a fixture set", () => {
    const traces: QueryTrace[] = [
      baseTrace({
        query_id: "q_20260516_001",
        tool_calls: [
          { ordinal: 1, tool: "search", input: {}, output_summary: '[{"id":"x"}]', duration_ms: 5, timestamp: "2026-05-16T10:00:01Z" },
          { ordinal: 2, tool: "read_chunk", input: {}, output_summary: "...", duration_ms: 5, timestamp: "2026-05-16T10:00:01Z" },
        ],
        api_rounds: [{ ordinal: 1, input_tokens: 100, output_tokens: 30, duration_ms: 800 }],
        final_answer: "A",
      }),
      baseTrace({
        query_id: "q_20260516_002",
        started_at: "2026-05-16T10:00:00Z",
        ended_at: "2026-05-16T10:00:04Z",
        tool_calls: [
          { ordinal: 1, tool: "search", input: {}, output_summary: "[]", duration_ms: 5, timestamp: "2026-05-16T10:00:01Z" },
        ],
        api_rounds: [{ ordinal: 1, input_tokens: 80, output_tokens: 10, duration_ms: 700 }],
        // No final_answer (zero-result, no answer).
      }),
    ];
    // q_20260516_002's search returned no hits; the recorded gap carries its
    // query_id, and the trace × gap join is what counts it as zero-result.
    const gaps: GapEvent[] = [
      { source: "browser", gap_id: "gap_002_001", keyword: "absent", scope: null, timestamp: "2026-05-16T10:00:01Z", query_id: "q_20260516_002" },
    ];
    const m = aggregateMetrics(traces, [], gaps);
    expect(m.total_queries).toBe(2);
    expect(m.avg_steps_per_query).toBe((2 + 1) / 2);
    expect(m.avg_query_duration_ms).toBe((2000 + 4000) / 2);
    expect(m.total_tokens).toEqual({ input: 180, output: 40 });
    expect(m.tool_call_distribution).toEqual({ search: 2, read_chunk: 1 });
    expect(m.queries_with_zero_search_result).toBe(1);
    expect(m.queries_with_final_answer).toBe(1);
  });

  it("computes local-side metrics from a LocalCommandEvent stream", () => {
    const evs: LocalCommandEvent[] = [
      {
        source: "local",
        command_id: "c_20260516_001",
        session_id: "S",
        command: "search",
        args: ["foo"],
        duration_ms: 10,
        exit_code: 0,
        timestamp: "2026-05-16T10:00:00Z",
      },
      {
        source: "local",
        command_id: "c_20260516_002",
        session_id: "S",
        command: "parent",
        args: ["db/abc/01-02.md"],
        duration_ms: 5,
        exit_code: 0,
        timestamp: "2026-05-16T10:00:02Z",
      },
    ];
    const m = aggregateMetrics([], evs, []);
    expect(m.total_local_sessions).toBe(1);
    expect(m.avg_commands_per_local_session).toBe(2);
    expect(m.avg_local_session_duration_ms).toBe(2000);
    expect(m.local_command_distribution).toEqual({ search: 1, parent: 1 });
  });

  it("returns zeroed metrics for empty inputs", () => {
    const m = aggregateMetrics([], [], []);
    expect(m.total_queries).toBe(0);
    expect(m.avg_steps_per_query).toBe(0);
    expect(m.avg_query_duration_ms).toBe(0);
    expect(m.total_tokens).toEqual({ input: 0, output: 0 });
    expect(m.tool_call_distribution).toEqual({});
    expect(m.queries_with_zero_search_result).toBe(0);
    expect(m.queries_with_final_answer).toBe(0);
    expect(m.total_local_sessions).toBe(0);
    expect(m.avg_commands_per_local_session).toBe(0);
    expect(m.avg_local_session_duration_ms).toBe(0);
    expect(m.local_command_distribution).toEqual({});
  });

  it("does NOT count an error trace as having a final_answer", () => {
    const t = baseTrace({ final_answer: "partial", error: "boom" });
    expect(aggregateMetrics([t], [], []).queries_with_final_answer).toBe(0);
  });

  // queries_with_zero_search_result has two modes:
  //  - no gaps[]: string-sniff on output_summary === "[]" (back-compat)
  //  - with gaps[]: trace × gap join via query_id (catches KnownGapResponse too)
  it("when gaps[] provided, counts via trace × gap join (catches known_gap responses)", () => {
    const traces: QueryTrace[] = [
      baseTrace({
        query_id: "q_known_gap",
        tool_calls: [
          // KnownGapResponse shape — string-sniff would MISS this; the join catches it.
          {
            ordinal: 1,
            tool: "search",
            input: {},
            output_summary: '{"status":"known_gap","message":"…","gap_info":{},"recommendation":"…"}',
            duration_ms: 5,
            timestamp: "2026-05-16T10:00:01Z",
          },
        ],
      }),
      baseTrace({ query_id: "q_with_hits", tool_calls: [] }),
    ];
    const gaps: GapEvent[] = [
      { source: "browser", gap_id: "gap_x_001", keyword: "absent", scope: null, timestamp: "2026-05-16T10:00:01Z", query_id: "q_known_gap" },
    ];
    const m = aggregateMetrics(traces, [], gaps);
    expect(m.queries_with_zero_search_result).toBe(1);
  });

  it("with gaps[]: a trace whose query_id matches no gap is not counted", () => {
    const traces: QueryTrace[] = [baseTrace({ query_id: "q_no_match" })];
    const gaps: GapEvent[] = [
      { source: "browser", gap_id: "gap_x_001", keyword: "absent", scope: null, timestamp: "2026-05-16T10:00:01Z", query_id: "q_other" },
    ];
    expect(aggregateMetrics(traces, [], gaps).queries_with_zero_search_result).toBe(0);
  });

  it("with gaps[]: multiple gaps for one trace are counted once (de-duped by query_id)", () => {
    const traces: QueryTrace[] = [baseTrace({ query_id: "q_or" })];
    const gaps: GapEvent[] = [
      { source: "browser", gap_id: "gap_x_001", keyword: "alpha", scope: null, timestamp: "2026-05-16T10:00:01Z", query_id: "q_or" },
      { source: "browser", gap_id: "gap_x_002", keyword: "beta", scope: null, timestamp: "2026-05-16T10:00:01Z", query_id: "q_or" },
    ];
    expect(aggregateMetrics(traces, [], gaps).queries_with_zero_search_result).toBe(1);
  });

  // read_chunk pattern-usage diagnostic — quantifies whether the agent
  // uses read_chunk's `pattern` filter or falls back to full-body dumps.
  describe("read_chunk pattern-usage diagnostic", () => {
    const rc = (
      input: Record<string, unknown>,
      output_summary: string
    ): QueryTrace["tool_calls"][number] => ({
      ordinal: 1,
      tool: "read_chunk",
      input,
      output_summary,
      duration_ms: 1,
      timestamp: "2026-05-16T10:00:00Z",
    });

    it("rate is null when no read_chunk calls are present (avoid false 0%)", () => {
      const m = aggregateMetrics([baseTrace({ tool_calls: [] })], [], []);
      expect(m.read_chunk_pattern_usage_rate).toBeNull();
      expect(m.avg_read_chunk_output_chars).toEqual({ with_pattern: 0, without_pattern: 0 });
    });

    it("rate is 1 when every read_chunk carries a pattern; without_pattern avg = 0", () => {
      const traces: QueryTrace[] = [
        baseTrace({
          tool_calls: [
            rc({ id: "d/1", pattern: "foo" }, "matched line"),
            rc({ id: "d/2", pattern: "bar" }, "another match"),
          ],
        }),
      ];
      const m = aggregateMetrics(traces, [], []);
      expect(m.read_chunk_pattern_usage_rate).toBe(1);
      expect(m.avg_read_chunk_output_chars.with_pattern).toBe(("matched line".length + "another match".length) / 2);
      expect(m.avg_read_chunk_output_chars.without_pattern).toBe(0);
    });

    it("rate is 0 when no read_chunk carries a pattern; with_pattern avg = 0", () => {
      const traces: QueryTrace[] = [
        baseTrace({ tool_calls: [rc({ id: "d/1" }, "full body of chunk")] }),
      ];
      const m = aggregateMetrics(traces, [], []);
      expect(m.read_chunk_pattern_usage_rate).toBe(0);
      expect(m.avg_read_chunk_output_chars.with_pattern).toBe(0);
      expect(m.avg_read_chunk_output_chars.without_pattern).toBe("full body of chunk".length);
    });

    it("mixed: rate is the fraction, each group averages its own outputs", () => {
      const traces: QueryTrace[] = [
        baseTrace({
          tool_calls: [
            rc({ id: "d/1", pattern: "x" }, "short"),         // with, 5 chars
            rc({ id: "d/2" }, "this is much longer body"),    // without, 24 chars
            rc({ id: "d/3", pattern: "y" }, "another short"), // with, 13 chars
          ],
        }),
      ];
      const m = aggregateMetrics(traces, [], []);
      expect(m.read_chunk_pattern_usage_rate).toBe(2 / 3);
      expect(m.avg_read_chunk_output_chars.with_pattern).toBe((5 + 13) / 2);
      expect(m.avg_read_chunk_output_chars.without_pattern).toBe(24);
    });

    // The diagnostic exists to surface that without_pattern dumps are large.
    // If the metric is computed from output_summary (already truncated to 600),
    // the very signal it tracks is compressed away. ToolCallEvent carries the
    // raw pre-truncate length on output_chars; the aggregator prefers it.
    it("uses output_chars (raw length) over output_summary.length so truncation does not compress the signal", () => {
      const longBody = "x".repeat(5000);                 // a real full-body dump
      const truncated = longBody.slice(0, 600) + "\n… (truncated)";
      const traces: QueryTrace[] = [
        baseTrace({
          tool_calls: [
            // with_pattern: small grep window, both summary and raw agree
            { ...rc({ id: "d/1", pattern: "x" }, "short match"), output_chars: 11 },
            // without_pattern: summary is truncated, output_chars is the raw 5000
            { ...rc({ id: "d/2" }, truncated), output_chars: 5000 },
          ],
        }),
      ];
      const m = aggregateMetrics(traces, [], []);
      expect(m.avg_read_chunk_output_chars.with_pattern).toBe(11);
      expect(m.avg_read_chunk_output_chars.without_pattern).toBe(5000);
    });

    it("falls back to output_summary.length when output_chars is absent (legacy traces)", () => {
      // Persisted traces from before output_chars existed have only
      // output_summary. Aggregator must still produce a finite number.
      const traces: QueryTrace[] = [
        baseTrace({ tool_calls: [rc({ id: "d/1" }, "legacy body")] }),
      ];
      const m = aggregateMetrics(traces, [], []);
      expect(m.avg_read_chunk_output_chars.without_pattern).toBe("legacy body".length);
    });

    it("empty-string pattern counts as without_pattern (pattern is missing, not present-but-empty)", () => {
      // The contract: read_chunk treats falsy `pattern` as 'no pattern'. The
      // diagnostic mirrors that — a value of "" or 0 means the agent did not
      // engage the filter, which is the signal we want to surface.
      const traces: QueryTrace[] = [
        baseTrace({
          tool_calls: [
            rc({ id: "d/1", pattern: "" }, "x"),
            rc({ id: "d/2", pattern: "real" }, "y"),
          ],
        }),
      ];
      const m = aggregateMetrics(traces, [], []);
      expect(m.read_chunk_pattern_usage_rate).toBe(0.5);
    });
  });
});
