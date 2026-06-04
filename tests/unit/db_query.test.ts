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
  reconstructDocument,
  compareChunkIds,
} from "../../src/db_query.js";
import type { SearchIndex } from "../../src/types.js";

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

describe("search hierarchy enrichment", () => {
  const find = (kw: string, id: string, scope?: string) =>
    search(INDEX, kw, scope).find((r) => r.id === id)!;

  it("breadcrumb runs root → self with titles from _index", () => {
    const r = find("implementation", "aaa00001/01-02", "aaa00001");
    expect(r.breadcrumb).toEqual([
      { id: "aaa00001/01", title: "BM25" },
      { id: "aaa00001/01-02", title: "BM25 implementation notes" },
    ]);
  });

  it("breadcrumb is a single entry for a top-level chunk", () => {
    const r = find("bag-of-words", "aaa00001/01", "aaa00001");
    expect(r.breadcrumb).toEqual([{ id: "aaa00001/01", title: "BM25" }]);
  });

  // Pins current behavior: parent_summary == parent title today; will change if the field widens.
  it("parent_summary currently resolves to the parent heading title", () => {
    const r = find("implementation", "aaa00001/01-02", "aaa00001");
    expect(r.parent_summary).toBe("BM25");
  });

  it("parent_summary is null for a top-level chunk", () => {
    const r = find("bag-of-words", "aaa00001/01", "aaa00001");
    expect(r.parent_summary).toBeNull();
  });

  it("uses '' (not null) when a parent exists but its title is absent from _index", () => {
    const idx: SearchIndex = {
      // 01 (the parent) deliberately omitted from the heading tree
      "fff00006/_index": "# fff00006 Index\n- 01-01: Orphan Child",
      "fff00006/01-01": "orphan child body about zebra",
    };
    const r = search(idx, "zebra", "fff00006").find((x) => x.id === "fff00006/01-01")!;
    expect(r.breadcrumb).toEqual([
      { id: "fff00006/01", title: "" },
      { id: "fff00006/01-01", title: "Orphan Child" },
    ]);
    expect(r.parent_summary).toBe("");
  });

  it("siblings matches the standalone siblings() helper", () => {
    const r = find("implementation", "aaa00001/01-02", "aaa00001");
    expect(r.siblings).toEqual(siblings(INDEX, "aaa00001/01-02"));
    expect(r.siblings).toContain("aaa00001/01-01");
  });

  it("does not enrich _index results in indexOnly mode", () => {
    const results = search(INDEX, "BM25", undefined, { indexOnly: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.breadcrumb).toBeUndefined();
      expect(r.siblings).toBeUndefined();
      expect(r.parent_summary).toBeUndefined();
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

  it("enriches cross-doc results with hierarchy metadata", () => {
    const results = related(INDEX, "aaa00001/01", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.breadcrumb).toBeDefined();
      expect(r.breadcrumb![0]!.id).toBe(`${r.id.split("/")[0]}/${r.id.split("/")[1]!.split("-")[0]}`);
      expect(r.siblings).toBeDefined();
    }
  });
});

describe("reconstructDocument", () => {
  it("emits the preamble (chunk 00) with no heading line", () => {
    const md = reconstructDocument(INDEX, "aaa00001");
    expect(md.startsWith("introduction to BM25 ranking algorithm")).toBe(true);
  });

  it("derives heading depth from id segments (01 → H1, 01-01 → H2)", () => {
    const md = reconstructDocument(INDEX, "aaa00001");
    expect(md).toContain("# BM25");
    expect(md).toContain("## BM25 formula details");
    expect(md).toContain("# TF-IDF comparison");
    expect(md).toContain("## TF-IDF formula");
  });

  it("keeps document order (parent heading before its children)", () => {
    const md = reconstructDocument(INDEX, "aaa00001");
    expect(md.indexOf("# BM25")).toBeLessThan(md.indexOf("## BM25 formula details"));
    expect(md.indexOf("## BM25 formula details")).toBeLessThan(md.indexOf("# TF-IDF comparison"));
  });

  it("does not leak _index header lines", () => {
    const md = reconstructDocument(INDEX, "aaa00001");
    expect(md).not.toContain("aaa00001 Index");
    expect(md).not.toContain("/_index");
  });

  it("emits a heading-only line for a section with no body chunk", () => {
    const idx: SearchIndex = {
      "ccc00003/_index": "# ccc00003 Index\n- 01: Parent Only\n- 01-01: Child With Body",
      "ccc00003/01-01": "the child body text",
    };
    const md = reconstructDocument(idx, "ccc00003");
    expect(md).toContain("# Parent Only");
    expect(md).toContain("## Child With Body");
    expect(md).toContain("the child body text");
    // "Parent Only" heading present but has no following body block
    expect(md.indexOf("# Parent Only")).toBeLessThan(md.indexOf("## Child With Body"));
  });

  it("orders sections by chunk id even when _index lines are out of order", () => {
    const idx: SearchIndex = {
      "eee00005/_index": "# eee00005 Index\n- 02: Beta\n- 01: Alpha\n- 01-01: Gamma",
      "eee00005/01": "alpha body",
      "eee00005/01-01": "gamma body",
      "eee00005/02": "beta body",
    };
    const md = reconstructDocument(idx, "eee00005");
    expect(md.indexOf("Alpha")).toBeLessThan(md.indexOf("Gamma"));
    expect(md.indexOf("Gamma")).toBeLessThan(md.indexOf("Beta"));
    expect(md).toContain("# Alpha");
    expect(md).toContain("## Gamma");
  });

  it("falls back to chunk concatenation when _index is absent", () => {
    const idx: SearchIndex = {
      "ddd00004/00": "preamble text",
      "ddd00004/01": "first section body",
      "ddd00004/02": "second section body",
    };
    const md = reconstructDocument(idx, "ddd00004");
    expect(md).toContain("preamble text");
    expect(md).toContain("first section body");
    expect(md).toContain("second section body");
    expect(md).not.toContain("#");
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

  it("does not retry a 4xx and names re-location tools (deterministic miss)", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", f);
    await expect(
      fetchChunk("aaa00001/99", { maxAttempts: 3, delayMs: () => 0 })
    ).rejects.toThrow(/read_index/);
    expect(f).toHaveBeenCalledTimes(1); // 4xx is deterministic — no retry
  });

  it("retries a 5xx transient failure and then succeeds", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, text: async () => "recovered" });
    vi.stubGlobal("fetch", f);
    const out = await fetchChunk("aaa00001/01", { maxAttempts: 3, delayMs: () => 0 });
    expect(out).toBe("recovered");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("surfaces a transient error after exhausting retries on persistent 5xx", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", f);
    await expect(
      fetchChunk("aaa00001/01", { maxAttempts: 3, delayMs: () => 0 })
    ).rejects.toThrow(/after 3 attempts/i);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("retries network rejections and then surfaces a transient error", async () => {
    const f = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", f);
    await expect(
      fetchChunk("aaa00001/01", { maxAttempts: 2, delayMs: () => 0 })
    ).rejects.toThrow(/try again shortly/i);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("compareChunkIds", () => {
  it("sorts _index first, then lexical (== hierarchical, zero-padded ids)", () => {
    const ids = ["aaa/02", "aaa/00", "aaa/_index", "aaa/01-01", "aaa/01"];
    expect([...ids].sort(compareChunkIds)).toEqual([
      "aaa/_index",
      "aaa/00",
      "aaa/01",
      "aaa/01-01",
      "aaa/02",
    ]);
  });

  it("returns 0 for equal ids", () => {
    expect(compareChunkIds("aaa/01", "aaa/01")).toBe(0);
  });
});
