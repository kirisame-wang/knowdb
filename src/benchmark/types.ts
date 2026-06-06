// Benchmark domain types (spec-benchmark-baseline.md Type Contract).
// Data-layer (`src/types.ts`, frozen v0.1.6) is NOT modified — variant
// association rides a side-car table (B4), the same opaque-id join pattern
// as `GapEvent.query_id` ↔ `QueryTrace.query_id`.

// Side-car: query_id → (variant, thread, turn). Stored alongside the trace
// dump, never folded into QueryTrace. One row per turn (one turn = one trace).
export interface VariantAssignment {
  query_id: string;        // matches QueryTrace.query_id (one turn = one trace)
  variant: string;         // e.g. "A" | "B" | "baseline_grep_cat"
  problem_id: string;      // = thread id; shared across a thread's turns (B11)
  turn_index: number;      // 0-based position of this turn within the thread
  assigned_at: string;     // ISO 8601 UTC; harness inject point
}

// Multi-turn conversation thread (B11). Schema mirrors spec-benchmark-corpus.md;
// the type is owned here (harness side).
export interface BenchmarkProblem {
  id: string;                              // e.g. "t001"; = thread id
  domain: "mcp" | "langchain" | "knowdb_self" | "sparse" | `mtrag_${string}`;
  thread_type: "symmetric" | "structural" | "lexical_gap" | "sparse" | "mtrag";
  turns: BenchmarkTurn[];                  // ~3-4 turns per thread (corpus C3a)
  difficulty?: "easy" | "medium" | "hard"; // optional, for stratification
}

export interface BenchmarkTurn {
  turn_index: number;                      // 0-based
  question: string;
  is_followup: boolean;                    // co-ref / non-standalone → followup scoring
  turn_type: "symmetric" | "structural" | "lexical_gap";
  answerable: boolean;                     // false = correct answer is an explicit gap
  expected_doc_ids: string[];              // non-empty when answerable
  expected_chunk_ids?: string[];           // optional, finer-grained
  expected_answer_keypoints: string[];     // B1 rubric; unanswerable → "should report not-found"
  expected_classification: "within_doc" | "cross_doc";  // B3 reference
  rouge1_precision_vs_chunk?: number;      // lexical_gap turns; corpus C4 gate wants < 0.1
}

export interface HumanGrade {
  problem_id: string;                      // = thread id
  turn_index: number;                      // B11: grade per-turn
  query_id: string;
  variant: string;
  rubric_1_covers_keypoints: boolean;      // B1 rubric item 1
  rubric_2_citations_valid: boolean;       // B1 rubric item 2
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
  variants: string[];                      // e.g. ["A", "B", "baseline_grep_cat"]
  started_at: string;
  ended_at: string;
  reviewer: string;
}

// B11: one row per turn (one turn = one trace = one row).
export interface TurnResult {
  problem_id: string;                      // = thread id
  turn_index: number;
  query_id: string;
  variant: string;
  is_followup: boolean;                    // from BenchmarkTurn; co-ref aggregation
  turn_type: "symmetric" | "structural" | "lexical_gap";
  answerable: boolean;                     // ground truth; gap-correctness judgement
  success: boolean;                        // B1 rubric: both items PASS
  classification_actual: "within_doc" | "cross_doc";  // B3
  explicit_gap_reported: boolean;          // B2
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
  explicit_gap_rate: number;
  abstention_precision: number | null;     // of reported-gap turns, share truly unanswerable; null when none reported
  avg_decision_steps: number;
  avg_tokens: { input: number; output: number };
  read_chunk_pattern_usage_rate: number | null;  // from T15
  avg_read_chunk_output_chars: { with_pattern: number; without_pattern: number };  // T15 diagnostic pair: filtered-window vs full-dump char cost (empty group → 0)
  // B11 multi-turn metrics (three)
  followup_success_rate: number;           // success rate of is_followup turns (co-ref)
  turn_degradation_slope: number;          // mean per-thread per-turn decision_steps slope
  cumulative_passage_coverage: number;     // mean per-thread expected_chunk_ids union hit-rate
}

// Ablation per-axis contribution: full-config minus the axis-off variant.
export interface AxisDelta {
  variant: string;                          // axis-off variant, e.g. "no_structure"
  success_rate_delta: number;               // full − variant (positive = the axis helps)
  decision_steps_delta: number;             // variant − full (positive = removal costs steps)
  explicit_gap_rate_delta: number;          // full − variant
}

export interface BenchmarkReport {
  run: BenchmarkRun;
  results: TurnResult[];                    // flat list, all variants × all turns
  aggregates: VariantAggregate[];           // per-variant rollup
  deltas: {                                 // ablation: each axis delta = full − axis-off
    baseline_variant: string;               // baseline axis name (conventionally "full")
    per_axis: AxisDelta[];                  // one per non-baseline axis; "search net contribution" = the variant==="no_search" entry
    knowdb_vs_grep_cat_token_ratio?: {      // optional external comparison; undefined unless baseline_grep_cat ran
      input: number;                        // full / grep+cat
      output: number;
    };
  };
}
