import type { SearchIndex, SearchResult } from "./types.js";

export async function load(url: string): Promise<SearchIndex> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load index: ${res.status}`);
  return res.json() as Promise<SearchIndex>;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchOpts {
  /** Treat keyword as a regex; case-insensitive by default (default: true) */
  caseInsensitive?: boolean;
  /** Only search _index entries (heading trees) — for document discovery */
  indexOnly?: boolean;
}

export function search(
  index: SearchIndex,
  keyword: string,
  scope?: string,
  opts?: SearchOpts
): SearchResult[] {
  const flags = opts?.caseInsensitive !== false ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(keyword, flags);
  } catch {
    re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }

  const results: SearchResult[] = [];
  for (const [id, content] of Object.entries(index)) {
    if (scope && !id.startsWith(`${scope}/`)) continue;

    const isIndexEntry = id.endsWith("/_index");
    // default: skip _index entries; indexOnly: skip non-_index entries
    if (opts?.indexOnly ? !isIndexEntry : isIndexEntry) continue;

    const lines = content.split("\n");
    let score = 0;
    let firstMatch = -1;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        score++;
        if (firstMatch === -1) firstMatch = i;
      }
    }
    if (score > 0) {
      const start = Math.max(0, firstMatch - 1);
      const end = Math.min(lines.length - 1, firstMatch + 2);
      const excerpt = lines.slice(start, end + 1)
        .map((l) => l.trim())
        .filter((l) => l)
        .join("\n")
        .slice(0, 300);
      results.push({ id, score, excerpt });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchChunk(id: string): Promise<string> {
  const res = await fetch(`db/${id}.md`);
  if (!res.ok) throw new Error(`fetchChunk failed: ${res.status}`);
  return res.text();
}

// ── Grep within a chunk ───────────────────────────────────────────────────────

export function grepChunk(content: string, pattern: string, contextLines = 2): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const lines = content.split("\n");
  const include = new Set<number>();
  lines.forEach((line, i) => {
    if (re.test(line)) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        include.add(j);
      }
    }
  });

  if (include.size === 0) return "(no matches)";

  const out: string[] = [];
  let prev = -2;
  for (const i of [...include].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push("---");
    out.push(lines[i]!);
    prev = i;
  }
  return out.join("\n");
}

// ── Expand ────────────────────────────────────────────────────────────────────

export function expand(index: SearchIndex, id: string, level: number): string[] {
  if (level === 0) return [id];

  const [docId] = splitId(id);
  const all = Object.keys(index).filter((k) => k.startsWith(`${docId}/`) && !k.endsWith("/_index"));

  if (level >= 3) return all;

  const set = new Set<string>([id]);
  for (const s of siblings(index, id)) set.add(s);
  if (level >= 2) {
    const p = parent(id);
    if (p) set.add(p);
  }
  return [...set];
}

/** Expand and return chunk content in one step — use instead of expand for agent tools */
export function expandWithContent(
  index: SearchIndex,
  id: string,
  level: number
): { id: string; content: string }[] {
  return expand(index, id, level).map((chunkId) => ({
    id: chunkId,
    content: index[chunkId] ?? "",
  }));
}

// ── Siblings / Parent ─────────────────────────────────────────────────────────

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
    if (otherChunk === "_index") return false;
    const otherParts = otherChunk.split("-");
    if (otherParts.length !== depth) return false;
    if (depth > 1) return otherChunk.startsWith(parentPrefix);
    return true;
  });
}

export function parent(id: string): string | null {
  const [docId, chunkId] = splitId(id);
  if (!chunkId) return null;
  const parts = chunkId.split("-");
  if (parts.length <= 1) return null;
  return `${docId}/${parts.slice(0, -1).join("-")}`;
}

// ── Related ───────────────────────────────────────────────────────────────────

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
    if (otherId.endsWith("/_index")) continue;
    const score = words.reduce((acc, w) => acc + countOccurrences(otherContent.toLowerCase(), w), 0);
    if (score > 0) scores.push({ id: otherId, score });
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, opts.topK);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length > 2);
}
