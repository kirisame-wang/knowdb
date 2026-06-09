import { BrowserTraceSink, type KeyValueStore } from "../traces.js";
import { parseJsonl, toJsonLine } from "../utils.js";
import type { VariantAssignment } from "./types.js";

// Run-scoped localStorage keys, separate from the dogfooding stream (knowdb-traces / knowdb-gaps).
export const benchmarkTraceKey = (runId: string): string => `knowdb-benchmark-traces-${runId}`;
export const benchmarkGapKey = (runId: string): string => `knowdb-benchmark-gaps-${runId}`;
export const benchmarkVariantKey = (runId: string): string => `knowdb-benchmark-variants-${runId}`;

// The benchmark trace sink is the browser sink on a run-scoped key.
export function benchmarkTraceSink(store: KeyValueStore, runId: string): BrowserTraceSink {
  return new BrowserTraceSink(store, benchmarkTraceKey(runId));
}

// Side-car: append-only JSONL of query_id → variant, joined to the trace dump by query_id.
export class VariantSink {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key: string,
  ) {}

  record(a: VariantAssignment): void {
    this.store.setItem(this.key, (this.store.getItem(this.key) ?? "") + toJsonLine(a) + "\n");
  }

  readAll(): VariantAssignment[] {
    return parseJsonl<VariantAssignment>(this.store.getItem(this.key) ?? "");
  }

  dump(): string {
    return this.store.getItem(this.key) ?? "";
  }
}
