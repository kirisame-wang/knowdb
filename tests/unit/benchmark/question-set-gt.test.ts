import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BenchmarkProblem } from "../../../src/benchmark/types.js";

// Guards the hand-filled ground truth against the live corpus index: a re-ingest that drops
// or renames a chunk fails here loudly, instead of the reach oracle silently scoring those turns 0.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const problems = JSON.parse(readFileSync(root + "benchmark/smoke.json", "utf8")) as BenchmarkProblem[];
const index = JSON.parse(readFileSync(root + "db/_search_index.json", "utf8")) as Record<string, unknown>;
const chunkExists = (id: string): boolean => Object.prototype.hasOwnProperty.call(index, id);

const turns = problems.flatMap((p) => p.turns.map((t) => ({ id: p.id, t })));

describe("question-set ground truth vs corpus index", () => {
  it("every expected chunk id resolves to a live corpus chunk", () => {
    for (const { id, t } of turns) {
      const ids = [...(t.expected_chunk_ids ?? []), ...(t.expected_chunk_groups ?? []).flat()];
      for (const cid of ids) expect(chunkExists(cid), `${id}#${t.turn_index}: ${cid} missing from index`).toBe(true);
    }
  });

  it("answerable turns carry a non-empty reach rule and doc ids", () => {
    for (const { id, t } of turns.filter(({ t }) => t.answerable)) {
      const groups = t.expected_chunk_groups ?? [];
      expect(groups.length, `${id}#${t.turn_index}: no expected_chunk_groups`).toBeGreaterThan(0);
      for (const g of groups) expect(g.length, `${id}#${t.turn_index}: empty group`).toBeGreaterThan(0);
      expect(t.expected_doc_ids.length, `${id}#${t.turn_index}: no expected_doc_ids`).toBeGreaterThan(0);
    }
  });

  it("unanswerable (gap) turns declare no expected chunks", () => {
    for (const { id, t } of turns.filter(({ t }) => !t.answerable)) {
      expect((t.expected_chunk_groups ?? []).length, `${id}#${t.turn_index}: gap turn has groups`).toBe(0);
      expect((t.expected_chunk_ids ?? []).length, `${id}#${t.turn_index}: gap turn has chunk ids`).toBe(0);
    }
  });

  it("coverage set (expected_chunk_ids) contains every reach-group chunk (coverage ⊇ reach)", () => {
    // The reach rule is a subset of the answer-bearing coverage set; coverage may hold
    // extra chunks that aren't part of the any-of success test, so superset, not equality.
    for (const { id, t } of turns.filter(({ t }) => t.answerable)) {
      const coverage = new Set(t.expected_chunk_ids ?? []);
      for (const cid of (t.expected_chunk_groups ?? []).flat()) {
        expect(coverage.has(cid), `${id}#${t.turn_index}: reach chunk ${cid} missing from coverage set`).toBe(true);
      }
    }
  });

  it("doc ids match the docs the expected chunks belong to", () => {
    for (const { id, t } of turns.filter(({ t }) => t.answerable)) {
      const docs = new Set((t.expected_chunk_ids ?? []).map((cid) => cid.split("/")[0]));
      expect([...new Set(t.expected_doc_ids)].sort(), `${id}#${t.turn_index}: doc ids ≠ chunk docs`).toEqual([...docs].sort());
    }
  });
});
