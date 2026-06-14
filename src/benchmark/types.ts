// Benchmark domain types. The data-layer (`src/types.ts`) is NOT modified —
// variant association rides a side-car table, the same opaque-id join pattern
// as `GapEvent.query_id` ↔ `QueryTrace.query_id`.

// Side-car: query_id → (variant, thread, turn). Stored alongside the trace
// dump, never folded into QueryTrace. One row per turn (one turn = one trace).
export interface VariantAssignment {
  query_id: string;        // matches QueryTrace.query_id (one turn = one trace)
  variant: string;         // ablation axis, e.g. "full" | "no_structure" | "no_search" | "baseline_search_read"
  problem_id: string;      // = thread id; shared across a thread's turns
  turn_index: number;      // 0-based position of this turn within the thread
  assigned_at: string;     // ISO 8601 UTC; harness inject point
}

// Multi-turn conversation thread. The type is owned here (harness side).
export interface BenchmarkProblem {
  id: string;                              // e.g. "t001"; = thread id
  domain: string;                          // corpus-instance label; taxonomy owned by spec-benchmark-corpus.md
  thread_type: "symmetric" | "structural" | "lexical_gap" | "sparse" | "mtrag";
  turns: BenchmarkTurn[];                  // ~3-4 turns per thread
  difficulty?: "easy" | "medium" | "hard"; // for stratification
}

export interface BenchmarkTurn {
  turn_index: number;                      // 0-based
  question: string;
  is_followup: boolean;                    // co-ref / non-standalone → followup scoring
  turn_type: "symmetric" | "structural" | "lexical_gap";
  answerable: boolean;                     // false = correct answer is an explicit gap
  expected_doc_ids: string[];              // non-empty when answerable
  expected_chunk_ids?: string[];           // finer-grained; full answer-bearing set (coverage)
  expected_chunk_groups?: string[][];      // reach-success rule: read ≥1 from each group (any-of within a group, all groups required). Supersedes expected_chunk_ids for success when present.
  expected_answer_keypoints: string[];     // rubric keypoints; unanswerable → "should report not-found"
  expected_classification: "within_doc" | "cross_doc";  // ground-truth reference
  rouge1_precision_vs_chunk?: number;      // rouge-1 precision of question vs chunk; lexical_gap turns only
}

export interface HumanGrade {
  problem_id: string;                      // = thread id
  turn_index: number;                      // grade per-turn
  query_id: string;
  variant: string;
  rubric_1_covers_keypoints: boolean;
  rubric_2_citations_valid: boolean;
  notes?: string;
  reviewer: string;
  graded_at: string;
}

export interface BenchmarkRun {
  run_id: string;
  model: string;                           // e.g. "claude-opus-4-7"
  temperature: number;
  max_tokens: number;
  knowdb_commit_sha: string;
  tool_set_version: string;                // hash of KNOWDB_TOOLS
  problem_set_id: string;                  // e.g. "corpus-v1"
  variants: string[];                      // ablation axes, e.g. ["full","no_structure","no_search","baseline_search_read"]
  baseline_variant?: string;               // injected baseline role; declaring it requires that variant to have run (deltas intended). Omit for reach-rates-only runs.
  external_variant?: string;               // injected cost-floor role; declaring it requires that variant to have run (cost ratio intended)
  started_at: string;
  ended_at: string;
  reviewer: string;
}

// One row per turn (one turn = one trace = one row).
export interface TurnResult {
  problem_id: string;                      // = thread id
  turn_index: number;
  query_id: string;
  variant: string;
  is_followup: boolean;                    // from BenchmarkTurn; co-ref aggregation
  turn_type: "symmetric" | "structural" | "lexical_gap";
  answerable: boolean;                     // ground truth; gap-correctness judgement
  success: boolean;                        // reach oracle (answerable: read expected chunks; unanswerable: reported gap); a human grade overrides if present
  context_overflow: boolean;               // turn ended on a 400 "prompt is too long" — ran out of context budget, delivered no answer; always a failure (successOf overrides reach)
  overflow_after_reach: boolean;           // an overflow that had already read its expected chunks: the over-search failure (found it, but couldn't stop/deliver in budget) vs an overflow that never reached
  expected_classification: "within_doc" | "cross_doc";  // the question's designed type (a stable invariant); success-by-class partitions on this
  classification_actual: "within_doc" | "cross_doc";    // docs the agent actually read (1 vs >1) — a behavioural observation, varies with stochastic navigation
  explicit_gap_reported: boolean;          // agent terminally reported a coverage gap
  encountered_gap_signal: boolean;         // a search returned known_gap mid-turn (recovery denominator; ≠ terminal report)
  decision_steps: number;                  // from QueryTrace.tool_calls.length
  tokens: { input: number; output: number };
}

export interface VariantAggregate {
  variant: string;
  turn_count: number;
  thread_count: number;
  success_rate: number;                    // over all turns
  within_doc_success_rate: number;
  cross_doc_success_rate: number;
  context_overflow_count: number;          // failures that hit the context-budget wall (reach-miss is the other failure subtype)
  overflow_after_reach_count: number;      // of those overflows, how many had already reached (the over-search subtype)
  explicit_gap_rate: number;
  abstention_precision: number | null;     // of reported-gap turns, share truly unanswerable; null when none reported
  recovery_rate: number | null;            // of answerable turns that hit a gap signal, share that still succeeded; null when none qualify
  recovery_avg_decision_steps: number | null;  // paired step guard for recovery_rate; avg total steps over the same candidates (coarse retry-effort proxy)
  avg_decision_steps: number;
  avg_tokens: { input: number; output: number };
  read_chunk_pattern_usage_rate: number | null;  // fraction of read_chunk calls using the pattern filter; null if none
  avg_read_chunk_output_chars: { with_pattern: number; without_pattern: number };  // mean read_chunk chars by pattern use; empty group → 0
  // multi-turn metrics (three)
  followup_success_rate: number;           // success rate of is_followup turns (co-ref)
  turn_degradation_slope: number;          // mean per-thread per-turn decision_steps slope
  cumulative_passage_coverage: number;     // mean per-thread expected_chunk_ids union hit-rate
}

// Ablation per-axis contribution: the baseline minus the axis-off variant.
export interface AxisDelta {
  variant: string;                          // axis-off variant, e.g. "no_structure"
  success_rate_delta: number;               // baseline − variant (positive = the axis helps)
  decision_steps_delta: number;             // variant − baseline (positive = removal costs steps)
  explicit_gap_rate_delta: number;          // baseline − variant
}

export interface BenchmarkReport {
  run: BenchmarkRun;
  results: TurnResult[];                    // flat list, all variants × all turns
  aggregates: VariantAggregate[];           // per-variant rollup
  deltas: {                                 // ablation: each axis delta = baseline − axis-off
    baseline_variant?: string;              // echoed when declared; absent when the run is reach-rates-only (no deltas)
    external_variant?: string;              // echoed when declared
    per_axis: AxisDelta[];                  // one delta per axis variant (excludes the baseline and external roles)
    external_token_ratio?: {                // cost comparison; undefined unless the external variant both was declared and ran
      input: number;                        // baseline.input / external.input
      output: number;
    };
  };
}
