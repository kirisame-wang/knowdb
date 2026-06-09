import { describe, it, expect } from "vitest";
import {
  benchmarkTraceKey,
  benchmarkGapKey,
  benchmarkVariantKey,
  benchmarkTraceSink,
  VariantSink,
} from "../../../src/benchmark/sink.js";
import { parseJsonl } from "../../../src/utils.js";
import type { VariantAssignment } from "../../../src/benchmark/types.js";
import type { QueryTrace } from "../../../src/types.js";

class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const trace = (query_id: string): QueryTrace => ({
  source: "browser",
  query_id,
  user_question: "Q",
  started_at: "2026-06-03T00:00:00Z",
  ended_at: "2026-06-03T00:00:01Z",
  tool_calls: [],
  api_rounds: [],
  final_answer: "a",
});

const assign = (query_id: string, variant: string, turn_index = 0): VariantAssignment => ({
  query_id,
  variant,
  problem_id: "t001",
  turn_index,
  assigned_at: "2026-06-03T00:00:00Z",
});

describe("benchmark sink keys — run-scoped, distinct from dogfooding", () => {
  it("derives three distinct run-scoped keys, none equal to the dogfooding keys", () => {
    const keys = [benchmarkTraceKey("r1"), benchmarkGapKey("r1"), benchmarkVariantKey("r1")];
    for (const k of keys) {
      expect(k.startsWith("knowdb-benchmark-")).toBe(true); // benchmark namespace
      expect(k).toContain("r1"); // run-scoped
    }
    expect(new Set(keys).size).toBe(3); // traces / gaps / variants never collide
    expect(keys).not.toContain("knowdb-traces"); // never the dogfooding stream
    expect(keys).not.toContain("knowdb-gaps");
  });

  it("scopes keys by run id so two runs never collide", () => {
    expect(benchmarkTraceKey("r1")).not.toBe(benchmarkTraceKey("r2"));
  });
});

describe("benchmarkTraceSink — writes to the run-scoped key only", () => {
  it("flushes into knowdb-benchmark-traces-<run>, leaving knowdb-traces empty", () => {
    const kv = new FakeKV();
    const sink = benchmarkTraceSink(kv, "r1");
    sink.flush(trace("q1"));

    expect(kv.getItem("knowdb-traces")).toBeNull(); // dogfooding stream untouched
    expect(sink.readAll().map((t) => t.query_id)).toEqual(["q1"]);
    expect(kv.getItem(benchmarkTraceKey("r1"))).toContain("q1");
  });
});

describe("VariantSink — append-only side-car of query_id → variant", () => {
  it("records and reads back assignments in order", () => {
    const kv = new FakeKV();
    const sink = new VariantSink(kv, benchmarkVariantKey("r1"));
    sink.record(assign("q1", "full"));
    sink.record(assign("q2", "no_search", 1));

    const all = sink.readAll();
    expect(all.map((a) => [a.query_id, a.variant, a.turn_index])).toEqual([
      ["q1", "full", 0],
      ["q2", "no_search", 1],
    ]);
  });

  it("appends (never overwrites) and dumps raw JSONL", () => {
    const kv = new FakeKV();
    const sink = new VariantSink(kv, benchmarkVariantKey("r1"));
    sink.record(assign("q1", "full"));
    sink.record(assign("q2", "full"));

    expect(sink.dump().trimEnd().split("\n")).toHaveLength(2);
    expect(parseJsonl<VariantAssignment>(sink.dump())).toHaveLength(2);
  });

  it("writes to the variant key, not the trace key", () => {
    const kv = new FakeKV();
    new VariantSink(kv, benchmarkVariantKey("r1")).record(assign("q1", "full"));
    expect(kv.getItem(benchmarkTraceKey("r1"))).toBeNull();
    expect(kv.getItem(benchmarkVariantKey("r1"))).toContain("q1");
  });
});
