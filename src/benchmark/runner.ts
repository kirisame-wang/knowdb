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
  /** Per-turn error callback — a failed turn is recorded but not re-thrown, so this
   *  is the only way a caller learns a turn errored (e.g. a bad API key). */
  onError?: (err: unknown, label: string) => void;
  /** Max (variant × problem) threads in flight. Defaults to 1 (sequential). */
  concurrency?: number;
}

// Each (variant × problem) is one thread: its turns stay sequential (co-ref), while
// independent threads run through a bounded pool (concurrency 1 = sequential).
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

  // Units in declared (variant, problem) order, so concurrency 1 drains deterministically.
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
      // Stop at a turn boundary, so the thread is left on a complete trace.
      if (cfg.signal?.aborted) return;
      const label = `${variant} · ${problem.id}#${t.turn_index}`;
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
        ...(cfg.onError ? { hooks: { onError: (err: unknown) => cfg.onError!(err, label) } } : {}),
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
      // ++done is atomic between awaits, so the count stays exact under concurrency.
      cfg.onProgress?.(++done, total, label);
    }
  };

  // Bounded worker pool. Sink writes are a single synchronous getItem→setItem, so
  // parallel threads cannot interleave a write.
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
