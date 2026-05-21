import { describe, it, expect } from "vitest";
import {
  BrowserTraceCollector,
  BrowserTraceSink,
  aggregateLocalSession,
  aggregateMetrics,
  makeCommandId,
  makeQueryId,
  type TraceCollectorEvent,
} from "../src/traces.js";
import { makeGapId, SessionContext } from "../src/gaps.js";
import type { LocalCommandEvent, QueryTrace } from "../src/types.js";

class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

describe("makeQueryId / makeCommandId", () => {
  const date = new Date("2026-05-16T12:00:00Z");

  it("formats q_<yyyymmdd>_<seq3> with zero-padded seq", () => {
    expect(makeQueryId(date, 1)).toBe("q_20260516_001");
    expect(makeQueryId(date, 123)).toBe("q_20260516_123");
  });

  it("formats c_<yyyymmdd>_<seq3> with zero-padded seq", () => {
    expect(makeCommandId(date, 7)).toBe("c_20260516_007");
  });

  it("q and c id namespaces are visibly distinct (no prefix collision)", () => {
    expect(makeQueryId(date, 1).startsWith("q_")).toBe(true);
    expect(makeCommandId(date, 1).startsWith("c_")).toBe(true);
  });

  // Spec T2: per-source daily seq each monotonic and independent. Three
  // namespaces (gap / q / c) can simultaneously hold seq=1 on the same day
  // without collision — the prefix carries the namespace, the seq does not.
  it("gap / q / c ids on the same day at seq=1 are all distinct (no namespace collision)", () => {
    const day = new Date("2026-05-16T12:00:00Z");
    const ids = new Set([makeGapId(day, 1), makeQueryId(day, 1), makeCommandId(day, 1)]);
    expect(ids.size).toBe(3);
    expect([...ids]).toEqual(
      expect.arrayContaining(["gap_20260516_001", "q_20260516_001", "c_20260516_001"])
    );
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

  it("startQuery → recordToolCall/recordApiRound → endQuery produces a complete QueryTrace", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    const t0 = new Date("2026-05-16T10:00:00Z");
    const t1 = new Date("2026-05-16T10:00:03Z");

    const q = collector.startQuery("how to back up?", t0);
    expect(q).toMatch(/^q_20260516_\d{3}$/);

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

  it("query_id daily seq is monotonic across multiple startQuery calls", () => {
    const collector = new BrowserTraceCollector(new SessionContext(SID));
    const t = new Date("2026-05-16T10:00:00Z");
    const q1 = collector.startQuery("Q1", t);
    const q2 = collector.startQuery("Q2", t);
    const q3 = collector.startQuery("Q3", t);
    expect([q1, q2, q3]).toEqual([
      "q_20260516_001",
      "q_20260516_002",
      "q_20260516_003",
    ]);
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

  it("seeds the daily seq from persisted traces in the sink", () => {
    const sink = new BrowserTraceSink(new FakeKV());
    // Pre-populate with two same-day traces.
    sink.flush({
      source: "browser",
      query_id: "q_20260516_001",
      user_question: "x",
      started_at: "2026-05-16T08:00:00Z",
      ended_at: "2026-05-16T08:00:01Z",
      tool_calls: [],
      api_rounds: [],
    });
    sink.flush({
      source: "browser",
      query_id: "q_20260516_002",
      user_question: "y",
      started_at: "2026-05-16T09:00:00Z",
      ended_at: "2026-05-16T09:00:01Z",
      tool_calls: [],
      api_rounds: [],
    });
    const collector = new BrowserTraceCollector(new SessionContext(SID), sink);
    const q = collector.startQuery("Q", new Date("2026-05-16T10:00:00Z"));
    expect(q).toBe("q_20260516_003");
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
    const m = aggregateMetrics(traces, []);
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
    const m = aggregateMetrics([], evs);
    expect(m.total_local_sessions).toBe(1);
    expect(m.avg_commands_per_local_session).toBe(2);
    expect(m.avg_local_session_duration_ms).toBe(2000);
    expect(m.local_command_distribution).toEqual({ search: 1, parent: 1 });
  });

  it("returns zeroed metrics for empty inputs", () => {
    const m = aggregateMetrics([], []);
    expect(m.total_queries).toBe(0);
    expect(m.avg_steps_per_query).toBe(0);
    expect(m.avg_query_duration_ms).toBe(0);
    expect(m.total_tokens).toEqual({ input: 0, output: 0 });
    expect(m.total_local_sessions).toBe(0);
    expect(m.avg_commands_per_local_session).toBe(0);
  });

  it("does NOT count an error trace as having a final_answer", () => {
    const t = baseTrace({ final_answer: "partial", error: "boom" });
    expect(aggregateMetrics([t], []).queries_with_final_answer).toBe(0);
  });
});
