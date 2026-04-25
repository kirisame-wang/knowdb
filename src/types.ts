export interface ChunkEntry {
  id: string;     // e.g. "01-02"
  docId: string;  // sha256(stem)[:8] hex
  content: string;
}

export type SearchIndex = Record<string, string>; // "<docId>/<chunkId>" → content

export interface SearchResult {
  id: string;    // "<docId>/<chunkId>"
  score: number; // keyword occurrence count
}
