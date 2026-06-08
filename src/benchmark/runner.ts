import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import { runAgentTurn, type AgentLoopDeps, type MessagesClient } from "../agent/loop.js";
import { BrowserTraceCollector, type KeyValueStore } from "../traces.js";
import { BrowserGapSink } from "../gaps.js";
import type { SessionContext } from "../utils.js";
import type { Manifest, SearchIndex } from "../types.js";
import type { BenchmarkProblem } from "./types.js";
import { toolsFor, ablateResult } from "./ablation.js";
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
}

// Drive every (variant × thread × turn) through the agent loop with the variant's
// tool allowlist and result ablation applied, writing traces/gaps and the
// query_id → variant side-car to run-scoped sinks. A thread runs its turns in one
// shared chatHistory (co-ref preserved); each variant replays it from a fresh one.
export async function runBenchmark(cfg: BenchmarkRunnerConfig): Promise<void> {
  const traceSink = benchmarkTraceSink(cfg.store, cfg.runId);
  const gapSink = new BrowserGapSink(cfg.store, benchmarkGapKey(cfg.runId), cfg.session);
  const variantSink = new VariantSink(cfg.store, benchmarkVariantKey(cfg.runId));
  const now = cfg.now ?? (() => new Date());

  for (const variant of cfg.variants) {
    const tools = toolsFor(variant, cfg.tools);
    const ablation = (name: string, _input: Record<string, unknown>, result: string): string =>
      ablateResult(variant, name, result);

    for (const problem of cfg.problems) {
      const collector = new BrowserTraceCollector(cfg.session);
      const chatHistory: Anthropic.Messages.MessageParam[] = [];
      const turns = [...problem.turns].sort((a, b) => a.turn_index - b.turn_index);

      for (const t of turns) {
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
      }
    }
  }
}
