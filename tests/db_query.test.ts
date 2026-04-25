import { describe, it, expect, vi, beforeEach } from "vitest";
import { search, expand, siblings, parent, related, fetchChunk } from "../src/db_query.js";
import type { SearchIndex } from "../src/types.js";

// Minimal fixture index with two docs
const INDEX: SearchIndex = {
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
      // siblings of 01 should be other top-level chunks (no dash in chunk part)
      expect(id.split("/")[1]).not.toContain("-");
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
    expect(result).not.toContain("aaa00001/01"); // parent not included in level 1
  });

  it("level 2 returns chunk + siblings + parent", () => {
    const result = expand(INDEX, "aaa00001/01-01", 2);
    expect(result).toContain("aaa00001/01-01");
    expect(result).toContain("aaa00001/01-02");
    expect(result).toContain("aaa00001/01");
  });

  it("level 3 returns all chunks in the same doc", () => {
    const result = expand(INDEX, "aaa00001/01", 3);
    const docKeys = Object.keys(INDEX).filter((k) => k.startsWith("aaa00001/"));
    for (const key of docKeys) {
      expect(result).toContain(key);
    }
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
