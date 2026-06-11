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

// ── Rendering ────────────────────────────────────────────────────────────────
// Without ground truth the view shows only success-independent metrics (success-derived
// fields are noise; DISCLAIMER spells out which). With it, the pilot success view is added.

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
// A delta of two rates is in percentage points, not a raw fraction — keep it visually
// consistent with the % cells beside it and unambiguous against the step-count delta.
const signedPp = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}pp`;

// Column labels for the per-variant table, shared by the text and DOM renderers.
export const PER_VARIANT_COLUMNS = [
  "variant",
  "turns",
  "avg steps",
  "avg in-tok",
  "avg out-tok",
  "pattern-use (of reads)",
  "read chars (pattern/plain)",
  "gap-signal",
  "turns (within/cross)",
] as const;

// The injected baseline ("full") and cost-floor ("baseline_search_read") roles, shown
// as a label on the variant so deltas and the token ratio are readable without recall.
export type VariantRole = "baseline" | "floor";

export interface VariantRow {
  variant: string;
  role?: VariantRole;
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

// Steps/tokens over one outcome group (succeeded or failed turns). turns=0 → a group
// with no turns, rendered "—" so a fail-fast variant isn't mistaken for a cheap one.
export interface OutcomeStats {
  turns: number;
  avgSteps: number;
  avgIn: number;
  avgOut: number;
}

export interface SuccessRow {
  variant: string;
  role?: VariantRole;
  successRate: number;
  successPass: number; // succeeded turns; rendered as k/n so a 1/1 isn't read as a 7/7
  withinSuccess: number;
  withinPass: number;
  withinTurns: number; // within-doc turns; 0 → within✓ rendered "—" (no turns ≠ all failed)
  crossSuccess: number;
  crossPass: number;
  crossTurns: number;
  success: OutcomeStats;
  failure: OutcomeStats;
}

// Column labels for the pilot success table (rendered only under ground truth).
export const SUCCESS_COLUMNS = [
  "variant",
  "success",
  "within✓",
  "cross✓",
  "steps ✓/✗",
  "in-tok ✓/✗",
  "out-tok ✓/✗",
] as const;

export interface SuccessView {
  columns: readonly string[];
  rows: SuccessRow[];
}

// One axis's ablation contribution: what removing it costs in steps, and (under ground
// truth) what it buys in success. Both sign so that positive = the axis is doing work.
export interface AxisDeltaRow {
  variant: string; // the axis-off variant, e.g. "no_search"
  stepsDelta: number;
  successDelta?: number; // present only under ground truth
}

export interface ReportView {
  title: string;
  disclaimer: string;
  meta: string;
  perVariant: { columns: readonly string[]; rows: VariantRow[] };
  axisDeltas: AxisDeltaRow[]; // per-axis success (pp) + steps deltas, the ablation story in one table
  cost: {
    realized: { input: number; output: number; turns: number };
    ratio: { baseline: string; external: string; input: number; output: number } | null;
  };
  success?: SuccessView; // present only under ground truth (success is noise without it)
}

const DISCLAIMER =
  "No-ground-truth run: validates the ablation runtime end-to-end and reports the cost/behaviour story over the existing db/. " +
  "With no ground truth (no expected chunks declared), success-derived metrics — success rate, within/cross-doc success, recovery, " +
  "follow-up success, abstention precision, explicit-gap rate, cumulative passage coverage — are suppressed as noise. Not a corpus result.";

const PILOT_DISCLAIMER =
  "Pilot run with hand-filled ground truth over the dogfooding db/ — not a formal corpus (no designed taxonomy or vocabulary-mismatch probes), so read success rates as directional. " +
  "Success is judge-free reach: an answerable turn succeeds when it reads a sufficient chunk (any-of within each expected group); a gap turn, when it reports the gap. " +
  "Steps and tokens are split by outcome (✓ succeeded / ✗ failed) so a variant that fails fast isn't mistaken for a cheap one.";

// Ground truth is present when any answerable turn declares expected chunks. Without it,
// success-derived metrics are suppressed; with it, the success view is built.
function hasGroundTruth(problems?: BenchmarkProblem[]): boolean {
  return Boolean(
    problems?.some((p) =>
      p.turns.some(
        (t) => t.answerable && ((t.expected_chunk_groups?.length ?? 0) > 0 || (t.expected_chunk_ids?.length ?? 0) > 0),
      ),
    ),
  );
}

function outcomeStats(rs: TurnResult[]): OutcomeStats {
  const n = rs.length;
  const mean = (pick: (t: TurnResult) => number): number => (n === 0 ? 0 : rs.reduce((s, t) => s + pick(t), 0) / n);
  return { turns: n, avgSteps: mean((t) => t.decision_steps), avgIn: mean((t) => t.tokens.input), avgOut: mean((t) => t.tokens.output) };
}

// The baseline / cost-floor roles, read from the declared (echoed) delta roles.
function roleOf(deltas: BenchmarkReport["deltas"], variant: string): VariantRole | undefined {
  return variant === deltas.baseline_variant ? "baseline" : variant === deltas.external_variant ? "floor" : undefined;
}

function buildSuccessView(report: BenchmarkReport): SuccessView {
  const { aggregates, results, deltas } = report;
  const rows: SuccessRow[] = aggregates.map((a) => {
    const rs = results.filter((r) => r.variant === a.variant);
    const cc = classificationCounts(results, a.variant);
    const passIn = (cls: "within_doc" | "cross_doc"): number =>
      rs.filter((r) => r.classification_actual === cls && r.success).length;
    const role = roleOf(deltas, a.variant);
    return {
      variant: a.variant,
      ...(role ? { role } : {}),
      successRate: a.success_rate,
      successPass: rs.filter((r) => r.success).length,
      withinSuccess: a.within_doc_success_rate,
      withinPass: passIn("within_doc"),
      withinTurns: cc.within,
      crossSuccess: a.cross_doc_success_rate,
      crossPass: passIn("cross_doc"),
      crossTurns: cc.cross,
      success: outcomeStats(rs.filter((r) => r.success)),
      failure: outcomeStats(rs.filter((r) => !r.success)),
    };
  });
  return { columns: SUCCESS_COLUMNS, rows };
}

// Pure display model: the single source of truth for what the report shows. It applies
// the finite-ratio guard and realized totals; both renderers (text, DOM) consume it.
// Pass the run's problems to unlock the pilot success view when ground truth is present.
export function reportView(report: BenchmarkReport, problems?: BenchmarkProblem[]): ReportView {
  const { run, aggregates, deltas, results } = report;
  const groundTruth = hasGroundTruth(problems);

  const rows: VariantRow[] = aggregates.map((a) => {
    const cc = classificationCounts(results, a.variant);
    const role = roleOf(deltas, a.variant);
    return {
      variant: a.variant,
      ...(role ? { role } : {}),
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

  // Lead with model + sample size (small samples should be read as directional), then
  // provenance. uniformN is the per-variant turn count when every variant ran the same set.
  const turnCounts = aggregates.map((a) => a.turn_count);
  const uniformN = turnCounts.length > 0 && turnCounts.every((n) => n === turnCounts[0]) ? turnCounts[0] : null;
  const sample =
    uniformN !== null
      ? `${aggregates.length} variants × ${uniformN} turns (n=${uniformN}/variant)`
      : `${aggregates.length} variants · ${results.length} turns total`;

  return {
    title: `Benchmark run ${run.run_id} — ${groundTruth ? "pilot (hand-filled ground truth)" : "ground-truth-free metrics"}`,
    disclaimer: groundTruth ? PILOT_DISCLAIMER : DISCLAIMER,
    meta:
      `${run.model} · ${sample} · ${groundTruth ? "pilot" : "no ground truth"} · ` +
      `commit ${run.knowdb_commit_sha} · tools ${run.tool_set_version} · set ${run.problem_set_id} · ${run.started_at} → ${run.ended_at}`,
    perVariant: { columns: PER_VARIANT_COLUMNS, rows },
    axisDeltas: deltas.per_axis.map((d) => ({
      variant: d.variant,
      stepsDelta: d.decision_steps_delta,
      ...(groundTruth ? { successDelta: d.success_rate_delta } : {}),
    })),
    cost: {
      realized: {
        input: results.reduce((s, t) => s + t.tokens.input, 0),
        output: results.reduce((s, t) => s + t.tokens.output, 0),
        turns: results.length,
      },
      ratio,
    },
    ...(groundTruth ? { success: buildSuccessView(report) } : {}),
  };
}

// Variant cell with its baseline/floor role appended, so the two reference rows are
// identifiable in every table without remembering which is which.
const variantLabel = (variant: string, role?: VariantRole): string => (role ? `${variant} (${role})` : variant);

// One row's cells as display strings, in PER_VARIANT_COLUMNS order. Shared so the text
// and DOM renderers format numbers identically.
export function variantRowCells(r: VariantRow): string[] {
  return [
    variantLabel(r.variant, r.role),
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

// One success row's cells as display strings, in SUCCESS_COLUMNS order. An outcome
// group with no turns renders "—" (no average to show), not 0.
export function successRowCells(r: SuccessRow): string[] {
  const split = (pick: (o: OutcomeStats) => number, fmt: (n: number) => string): string =>
    `${r.success.turns ? fmt(pick(r.success)) : "—"}/${r.failure.turns ? fmt(pick(r.failure)) : "—"}`;
  const round = (n: number): string => String(Math.round(n));
  // Rates carry their k/n so a 100% over one turn doesn't read like a 100% over many.
  const rate = (p: number, n: number, frac: number): string => (n === 0 ? "—" : `${pct(frac)} (${p}/${n})`);
  const total = r.success.turns + r.failure.turns;
  return [
    variantLabel(r.variant, r.role),
    rate(r.successPass, total, r.successRate),
    rate(r.withinPass, r.withinTurns, r.withinSuccess),
    rate(r.crossPass, r.crossTurns, r.crossSuccess),
    split((o) => o.avgSteps, n2),
    split((o) => o.avgIn, round),
    split((o) => o.avgOut, round),
  ];
}

// Per-axis delta table, shared by both renderers. The success column is present only
// under ground truth; both deltas are signed so positive = the axis is doing useful work.
export const axisDeltaColumns = (withSuccess: boolean): readonly string[] =>
  withSuccess ? ["axis-off variant", "Δ success (pp)", "Δ avg steps"] : ["axis-off variant", "Δ avg steps"];

export function axisDeltaRowCells(d: AxisDeltaRow, withSuccess: boolean): string[] {
  return withSuccess ? [d.variant, signedPp(d.successDelta ?? 0), signed(d.stepsDelta)] : [d.variant, signed(d.stepsDelta)];
}

const AXIS_DELTA_NOTE = "Positive = the axis is doing useful work (removing it lowers success and/or costs more steps).";

// Markdown serialization of the view — used for the downloadable .md report.
export function renderReportText(report: BenchmarkReport, problems?: BenchmarkProblem[]): string {
  const v = reportView(report, problems);
  const lines: string[] = [`# ${v.title}`, "", `> ${v.disclaimer}`, "", v.meta, ""];

  lines.push("## Per-variant (cost + behavior)", "");
  lines.push(`| ${v.perVariant.columns.join(" | ")} |`);
  lines.push(`|${v.perVariant.columns.map(() => "---").join("|")}|`);
  for (const row of v.perVariant.rows) lines.push(`| ${variantRowCells(row).join(" | ")} |`);
  lines.push("");

  if (v.success) {
    lines.push("## Success (pilot — steps/tokens gated on reach)", "");
    lines.push(`| ${v.success.columns.join(" | ")} |`);
    lines.push(`|${v.success.columns.map(() => "---").join("|")}|`);
    for (const row of v.success.rows) lines.push(`| ${successRowCells(row).join(" | ")} |`);
    lines.push("");
  }

  const withSucc = v.success !== undefined;
  const adCols = axisDeltaColumns(withSucc);
  lines.push("## Per-axis ablation deltas", "", AXIS_DELTA_NOTE, "");
  lines.push(`| ${adCols.join(" | ")} |`);
  lines.push(`|${adCols.map((_, i) => (i === 0 ? "---" : "--:")).join("|")}|`);
  for (const d of v.axisDeltas) lines.push(`| ${axisDeltaRowCells(d, withSucc).join(" | ")} |`);
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
  return lines.join("\n");
}
