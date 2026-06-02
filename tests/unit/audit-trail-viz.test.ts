import { describe, it, expect } from "vitest";
import { extractChunkId, summarizeInput } from "../../src/ui/audit-trail-viz.js";

describe("extractChunkId (spec §3)", () => {
  it("read_chunk → input.id", () => {
    expect(extractChunkId("read_chunk", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("read_chunks → input.id", () => {
    expect(extractChunkId("read_chunks", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("read_index → input.doc_id + '/_index'", () => {
    expect(extractChunkId("read_index", { doc_id: "aaa00001" })).toBe("aaa00001/_index");
  });
  it("parent → input.id", () => {
    expect(extractChunkId("parent", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("jump_to_ref → input.id (source chunk)", () => {
    expect(extractChunkId("jump_to_ref", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("search → undefined (not a read-class tool)", () => {
    expect(extractChunkId("search", { keyword: "BM25" })).toBeUndefined();
  });
  it("unknown tool → undefined", () => {
    expect(extractChunkId("get_instructions", {})).toBeUndefined();
  });
});

describe("summarizeInput (spec §4)", () => {
  it("search: keyword only", () => {
    expect(summarizeInput("search", { keyword: "BM25" })).toBe("BM25");
  });
  it("search: keyword + scope", () => {
    expect(summarizeInput("search", { keyword: "BM25", scope: "aaa00001" })).toBe(
      "BM25, scope=aaa00001"
    );
  });
  it("read_chunk: id only", () => {
    expect(summarizeInput("read_chunk", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("read_chunk: id + pattern (T15 affordance visible)", () => {
    expect(summarizeInput("read_chunk", { id: "aaa00001/01", pattern: "Gap" })).toBe(
      'aaa00001/01, pattern="Gap"'
    );
  });
  it("read_chunk: empty-string pattern counts as NOT set (mirrors metric truthy check)", () => {
    expect(summarizeInput("read_chunk", { id: "aaa00001/01", pattern: "" })).toBe("aaa00001/01");
  });
  it("read_chunk: long pattern truncated to 20 chars + ellipsis (UR3)", () => {
    const long = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    expect(summarizeInput("read_chunk", { id: "aaa00001/01", pattern: long })).toBe(
      'aaa00001/01, pattern="abcdefghijklmnopqrst…"'
    );
  });
  it("read_chunks: id + level", () => {
    expect(summarizeInput("read_chunks", { id: "aaa00001/01", level: 2 })).toBe(
      "aaa00001/01, level=2"
    );
  });
  it("read_index: doc_id", () => {
    expect(summarizeInput("read_index", { doc_id: "aaa00001" })).toBe("aaa00001");
  });
  it("parent: id", () => {
    expect(summarizeInput("parent", { id: "aaa00001/01" })).toBe("aaa00001/01");
  });
  it("jump_to_ref: id + default top_k=3", () => {
    expect(summarizeInput("jump_to_ref", { id: "aaa00001/01" })).toBe("aaa00001/01, top_k=3");
  });
  it("jump_to_ref: id + explicit top_k", () => {
    expect(summarizeInput("jump_to_ref", { id: "aaa00001/01", top_k: 5 })).toBe(
      "aaa00001/01, top_k=5"
    );
  });
  it("unknown tool: truncated JSON of input", () => {
    expect(summarizeInput("get_instructions", {})).toBe("{}");
  });
});
