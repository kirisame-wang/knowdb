import { describe, it, expect, vi } from "vitest";
import { KNOWDB_TOOLS, processToolCall } from "../../src/agent/tools.js";
import { type GapSink } from "../../src/gaps.js";
import type { SearchIndex, GapEvent } from "../../src/types.js";

class MemSink implements GapSink {
  events: GapEvent[] = [];
  record(e: GapEvent) {
    this.events.push(e);
  }
  readAll() {
    return [...this.events]; // snapshot, per the GapSink contract
  }
}

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

describe("KNOWDB_TOOLS interface contract", () => {
  const names = KNOWDB_TOOLS.map((t) => t.name);

  // Contract, not snapshot: published names must persist — assert a required floor, not exact set/count.
  it("keeps every published tool name", () => {
    for (const n of [
      "get_instructions",
      "list_docs",
      "read_index",
      "search",
      "read_chunk",
      "read_chunks",
      "parent",
      "jump_to_ref",
      "reconstruct_document",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("tool names are unique (unambiguous dispatch)", () => {
    expect(new Set(names).size).toBe(names.length);
  });

  // Backward compat: known params stay present + required; new optional params are fine — assert presence.
  it("does not break legacy tool input schemas", () => {
    const search = KNOWDB_TOOLS.find((t) => t.name === "search")!;
    for (const p of ["keyword", "scope", "case_sensitive", "index_only"]) {
      expect(search.input_schema.properties ?? {}).toHaveProperty(p);
    }
    expect(search.input_schema.required).toContain("keyword");
    const parent = KNOWDB_TOOLS.find((t) => t.name === "parent")!;
    expect(parent.input_schema.properties ?? {}).toHaveProperty("id");
    expect(parent.input_schema.required).toContain("id");
  });

  // Orphan tool → agent gets "Unknown tool"; only that sentinel is a gap (per-tool runtime errors aren't).
  it("dispatches every advertised tool (no orphan definitions)", async () => {
    // Stub fetch so fetching tools fail offline & deterministically — proves dispatch-completeness without real I/O.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("stubbed")));
    try {
      const orphans: string[] = [];
      for (const name of names) {
        try {
          await processToolCall(name, {}, INDEX, MANIFEST);
        } catch (e) {
          if (e instanceof Error && e.message === `Unknown tool: ${name}`) {
            orphans.push(name);
          }
        }
      }
      expect(orphans).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("processToolCall — doc_title enrichment", () => {
  it("search results carry doc_title from the manifest", async () => {
    const out = JSON.parse(await processToolCall("search", { keyword: "BM25" }, INDEX, MANIFEST));
    expect(out.status).toBe("results");
    expect(out.hits.length).toBeGreaterThan(0);
    for (const r of out.hits) {
      const docId = r.id.split("/")[0];
      expect(r.doc_title).toBe(MANIFEST[docId as keyof typeof MANIFEST].title);
    }
  });

  it("search results still carry hierarchy metadata through the tools layer", async () => {
    const out = JSON.parse(
      await processToolCall("search", { keyword: "details", scope: "aaa00001" }, INDEX, MANIFEST)
    );
    const r = out.hits.find((x: { id: string }) => x.id === "aaa00001/01-01");
    expect(r.breadcrumb).toEqual([
      { id: "aaa00001/01", title: "BM25" },
      { id: "aaa00001/01-01", title: "BM25 details" },
    ]);
    expect(r.parent_summary).toBe("BM25"); // current-behavior pin; parent_summary may widen
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

describe("processToolCall — read_chunk on a content-less chunk", () => {
  // A container heading resolves to an empty stub file: instead of handing the
  // agent a blank string, read_chunk names the outcome and points at the tools
  // that reach the real content.
  it("returns a navigation hint (not blank) for a heading with no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "" }));
    try {
      const out = await processToolCall("read_chunk", { id: "aaa00001/01-03" }, INDEX, MANIFEST);
      expect(out.trim()).not.toBe("");
      expect(out).toMatch(/no direct content/i);
      expect(out).toMatch(/read_index|read_chunks|parent/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still returns real content when the chunk has a body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "BM25 is a retrieval function" })
    );
    try {
      const out = await processToolCall("read_chunk", { id: "aaa00001/01" }, INDEX, MANIFEST);
      expect(out).toBe("BM25 is a retrieval function");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hint wins over pattern: an empty container + pattern yields the hint, not '(no matches)'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "" }));
    try {
      const out = await processToolCall(
        "read_chunk",
        { id: "aaa00001/01-03", pattern: "BM25" },
        INDEX,
        MANIFEST
      );
      expect(out).toMatch(/no direct content/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("processToolCall — gap recording on empty search", () => {
  const ABSENT = "nonexistent_zzz";

  it("returns a results envelope and records nothing when search has hits", async () => {
    const sink = new MemSink();
    const out = JSON.parse(
      await processToolCall("search", { keyword: "BM25" }, INDEX, MANIFEST, sink)
    );
    expect(out.status).toBe("results");
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0].doc_title).toBeTruthy();
    expect(sink.events).toHaveLength(0);
  });

  it("records one well-formed gap and returns a known_gap on the first empty search", async () => {
    const sink = new MemSink();
    const raw = await processToolCall(
      "search",
      { keyword: ABSENT, scope: "aaa00001" },
      INDEX,
      MANIFEST,
      sink
    );
    const out = JSON.parse(raw);
    expect(out.status).toBe("known_gap");
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0].occurrence_count).toBe(1);
    expect(sink.events).toHaveLength(1);
    const e = sink.events[0]!;
    expect(e.source).toBe("browser");
    expect(e.keyword).toBe(ABSENT);
    expect(e.scope).toBe("aaa00001");
    expect(e.gap_id).toMatch(/^gap_\d{8}_\d{3}$/);
    expect(typeof e.timestamp).toBe("string");
  });

  it("scope is null when the search is unscoped", async () => {
    const sink = new MemSink();
    await processToolCall("search", { keyword: ABSENT }, INDEX, MANIFEST, sink);
    expect(sink.events[0]!.scope).toBeNull();
  });

  it("occurrence_count accumulates across repeated empty searches", async () => {
    const sink = new MemSink();
    const n = 3; // arbitrary > 1, reused so the loop and assertions can't drift apart
    let raw = "";
    for (let i = 0; i < n; i++) {
      raw = await processToolCall("search", { keyword: ABSENT }, INDEX, MANIFEST, sink);
    }
    const out = JSON.parse(raw);
    expect(out.status).toBe("known_gap");
    expect(out.gaps[0].occurrence_count).toBe(n);
    expect(sink.events).toHaveLength(n);
  });

  it("returns a no_index_match hint and records nothing for index_only empty searches", async () => {
    const sink = new MemSink();
    const out = JSON.parse(
      await processToolCall(
        "search",
        { keyword: ABSENT, index_only: true },
        INDEX,
        MANIFEST,
        sink
      )
    );
    expect(out.status).toBe("no_index_match");
    expect(sink.events).toHaveLength(0);
  });

  // A heading miss must not inflate the gap hotspot: even when the keyword is
  // already a recorded content gap, an index_only miss adds nothing.
  it("index_only miss never records, even for a keyword with prior content-miss gaps", async () => {
    const sink = new MemSink();
    await processToolCall("search", { keyword: ABSENT }, INDEX, MANIFEST, sink);
    expect(sink.events).toHaveLength(1);
    const out = JSON.parse(
      await processToolCall("search", { keyword: ABSENT, index_only: true }, INDEX, MANIFEST, sink)
    );
    expect(out.status).toBe("no_index_match");
    expect(sink.events).toHaveLength(1); // unchanged — no hotspot pollution
  });

  it("does not record for jump_to_ref (only search records)", async () => {
    const sink = new MemSink();
    await processToolCall("jump_to_ref", { id: "aaa00001/00" }, INDEX, MANIFEST, sink);
    expect(sink.events).toHaveLength(0);
  });

  it("no sink → no recording; empty search returns an empty results envelope", async () => {
    const raw = await processToolCall("search", { keyword: ABSENT }, INDEX, MANIFEST);
    expect(JSON.parse(raw)).toEqual({ status: "results", hits: [] });
  });

  // Simple-OR contract: `a|b` records two single-term gaps (record-time fan-out).
  it("simple-OR keyword: fan-out into one event per alternative", async () => {
    const sink = new MemSink();
    await processToolCall(
      "search",
      { keyword: "absent_alpha|absent_beta" },
      INDEX,
      MANIFEST,
      sink
    );
    expect(sink.events).toHaveLength(2);
    expect(sink.events.map((e) => e.keyword).sort()).toEqual([
      "absent_alpha",
      "absent_beta",
    ]);
  });

  // Out-of-contract regex (any metachar beyond `|`) falls back to a single
  // raw-keyword event — no naive `|` split that would produce garbage.
  it("complex regex keyword: falls back to one event with the raw keyword", async () => {
    const sink = new MemSink();
    const KW = "(absent_a|absent_b)c";
    await processToolCall("search", { keyword: KW }, INDEX, MANIFEST, sink);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.keyword).toBe(KW);
  });
});

describe("processToolCall — query_id propagation", () => {
  const ABSENT = "nonexistent_qid";
  const QID = "q_test_query_001";

  it("stamps query_id on the recorded GapEvent (single-term)", async () => {
    const sink = new MemSink();
    await processToolCall("search", { keyword: ABSENT }, INDEX, MANIFEST, sink, QID);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.query_id).toBe(QID);
  });

  it("stamps the same query_id on every fan-out event from a simple-OR keyword", async () => {
    const sink = new MemSink();
    await processToolCall(
      "search",
      { keyword: "absent_alpha|absent_beta" },
      INDEX,
      MANIFEST,
      sink,
      QID
    );
    expect(sink.events).toHaveLength(2);
    for (const e of sink.events) expect(e.query_id).toBe(QID);
  });

  it("omits query_id when none is provided (backward compat)", async () => {
    const sink = new MemSink();
    await processToolCall("search", { keyword: ABSENT }, INDEX, MANIFEST, sink);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.query_id).toBeUndefined();
  });
});
