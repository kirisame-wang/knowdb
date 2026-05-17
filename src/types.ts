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
