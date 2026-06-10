import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import { runAgentTurn, type AgentLoopDeps, type MessagesClient } from "../agent/loop.js";
import { BrowserTraceCollector, type KeyValueStore } from "../traces.js";
import { BrowserGapSink } from "../gaps.js";
import type { SessionContext } from "../utils.js";
import type { Manifest, SearchIndex } from "../types.js";
import type { BenchmarkProblem } from "./types.js";
import { toolsFor, ablateResult, ABLATION_VARIANTS } from "./ablation.js";
import { benchmarkTraceSink, benchmarkGapKey, benchmarkVariantKey, VariantSink } from "./sink.js";

export interface BenchmarkRunnerConfig {
  client: MessagesClient;
  store: KeyValueStore;
  session: SessionContext;
  searchIndex: SearchIndex;
  manifest: Manifest;
  model: string;
  system: string;
  maxTokens: number;
  tools: Tool[];
  problems: BenchmarkProblem[];
  variants: string[];
  runId: string;
  now?: () => Date;
  /** User cancel (Stop): threaded into each turn and checked at turn boundaries. */
  signal?: AbortSignal;
  /** Progress callback fired after each turn settles (label = "variant · problem#turn"). */
  onProgress?: (done: number, total: number, label: string) => void;
  /** Max (variant × problem) threads in flight. Defaults to 1 (sequential). */
  concurrency?: number;
}

// Drive every (variant × problem × turn) through the agent loop with the variant's
// tool allowlist and result ablation applied; traces, gaps and the query_id → variant
// side-car go to run-scoped sinks. The unit of work is one (variant × problem) thread,
// whose turns share a chatHistory and stay sequential (co-ref); units run through a
// bounded pool. concurrency 1 drains units in declared order, like a sequential loop.
export async function runBenchmark(cfg: BenchmarkRunnerConfig): Promise<void> {
  // Fail loud on an unknown variant before any side effects.
  for (const v of cfg.variants) {
    if (!ABLATION_VARIANTS.has(v)) throw new Error(`Unknown ablation variant: ${v}`);
  }

  const traceSink = benchmarkTraceSink(cfg.store, cfg.runId);
  const gapSink = new BrowserGapSink(cfg.store, benchmarkGapKey(cfg.runId), cfg.session);
  const variantSink = new VariantSink(cfg.store, benchmarkVariantKey(cfg.runId));
  const now = cfg.now ?? (() => new Date());
  const total = cfg.variants.length * cfg.problems.reduce((s, p) => s + p.turns.length, 0);
  let done = 0;

  // Units in declared order (variant outer, problem inner): with concurrency 1 a
  // single worker drains them in this order, matching the previous sequential loop.
  const units: { variant: string; problem: BenchmarkProblem }[] = [];
  for (const variant of cfg.variants) {
    for (const problem of cfg.problems) units.push({ variant, problem });
  }

  const runUnit = async (variant: string, problem: BenchmarkProblem): Promise<void> => {
    const tools = toolsFor(variant, cfg.tools);
    const ablation = (name: string, result: string): string => ablateResult(variant, name, result);
    const collector = new BrowserTraceCollector(cfg.session);
    const chatHistory: Anthropic.Messages.MessageParam[] = [];
    const turns = [...problem.turns].sort((a, b) => a.turn_index - b.turn_index);

    for (const t of turns) {
      // Stop at a turn boundary: the in-flight turn (if any) already settled and
      // its history is complete, so we leave the thread on a clean trace.
      if (cfg.signal?.aborted) return;
      const deps: AgentLoopDeps = {
        client: cfg.client,
        collector,
        traceSink,
        gapSink,
        searchIndex: cfg.searchIndex,
        manifest: cfg.manifest,
        model: cfg.model,
        system: cfg.system,
        tools,
        maxTokens: cfg.maxTokens,
        chatHistory,
        ablation,
        now,
        ...(cfg.signal ? { signal: cfg.signal } : {}),
      };
      const trace = await runAgentTurn(deps, t.question);
      if (trace) {
        variantSink.record({
          query_id: trace.query_id,
          variant,
          problem_id: problem.id,
          turn_index: t.turn_index,
          assigned_at: now().toISOString(),
        });
      }
      // ++done is atomic between awaits (single-threaded), so the count stays exact
      // even when several units report concurrently.
      cfg.onProgress?.(++done, total, `${variant} · ${problem.id}#${t.turn_index}`);
    }
  };

  // Bounded worker pool: each worker pulls the next unit until the queue drains or
  // a cancel lands. Sink writes are single synchronous getItem→setItem, so parallel
  // threads cannot interleave a write.
  const concurrency = Math.max(1, cfg.concurrency ?? 1);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (cfg.signal?.aborted) return;
      const i = next++;
      if (i >= units.length) return;
      const u = units[i]!;
      await runUnit(u.variant, u.problem);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, () => worker()));
}
