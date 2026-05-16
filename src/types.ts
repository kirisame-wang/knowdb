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

// ── Gap Recording (Layer 1 工具閉環) ──────────────────────────────────────────
// Single shared contract for both sinks (local jsonl / browser localStorage)
// and all three stages (recording / aggregation / known-gap check).

export interface GapEvent {
  // gap_id is unique only WITHIN a source; (source, gap_id) is globally
  // unique. The two sinks run independent per-day sequencers, so cross-source
  // merges (G2) must de-dup on the pair, not gap_id alone.
  source: "local" | "browser";
  gap_id: string;          // "gap_<yyyymmdd>_<seq3>" — per-source, de-identified
  keyword: string;         // raw query keyword (un-normalized)
  scope: string | null;    // scoped 8-hex doc_id, or null if unscoped
  timestamp: string;       // ISO 8601 UTC
  // Best-effort context (G5) — omitted when not cheaply available.
  user_question?: string;
  current_document?: string;
  navigation_path?: string[];
  query_id?: string;       // reserved link to future Query Audit Trail (G6)
}

export interface GapAggregate {
  topic: string;                 // normalized keyword (G7 rule)
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
