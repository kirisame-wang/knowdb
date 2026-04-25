import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  search,
  expand,
  expandWithContent,
  siblings,
  parent,
  related,
  fetchChunk,
  grepChunk,
} from "../src/db_query.js";
import type { SearchIndex } from "../src/types.js";

const INDEX: SearchIndex = {
  // _index entries (heading trees)
  "aaa00001/_index": "# aaa00001 Index\n- 00: introduction\n- 01: BM25\n- 01-01: BM25 formula details\n- 01-02: BM25 implementation notes\n- 02: TF-IDF comparison\n- 02-01: TF-IDF formula",
  "bbb00002/_index": "# bbb00002 Index\n- 00: welcome\n- 01: BM25 in Elasticsearch\n- 01-01: Elasticsearch configuration",
  // content chunks
  "aaa00001/00": "introduction to BM25 ranking algorithm",
  "aaa00001/01": "BM25 is a bag-of-words retrieval function used in information retrieval",
  "aaa00001/01-01": "BM25 formula details and parameters",
  "aaa00001/01-02": "BM25 implementation notes",
  "aaa00001/02": "TF-IDF comparison with BM25",
  "aaa00001/02-01": "TF-IDF formula",
  "bbb00002/00": "welcome to the knowledge base",
  "bbb00002/01": "BM25 is also used in Elasticsearch",
  "bbb00002/01-01": "Elasticsearch configuration",
};

describe("search", () => {
  it("returns results sorted by score descending", () => {
    const results = search(INDEX, "BM25");
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("returns SearchResults with id and score", () => {
    const results = search(INDEX, "BM25");
    for (const r of results) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("score");
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("returns empty array when no match", () => {
    expect(search(INDEX, "nonexistent_xyz")).toEqual([]);
  });

  it("filters by scope to a single doc", () => {
    const results = search(INDEX, "BM25", "bbb00002");
    for (const r of results) {
      expect(r.id.startsWith("bbb00002/")).toBe(true);
    }
  });

  it("returns only chunks containing the keyword", () => {
    const results = search(INDEX, "TF-IDF");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("aaa00001/02");
    expect(ids).toContain("aaa00001/02-01");
    expect(ids).not.toContain("aaa00001/01");
  });

  it("skips _index entries by default", () => {
    const results = search(INDEX, "BM25");
    for (const r of results) {
      expect(r.id).not.toMatch(/\/_index$/);
    }
  });

  it("indexOnly returns only _index entries", () => {
    const results = search(INDEX, "BM25", undefined, { indexOnly: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.id).toMatch(/\/_index$/);
    }
  });

  it("supports regex patterns", () => {
    const results = search(INDEX, "BM25|TF-IDF");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("aaa00001/01");
    expect(ids).toContain("aaa00001/02");
  });

  it("is case-insensitive by default", () => {
    const lower = search(INDEX, "bm25");
    const upper = search(INDEX, "BM25");
    expect(lower.map((r) => r.id).sort()).toEqual(upper.map((r) => r.id).sort());
  });

  it("respects case_sensitive option", () => {
    const sensitive = search(INDEX, "bm25", undefined, { caseInsensitive: false });
    expect(sensitive).toHaveLength(0);
  });

  it("includes a non-empty excerpt for each result", () => {
    const results = search(INDEX, "BM25");
    for (const r of results) {
      expect(r.excerpt).toBeTruthy();
    }
  });
});

describe("parent", () => {
  it("returns parent id for a nested chunk", () => {
    expect(parent("aaa00001/01-02")).toBe("aaa00001/01");
    expect(parent("aaa00001/01-02-03")).toBe("aaa00001/01-02");
  });

  it("returns null for top-level chunk (single segment id)", () => {
    expect(parent("aaa00001/01")).toBeNull();
    expect(parent("aaa00001/00")).toBeNull();
  });
});

describe("siblings", () => {
  it("returns other chunks with same parent, excluding self", () => {
    const result = siblings(INDEX, "aaa00001/01-01");
    expect(result).toContain("aaa00001/01-02");
    expect(result).not.toContain("aaa00001/01-01");
  });

  it("does not include deeper-nested chunks", () => {
    const result = siblings(INDEX, "aaa00001/01");
    for (const id of result) {
      expect(id.split("/")[1]).not.toContain("-");
    }
  });

  it("does not include _index entries", () => {
    const result = siblings(INDEX, "aaa00001/00");
    for (const id of result) {
      expect(id).not.toMatch(/\/_index$/);
    }
  });

  it("returns empty array for a chunk with no siblings", () => {
    const result = siblings(INDEX, "aaa00001/02-01");
    expect(result).toEqual([]);
  });
});

describe("expand", () => {
  it("level 0 returns only the chunk itself", () => {
    expect(expand(INDEX, "aaa00001/01", 0)).toEqual(["aaa00001/01"]);
  });

  it("level 1 returns chunk + siblings", () => {
    const result = expand(INDEX, "aaa00001/01-01", 1);
    expect(result).toContain("aaa00001/01-01");
    expect(result).toContain("aaa00001/01-02");
    expect(result).not.toContain("aaa00001/01");
  });

  it("level 2 returns chunk + siblings + parent", () => {
    const result = expand(INDEX, "aaa00001/01-01", 2);
    expect(result).toContain("aaa00001/01-01");
    expect(result).toContain("aaa00001/01-02");
    expect(result).toContain("aaa00001/01");
  });

  it("level 3 returns all content chunks in the same doc (no _index)", () => {
    const result = expand(INDEX, "aaa00001/01", 3);
    const docKeys = Object.keys(INDEX).filter(
      (k) => k.startsWith("aaa00001/") && !k.endsWith("/_index")
    );
    for (const key of docKeys) {
      expect(result).toContain(key);
    }
    for (const id of result) {
      expect(id).not.toMatch(/\/_index$/);
    }
  });
});

describe("expandWithContent", () => {
  it("returns objects with id and content", () => {
    const result = expandWithContent(INDEX, "aaa00001/01-01", 1);
    for (const item of result) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("content");
      expect(typeof item.content).toBe("string");
    }
  });

  it("includes the queried chunk and its siblings", () => {
    const result = expandWithContent(INDEX, "aaa00001/01-01", 1);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("aaa00001/01-01");
    expect(ids).toContain("aaa00001/01-02");
  });

  it("content matches the index for each id", () => {
    const result = expandWithContent(INDEX, "aaa00001/01-01", 1);
    for (const item of result) {
      expect(item.content).toBe(INDEX[item.id] ?? "");
    }
  });
});

describe("grepChunk", () => {
  const chunk = `line one about apples
line two about bananas
line three about apples and oranges
line four about grapes
line five about apples`;

  it("returns matching lines with context", () => {
    const result = grepChunk(chunk, "apples", 1);
    expect(result).toContain("line one about apples");
    expect(result).toContain("line two about bananas"); // context after line 1
    expect(result).toContain("line five about apples");
  });

  it("returns (no matches) when pattern has no match", () => {
    expect(grepChunk(chunk, "mango")).toBe("(no matches)");
  });

  it("is case-insensitive", () => {
    const result = grepChunk(chunk, "APPLES");
    expect(result).toContain("line one about apples");
  });

  it("uses --- separator between non-adjacent match groups", () => {
    const result = grepChunk(chunk, "apples", 0);
    expect(result).toContain("---");
  });

  it("supports regex patterns", () => {
    const result = grepChunk(chunk, "apple|grape");
    expect(result).toContain("apples");
    expect(result).toContain("grapes");
  });
});

describe("related", () => {
  it("excludes chunks from the same doc", () => {
    const results = related(INDEX, "aaa00001/01", { topK: 3 });
    for (const r of results) {
      expect(r.id.startsWith("aaa00001/")).toBe(false);
    }
  });

  it("returns at most topK results", () => {
    const results = related(INDEX, "aaa00001/01", { topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns results sorted by score descending", () => {
    const results = related(INDEX, "aaa00001/01", { topK: 5 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});

describe("fetchChunk", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches the correct URL and returns text", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "chunk content here",
    });
    vi.stubGlobal("fetch", mockFetch);

    const content = await fetchChunk("aaa00001/01-02");
    expect(content).toBe("chunk content here");
    expect(mockFetch).toHaveBeenCalledWith("db/aaa00001/01-02.md");
  });

  it("throws when fetch returns non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchChunk("aaa00001/99")).rejects.toThrow("404");
  });
});
