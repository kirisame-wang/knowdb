// DOM-free helpers for a benchmark run: cost estimate, run metadata, report assembly,
// and the display view + markdown serialization.

import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import type { KeyValueStore } from "../traces.js";
import { MODEL, MAX_OUTPUT_TOKENS } from "../constants.js";
import { benchmarkTraceSink, benchmarkGapKey, benchmarkVariantKey, VariantSink } from "./sink.js";
import { BrowserGapSink } from "../gaps.js";
import { computeReport } from "./compute-report.js";
import type { BenchmarkProblem, BenchmarkReport, BenchmarkRun, TurnResult } from "./types.js";

// The full ablation matrix a run drives. `full` is the baseline; the
// cost floor `baseline_search_read` is the external role (token ratio source).
export const BENCHMARK_VARIANTS = [
  "full",
  "no_structure",
  "no_search",
  "no_jump",
  "no_gap",
  "no_retry_scaffold",
  "baseline_search_read",
] as const;

export const BASELINE_VARIANT = "full";
export const EXTERNAL_VARIANT = "baseline_search_read";

// ── Cost estimate (rough) ────────────────────────────────────────────────────
// Rough per-turn token estimate for the pre-run preview, sized to err high. A turn is
// multi-round so input accumulates across rounds and dominates cost; these are
// calibrated to sit a little above observed runs — magnitude, not a billing promise.
const EST_INPUT_TOKENS_PER_TURN = 28000;
const EST_OUTPUT_TOKENS_PER_TURN = 1000;

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
  const input = units * EST_INPUT_TOKENS_PER_TURN;
  const output = units * EST_OUTPUT_TOKENS_PER_TURN;
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

export interface RunOptions {
  runId: string;
  knowdbCommitSha: string;
  tools: Tool[];
  problemSetId: string;
  startedAt: string;
  endedAt: string;
  reviewer: string;
  variants?: readonly string[];
}

export function buildRun(opts: RunOptions): BenchmarkRun {
  const variants = [...(opts.variants ?? BENCHMARK_VARIANTS)];
  return {
    run_id: opts.runId,
    model: MODEL.id,
    temperature: 1, // the agent loop does not set temperature → API default
    max_tokens: MAX_OUTPUT_TOKENS,
    knowdb_commit_sha: opts.knowdbCommitSha,
    tool_set_version: toolSetVersionHash(opts.tools),
    problem_set_id: opts.problemSetId,
    variants,
    baseline_variant: BASELINE_VARIANT,
    external_variant: EXTERNAL_VARIANT,
    started_at: opts.startedAt,
    ended_at: opts.endedAt,
    reviewer: opts.reviewer,
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

// Read the run-scoped sinks and synthesize the report. No human grades (this run is
// grade-free); gapEvents are passed through but computeReport does not consume them.
export function collectReport(
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
// The view selects only success-independent metrics; success-derived fields are noise
// without ground truth and are left out (DISCLAIMER spells out which).

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
const signed = (x: number): string => `${x >= 0 ? "+" : ""}${n2(x)}`;

// Column labels for the per-variant table, shared by the text and DOM renderers.
export const PER_VARIANT_COLUMNS = [
  "variant",
  "turns",
  "avg steps",
  "avg in-tok",
  "avg out-tok",
  "pattern-use",
  "read-chunk chars (pat/no-pat)",
  "gap-signal",
  "within/cross (count)",
] as const;

export interface VariantRow {
  variant: string;
  turns: number;
  avgSteps: number;
  avgIn: number;
  avgOut: number;
  patternUse: number | null;
  readChunkChars: { withPattern: number; withoutPattern: number };
  gapSignal: number;
  within: number;
  cross: number;
}

export interface ReportView {
  title: string;
  disclaimer: string;
  meta: string;
  perVariant: { columns: readonly string[]; rows: VariantRow[] };
  cost: {
    realized: { input: number; output: number; turns: number };
    ratio: { baseline: string; external: string; input: number; output: number } | null;
    perAxis: { variant: string; stepsDelta: number }[];
  };
}

const DISCLAIMER =
  "No-ground-truth run: validates the ablation runtime end-to-end and reports the cost/behaviour story over the existing db/. " +
  "With no ground truth (expected_chunk_ids empty), success-derived metrics — success rate, within/cross-doc success, recovery, " +
  "follow-up success, abstention precision, explicit-gap rate, cumulative passage coverage — are suppressed as noise. Not a corpus result.";

// Pure display model: the single source of truth for what the report shows. It applies
// the finite-ratio guard and realized totals; both renderers (text, DOM) consume it.
export function reportView(report: BenchmarkReport): ReportView {
  const { run, aggregates, deltas, results } = report;

  const rows: VariantRow[] = aggregates.map((a) => {
    const cc = classificationCounts(results, a.variant);
    return {
      variant: a.variant,
      turns: a.turn_count,
      avgSteps: a.avg_decision_steps,
      avgIn: a.avg_tokens.input,
      avgOut: a.avg_tokens.output,
      patternUse: a.read_chunk_pattern_usage_rate,
      readChunkChars: {
        withPattern: a.avg_read_chunk_output_chars.with_pattern,
        withoutPattern: a.avg_read_chunk_output_chars.without_pattern,
      },
      gapSignal: gapSignalRate(results, a.variant),
      within: cc.within,
      cross: cc.cross,
    };
  });

  // A partial / aborted run can leave the floor variant with zero turns, making the
  // ratio Infinity/NaN (mean of no tokens = 0 → divide-by-zero). Drop it to null then.
  const r = deltas.external_token_ratio;
  const ratio =
    r && Number.isFinite(r.input) && Number.isFinite(r.output)
      ? { baseline: deltas.baseline_variant ?? "", external: deltas.external_variant ?? "", input: r.input, output: r.output }
      : null;

  return {
    title: `Benchmark run ${run.run_id} — ground-truth-free metrics`,
    disclaimer: DISCLAIMER,
    meta:
      `model: ${run.model} · commit: ${run.knowdb_commit_sha} · tools: ${run.tool_set_version} · ` +
      `problem set: ${run.problem_set_id} · ${run.started_at} → ${run.ended_at}`,
    perVariant: { columns: PER_VARIANT_COLUMNS, rows },
    cost: {
      realized: {
        input: results.reduce((s, t) => s + t.tokens.input, 0),
        output: results.reduce((s, t) => s + t.tokens.output, 0),
        turns: results.length,
      },
      ratio,
      perAxis: deltas.per_axis.map((d) => ({ variant: d.variant, stepsDelta: d.decision_steps_delta })),
    },
  };
}

// One row's cells as display strings, in PER_VARIANT_COLUMNS order. Shared so the text
// and DOM renderers format numbers identically.
export function variantRowCells(r: VariantRow): string[] {
  return [
    r.variant,
    String(r.turns),
    n2(r.avgSteps),
    String(Math.round(r.avgIn)),
    String(Math.round(r.avgOut)),
    pct(r.patternUse),
    `${Math.round(r.readChunkChars.withPattern)}/${Math.round(r.readChunkChars.withoutPattern)}`,
    pct(r.gapSignal),
    `${r.within}/${r.cross}`,
  ];
}

// Markdown serialization of the view — used for the downloadable .md report.
export function renderReportText(report: BenchmarkReport): string {
  const v = reportView(report);
  const lines: string[] = [`# ${v.title}`, "", `> ${v.disclaimer}`, "", v.meta, ""];

  lines.push("## Per-variant (cost + behavior)", "");
  lines.push(`| ${v.perVariant.columns.join(" | ")} |`);
  lines.push(`|${v.perVariant.columns.map(() => "---").join("|")}|`);
  for (const row of v.perVariant.rows) lines.push(`| ${variantRowCells(row).join(" | ")} |`);
  lines.push("");

  lines.push("## Cost story", "");
  lines.push(
    `**Realized usage (all variants)**: ${v.cost.realized.input} in / ${v.cost.realized.output} out tokens over ${v.cost.realized.turns} turns.`,
    "",
  );
  if (v.cost.ratio) {
    lines.push(
      `**Token ratio** ${v.cost.ratio.baseline} vs ${v.cost.ratio.external} (floor): ` +
        `input ×${n2(v.cost.ratio.input)}, output ×${n2(v.cost.ratio.output)} (>1 = full config costs more than the flat search+read floor).`,
    );
  } else {
    lines.push("_No token ratio: the cost-floor variant produced no turns (partial or aborted run)._");
  }
  lines.push("");
  lines.push("**Per-axis decision-steps delta** (axis-off minus baseline; positive = removing the axis costs more steps):", "");
  lines.push("| axis-off variant | Δ avg steps |", "|---|--:|");
  for (const d of v.cost.perAxis) lines.push(`| ${d.variant} | ${signed(d.stepsDelta)} |`);
  lines.push("");
  return lines.join("\n");
}
