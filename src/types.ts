export interface ChunkEntry {
  id: string;     // e.g. "01-02"
  docId: string;  // sha256(stem)[:8] hex
  content: string;
}

export type SearchIndex = Record<string, string>; // "<docId>/<chunkId>" → content

export interface DocMeta {
  originalFilename: string; // source file name as ingested
  title: string;            // human-readable document title
}

export type Manifest = Record<string, DocMeta>; // doc_id → metadata, from db/_manifest.json

export interface Breadcrumb {
  id: string;    // "<docId>/<chunkId>" of this ancestor (or the chunk itself)
  title: string; // heading title from _index
}

export interface SearchResult {
  id: string;       // "<docId>/<chunkId>"
  score: number;    // keyword occurrence count
  excerpt?: string; // first matching line (truncated)
  // Navigation metadata — all optional, backward compatible.
  // Absent for _index entries (the index is itself the map).
  doc_title?: string;             // human-readable doc title (added at tools layer)
  breadcrumb?: Breadcrumb[];      // root → self, heading titles along the path
  siblings?: string[];            // same-parent chunk ids, excluding self
  parent_summary?: string | null; // opaque parent characterization (currently the parent title; may widen). null = no parent, "" = title unresolved
}

// ── Gap Recording ──────────────────────────────────────────
// Single shared contract for both sinks (local jsonl / browser localStorage)
// and all three stages (recording / aggregation / known-gap check).

export interface GapEvent {
  // gap_id is unique only WITHIN a source; (source, gap_id) is globally
  // unique. The two sinks run independent per-day sequencers, so cross-source
  // merges must de-dup on the pair, not gap_id alone.
  source: "local" | "browser";
  gap_id: string;          // "gap_<yyyymmdd>_<seq3>" — per-source, de-identified
  keyword: string;         // raw query keyword (un-normalized)
  scope: string | null;    // scoped 8-hex doc_id, or null if unscoped
  timestamp: string;       // ISO 8601 UTC
  // Best-effort context — omitted when not cheaply available.
  user_question?: string;
  current_document?: string;
  navigation_path?: string[];
  query_id?: string;       // reserved link to future Query Audit Trail
  session_id?: string;     // ephemeral per-conversation id; groups a session for post-hoc analysis (not user-identifying, not read on the live query path)
}

export interface GapAggregate {
  topic: string;                 // normalized keyword
  occurrence_count: number;
  first_seen: string;            // ISO 8601
  last_seen: string;             // ISO 8601
  scopes: (string | null)[];     // de-duplicated scopes seen for this topic
}

export interface KnownGapResponse {
  status: "known_gap";           // discriminant; SearchResult[] has no `status`
  message: string;
  gap_info: { topic: string; occurrence_count: number; first_seen: string };
  recommendation: string;
}

// ── Query Audit Trail ──────────────────────────────────────────
// Browser path: per-query bounded transaction (QueryTrace).
// Local path:  per-command event stream (LocalCommandEvent) — query.sh has
// no agent-loop central point, so reconstructing query boundaries would
// require agent cooperation, violating the "script owns integrity" rule.
// Asymmetry is deliberate (T1 in spec-audit-trail.md).

export interface ToolCallEvent {
  ordinal: number;                 // 1-based, monotonic within a query
  tool: string;
  input: Record<string, unknown>;  // raw input, deterministic
  output_summary: string;          // truncated tool output (≤ 600 chars; shared truncate)
  duration_ms: number;             // wall-clock of processToolCall
  timestamp: string;               // ISO 8601 UTC, at tool-call return
}

export interface ApiRoundUsage {
  ordinal: number;                 // 1-based, monotonic within a query
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;             // round-trip of messages.create
}

export interface QueryTrace {
  source: "browser";               // browser-only; local goes through LocalCommandEvent
  query_id: string;                // "q_<yyyymmdd>_<seq3>" — per-source, de-identified
  session_id?: string;             // mirrors GapEvent.session_id for cross-stream join
  user_question: string;
  started_at: string;              // ISO 8601 UTC
  ended_at: string;                // ISO 8601 UTC
  tool_calls: ToolCallEvent[];
  api_rounds: ApiRoundUsage[];
  final_answer?: string;           // omitted if interrupted/errored
  error?: string;                  // error message if the loop threw
}

export interface LocalCommandEvent {
  source: "local";                 // local-only; browser goes through QueryTrace
  command_id: string;              // "c_<yyyymmdd>_<seq3>" — per-source, de-identified
  session_id?: string;             // from .session_id; groups commands into logical sessions
  command: string;                 // subcommand name (search/expand/siblings/parent/…)
  args: string[];                  // raw argv after the subcommand name
  duration_ms: number;
  exit_code: number;
  timestamp: string;               // ISO 8601 UTC, at subcommand return
  // No output field — local trace is skeletal, not content.
}

export interface TraceMetrics {
  // Browser-side
  total_queries: number;
  avg_steps_per_query: number;
  avg_query_duration_ms: number;
  total_tokens: { input: number; output: number };
  tool_call_distribution: Record<string, number>;
  queries_with_zero_search_result: number;     // via trace × gap join (MVP: string sniff)
  queries_with_final_answer: number;
  // Local-side
  total_local_sessions: number;
  avg_commands_per_local_session: number;
  avg_local_session_duration_ms: number;
  local_command_distribution: Record<string, number>;
}

export interface LocalSessionMetrics {
  session_id: string;              // "" sentinel for events without a session_id
  command_count: number;
  duration_ms: number;             // last - first command timestamp
  commands: LocalCommandEvent[];   // ordered by timestamp
  associated_gap_count?: number;   // optional cross-stream join (caller supplies GapEvent[])
}
