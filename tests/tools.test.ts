import { describe, it, expect } from "vitest";
import { KNOWDB_TOOLS, processToolCall } from "../src/agent/tools.js";
import type { SearchIndex } from "../src/types.js";

const INDEX: SearchIndex = {
  "aaa00001/_index": "# aaa00001 Index\n- 00: intro\n- 01: BM25\n- 01-01: BM25 details",
  "aaa00001/00": "intro to BM25 ranking",
  "aaa00001/01": "BM25 is a retrieval function",
  "aaa00001/01-01": "BM25 details and parameters",
  "bbb00002/_index": "# bbb00002 Index\n- 01: BM25 in Elasticsearch",
  "bbb00002/01": "BM25 is also used in Elasticsearch retrieval",
};

const MANIFEST = {
  aaa00001: { originalFilename: "ir.md", title: "Information Retrieval" },
  bbb00002: { originalFilename: "es.md", title: "Elasticsearch" },
};

describe("KNOWDB_TOOLS contract", () => {
  it("exposes 9 tools", () => {
    expect(KNOWDB_TOOLS).toHaveLength(9);
  });

  it("keeps the original 7 tools and adds the 2 new ones", () => {
    const names = KNOWDB_TOOLS.map((t) => t.name);
    for (const n of [
      "get_instructions",
      "list_docs",
      "read_index",
      "search",
      "read_chunk",
      "read_chunks",
      "parent",
    ]) {
      expect(names).toContain(n);
    }
    expect(names).toContain("jump_to_ref");
    expect(names).toContain("reconstruct_document");
  });

  it("leaves the original tools' input_schema unchanged", () => {
    const search = KNOWDB_TOOLS.find((t) => t.name === "search")!;
    expect(Object.keys(search.input_schema.properties ?? {}).sort()).toEqual(
      ["case_sensitive", "index_only", "keyword", "scope"].sort()
    );
    const parent = KNOWDB_TOOLS.find((t) => t.name === "parent")!;
    expect(Object.keys(parent.input_schema.properties ?? {})).toEqual(["id"]);
  });
});

describe("processToolCall — doc_title enrichment", () => {
  it("search results carry doc_title from the manifest", async () => {
    const out = JSON.parse(await processToolCall("search", { keyword: "BM25" }, INDEX, MANIFEST));
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      const docId = r.id.split("/")[0];
      expect(r.doc_title).toBe(MANIFEST[docId as keyof typeof MANIFEST].title);
    }
  });

  it("search results still carry hierarchy metadata through the tools layer", async () => {
    const out = JSON.parse(
      await processToolCall("search", { keyword: "details", scope: "aaa00001" }, INDEX, MANIFEST)
    );
    const r = out.find((x: { id: string }) => x.id === "aaa00001/01-01");
    expect(r.breadcrumb).toEqual([
      { id: "aaa00001/01", title: "BM25" },
      { id: "aaa00001/01-01", title: "BM25 details" },
    ]);
    expect(r.parent_summary).toBe("BM25");
  });
});

describe("processToolCall — jump_to_ref", () => {
  it("returns cross-doc related chunks with doc_title and hierarchy", async () => {
    const out = JSON.parse(
      await processToolCall("jump_to_ref", { id: "aaa00001/01" }, INDEX, MANIFEST)
    );
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.id.startsWith("aaa00001/")).toBe(false); // excludes source doc
      expect(r.doc_title).toBeTruthy();
      expect(r.breadcrumb).toBeDefined();
    }
  });

  it("respects top_k", async () => {
    const out = JSON.parse(
      await processToolCall("jump_to_ref", { id: "aaa00001/01", top_k: 1 }, INDEX, MANIFEST)
    );
    expect(out.length).toBeLessThanOrEqual(1);
  });
});

describe("processToolCall — reconstruct_document", () => {
  it("returns full markdown with restored headings", async () => {
    const md = await processToolCall("reconstruct_document", { doc_id: "aaa00001" }, INDEX, MANIFEST);
    expect(md.startsWith("intro to BM25 ranking")).toBe(true);
    expect(md).toContain("# BM25");
    expect(md).toContain("## BM25 details");
    expect(md).not.toContain("/_index");
  });
});
