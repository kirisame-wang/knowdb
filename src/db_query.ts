import type { SearchIndex, SearchResult } from "./types.js";

export async function load(url: string): Promise<SearchIndex> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load index: ${res.status}`);
  return res.json() as Promise<SearchIndex>;
}

export function search(index: SearchIndex, keyword: string, scope?: string): SearchResult[] {
  const kw = keyword.toLowerCase();
  const results: SearchResult[] = [];
  for (const [id, content] of Object.entries(index)) {
    if (scope && !id.startsWith(`${scope}/`)) continue;
    const score = countOccurrences(content.toLowerCase(), kw);
    if (score > 0) results.push({ id, score });
  }
  return results.sort((a, b) => b.score - a.score);
}

export async function fetchChunk(id: string): Promise<string> {
  const res = await fetch(`db/${id}.md`);
  if (!res.ok) throw new Error(`fetchChunk failed: ${res.status}`);
  return res.text();
}

export function expand(index: SearchIndex, id: string, level: number): string[] {
  if (level === 0) return [id];

  const [docId, chunkId] = splitId(id);
  const all = Object.keys(index).filter((k) => k.startsWith(`${docId}/`));

  if (level === 3) return all;

  const set = new Set<string>([id]);

  // level 1+: add siblings
  for (const s of siblings(index, id)) set.add(s);

  // level 2+: add parent
  if (level >= 2) {
    const p = parent(id);
    if (p) set.add(p);
  }

  return [...set];
}

export function siblings(index: SearchIndex, id: string): string[] {
  const [docId, chunkId] = splitId(id);
  if (!chunkId) return [];

  const parts = chunkId.split("-");
  const parentPrefix = parts.length > 1 ? parts.slice(0, -1).join("-") + "-" : "";
  const depth = parts.length;

  return Object.keys(index).filter((k) => {
    if (!k.startsWith(`${docId}/`)) return false;
    if (k === id) return false;
    const otherChunk = k.slice(docId.length + 1);
    const otherParts = otherChunk.split("-");
    if (otherParts.length !== depth) return false;
    if (depth > 1) {
      return otherChunk.startsWith(parentPrefix);
    }
    return true; // top-level siblings: any single-segment id
  });
}

export function parent(id: string): string | null {
  const [docId, chunkId] = splitId(id);
  if (!chunkId) return null;
  const parts = chunkId.split("-");
  if (parts.length <= 1) return null;
  const parentChunk = parts.slice(0, -1).join("-");
  return `${docId}/${parentChunk}`;
}

export function related(
  index: SearchIndex,
  id: string,
  opts: { topK: number }
): SearchResult[] {
  const [docId] = splitId(id);
  const content = index[id] ?? "";
  const words = tokenize(content);
  if (words.length === 0) return [];

  const scores: SearchResult[] = [];
  for (const [otherId, otherContent] of Object.entries(index)) {
    if (otherId.startsWith(`${docId}/`)) continue;
    const score = words.reduce((acc, w) => acc + countOccurrences(otherContent.toLowerCase(), w), 0);
    if (score > 0) scores.push({ id: otherId, score });
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, opts.topK);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitId(id: string): [string, string] {
  const slash = id.indexOf("/");
  return [id.slice(0, slash), id.slice(slash + 1)];
}

function countOccurrences(text: string, keyword: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(keyword, pos)) !== -1) {
    count++;
    pos += keyword.length;
  }
  return count;
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (w) => w.length > 2
  );
}
