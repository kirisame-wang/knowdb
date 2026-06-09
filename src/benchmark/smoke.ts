// DOM-free helpers for the smoke run: a no-ground-truth pass over the existing db/
// that exercises the runtime end-to-end and reports the cost story. Without ground
// truth, success is meaningless (reachSuccess is false on empty expected_chunk_ids),
// so success-derived metrics are excluded — see renderSmokeReportText.

import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import type { KeyValueStore } from "../traces.js";
import { MODEL, MAX_OUTPUT_TOKENS } from "../constants.js";
import { benchmarkTraceSink, benchmarkGapKey, benchmarkVariantKey, VariantSink } from "./sink.js";
import { BrowserGapSink } from "../gaps.js";
import { computeReport } from "./compute-report.js";
import type { BenchmarkProblem, BenchmarkReport, BenchmarkRun, TurnResult } from "./types.js";

// The full ablation matrix the smoke run drives. `full` is the baseline; the
// cost floor `baseline_search_read` is the external role (token ratio source).
export const SMOKE_VARIANTS = [
  "full",
  "no_structure",
  "no_search",
  "no_jump",
  "no_gap",
  "no_retry_scaffold",
  "baseline_search_read",
] as const;

export const SMOKE_BASELINE_VARIANT = "full";
export const SMOKE_EXTERNAL_VARIANT = "baseline_search_read";

// ── Cost estimate (rough) ────────────────────────────────────────────────────
// Per-turn token assumptions for the pre-run preview only. A turn is multi-round,
// so these are deliberately rough — they convey magnitude, not a billing promise.
const EST_ROUNDS_PER_TURN = 6;
const EST_INPUT_TOKENS_PER_ROUND = 3500;
const EST_OUTPUT_TOKENS_PER_ROUND = 400;

export interface RunEstimate {
  variantCount: number;
  problemCount: number;
  turnCount: number; // turns in one variant pass (Σ problem.turns)
  units: number; // total agent turns driven = variantCount × turnCount
  estTokens: { input: number; output: number };
  estCostUsd: number;
}

export function estimateRun(problems: BenchmarkProblem[], variants: readonly string[]): RunEstimate {
  const turnCount = problems.reduce((s, p) => s + p.turns.length, 0);
  const units = variants.length * turnCount;
  const input = units * EST_ROUNDS_PER_TURN * EST_INPUT_TOKENS_PER_ROUND;
  const output = units * EST_ROUNDS_PER_TURN * EST_OUTPUT_TOKENS_PER_ROUND;
  const estCostUsd =
    (input / 1_000_000) * MODEL.pricing.inputPerMTok + (output / 1_000_000) * MODEL.pricing.outputPerMTok;
  return { variantCount: variants.length, problemCount: problems.length, turnCount, units, estTokens: { input, output }, estCostUsd };
}

// ── Reproducibility metadata ─────────────────────────────────────────────────

// Short deterministic fingerprint of the tool surface (FNV-1a over the tool JSON).
export function toolSetVersionHash(tools: Tool[]): string {
  const json = JSON.stringify(tools.map((t) => ({ name: t.name, schema: t.input_schema })));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface SmokeRunOptions {
  runId: string;
  knowdbCommitSha: string;
  tools: Tool[];
  problemSetId: string;
  startedAt: string;
  endedAt: string;
  reviewer: string;
  variants?: readonly string[];
}

export function buildSmokeRun(opts: SmokeRunOptions): BenchmarkRun {
  const variants = [...(opts.variants ?? SMOKE_VARIANTS)];
  return {
    run_id: opts.runId,
    model: MODEL.id,
    temperature: 1, // the agent loop does not set temperature → API default
    max_tokens: MAX_OUTPUT_TOKENS,
    knowdb_commit_sha: opts.knowdbCommitSha,
    tool_set_version: toolSetVersionHash(opts.tools),
    problem_set_id: opts.problemSetId,
    variants,
    baseline_variant: SMOKE_BASELINE_VARIANT,
    external_variant: SMOKE_EXTERNAL_VARIANT,
    started_at: opts.startedAt,
    ended_at: opts.endedAt,
    reviewer: opts.reviewer,
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

// Read the run-scoped sinks and synthesize the report. No human grades (smoke is
// grade-free); gapEvents are passed through but computeReport does not consume them.
export function collectSmokeReport(
  store: KeyValueStore,
  runId: string,
  problems: BenchmarkProblem[],
  run: BenchmarkRun,
): BenchmarkReport {
  const traces = benchmarkTraceSink(store, runId).readAll();
  const gapEvents = new BrowserGapSink(store, benchmarkGapKey(runId)).readAll();
  const assignments = new VariantSink(store, benchmarkVariantKey(runId)).readAll();
  return computeReport(traces, gapEvents, assignments, problems, [], run);
}

// ── Ground-truth-free rendering ──────────────────────────────────────────────
// Metrics that do NOT depend on `success`. Success-derived fields (success_rate,
// within/cross success, recovery_*, followup_success_rate, abstention_precision,
// explicit_gap_rate, cumulative_passage_coverage, and the success_rate / explicit_gap
// deltas) are intentionally omitted: with no ground truth they are noise.
export const GROUND_TRUTH_FREE = [
  "avg_decision_steps",
  "avg_tokens",
  "read_chunk_pattern_usage_rate",
  "avg_read_chunk_output_chars",
  "turn_degradation_slope",
  "encountered_gap_signal_rate",
  "classification_counts",
  "external_token_ratio",
  "decision_steps_delta",
] as const;

function gapSignalRate(results: TurnResult[], variant: string): number {
  const rs = results.filter((r) => r.variant === variant);
  return rs.length === 0 ? 0 : rs.filter((r) => r.encountered_gap_signal).length / rs.length;
}

function classificationCounts(results: TurnResult[], variant: string): { within: number; cross: number } {
  const rs = results.filter((r) => r.variant === variant);
  return {
    within: rs.filter((r) => r.classification_actual === "within_doc").length,
    cross: rs.filter((r) => r.classification_actual === "cross_doc").length,
  };
}

const n2 = (x: number): string => x.toFixed(2);
const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);

// Markdown summary listing only ground-truth-free metrics, with a disclaimer.
export function renderSmokeReportText(report: BenchmarkReport): string {
  const { run, aggregates, deltas, results } = report;
  const lines: string[] = [];

  lines.push(`# Smoke run ${run.run_id} — ground-truth-free metrics`);
  lines.push("");
  lines.push(
    "> Layer-1 smoke run: validates the ablation runtime end-to-end and reports the cost/behavior story over the existing db/. " +
      "**No ground truth** (`expected_chunk_ids` is empty), so success-derived metrics — success rate, within/cross-doc success, recovery, " +
      "follow-up success, abstention precision, explicit-gap rate, cumulative passage coverage — are suppressed as noise. Not a corpus result.",
  );
  lines.push("");
  lines.push(
    `model: \`${run.model}\` · commit: \`${run.knowdb_commit_sha}\` · tools: \`${run.tool_set_version}\` · ` +
      `problem set: \`${run.problem_set_id}\` · ${run.started_at} → ${run.ended_at}`,
  );
  lines.push("");

  lines.push("## Per-variant (cost + behavior)");
  lines.push("");
  lines.push("| variant | turns | avg steps | avg in-tok | avg out-tok | pattern-use | read-chunk chars (pat/no-pat) | gap-signal | within/cross (count) |");
  lines.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const a of aggregates) {
    const cc = classificationCounts(results, a.variant);
    const rc = a.avg_read_chunk_output_chars;
    lines.push(
      `| \`${a.variant}\` | ${a.turn_count} | ${n2(a.avg_decision_steps)} | ${Math.round(a.avg_tokens.input)} | ` +
        `${Math.round(a.avg_tokens.output)} | ${pct(a.read_chunk_pattern_usage_rate)} | ` +
        `${Math.round(rc.with_pattern)}/${Math.round(rc.without_pattern)} | ${pct(gapSignalRate(results, a.variant))} | ` +
        `${cc.within}/${cc.cross} |`,
    );
  }
  lines.push("");

  lines.push("## Cost story");
  lines.push("");
  // Realized usage across every recorded turn — the actual cost, to reconcile
  // against the rough pre-run consent estimate.
  const totalIn = results.reduce((s, r) => s + r.tokens.input, 0);
  const totalOut = results.reduce((s, r) => s + r.tokens.output, 0);
  lines.push(`**Realized usage**: ${totalIn} in / ${totalOut} out tokens over ${results.length} turns.`);
  lines.push("");
  const ratio = deltas.external_token_ratio;
  // A partial / aborted run can leave the floor variant with zero turns, making the
  // ratio Infinity/NaN (mean of no tokens = 0 → divide-by-zero). Only render a real one.
  if (ratio && Number.isFinite(ratio.input) && Number.isFinite(ratio.output)) {
    lines.push(
      `**Token ratio** \`${deltas.baseline_variant}\` vs \`${deltas.external_variant}\` (floor): ` +
        `input ×${n2(ratio.input)}, output ×${n2(ratio.output)} (>1 = full config costs more than the flat search+read floor).`,
    );
  } else {
    lines.push("_No token ratio: the cost-floor variant produced no turns (partial or aborted run)._");
  }
  lines.push("");
  lines.push("**Per-axis decision-steps delta** (axis-off minus baseline; positive = removing the axis costs more steps):");
  lines.push("");
  lines.push("| axis-off variant | Δ avg steps |");
  lines.push("|---|--:|");
  for (const d of deltas.per_axis) {
    lines.push(`| \`${d.variant}\` | ${d.decision_steps_delta >= 0 ? "+" : ""}${n2(d.decision_steps_delta)} |`);
  }
  lines.push("");
  return lines.join("\n");
}
