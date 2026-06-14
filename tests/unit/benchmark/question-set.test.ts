import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BenchmarkProblem } from "../../../src/benchmark/types.js";

// Data-contract test for the shipped question set (benchmark/smoke.json): the fixture's own
// structural invariants, and its hand-filled ground truth against the live corpus index — a
// re-ingest that drops or renames a chunk fails here loudly, instead of the reach oracle
// silently scoring those turns 0.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const problems = JSON.parse(readFileSync(root + "benchmark/smoke.json", "utf8")) as BenchmarkProblem[];
const index = JSON.parse(readFileSync(root + "db/_search_index.json", "utf8")) as Record<string, unknown>;
const chunkExists = (id: string): boolean => Object.prototype.hasOwnProperty.call(index, id);

const turns = problems.flatMap((p) => p.turns.map((t) => ({ id: p.id, t })));

const THREAD_TYPES = new Set(["symmetric", "structural", "lexical_gap", "sparse", "mtrag"]);
const TURN_TYPES = new Set(["symmetric", "structural", "lexical_gap"]);
const CLASSES = new Set(["within_doc", "cross_doc"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

describe("question-set shape", () => {
  it("problem ids are unique", () => {
    const ids = problems.map((p) => p.id);
    expect(new Set(ids).size, "duplicate problem id").toBe(ids.length);
  });

  it("turn_index is 0-based and contiguous within each thread", () => {
    for (const p of problems) {
      const idxs = p.turns.map((t) => t.turn_index);
      expect(idxs, `${p.id}: turn_index not [0..n)`).toEqual(p.turns.map((_, i) => i));
    }
  });

  it("thread_type / turn_type / expected_classification / difficulty use known values", () => {
    for (const p of problems) {
      expect(THREAD_TYPES.has(p.thread_type), `${p.id}: thread_type ${p.thread_type}`).toBe(true);
      if (p.difficulty !== undefined)
        expect(DIFFICULTIES.has(p.difficulty), `${p.id}: difficulty ${p.difficulty}`).toBe(true);
      for (const t of p.turns) {
        expect(TURN_TYPES.has(t.turn_type), `${p.id}#${t.turn_index}: turn_type ${t.turn_type}`).toBe(true);
        expect(CLASSES.has(t.expected_classification), `${p.id}#${t.turn_index}: class ${t.expected_classification}`).toBe(true);
      }
    }
  });

  it("every turn has a non-empty question and rubric keypoints, every thread a domain", () => {
    for (const p of problems) {
      expect(p.domain.trim().length, `${p.id}: empty domain`).toBeGreaterThan(0);
      for (const t of p.turns) {
        expect(t.question.trim().length, `${p.id}#${t.turn_index}: empty question`).toBeGreaterThan(0);
        expect(t.expected_answer_keypoints.length, `${p.id}#${t.turn_index}: no keypoints`).toBeGreaterThan(0);
      }
    }
  });

  it("a thread's first turn is never a follow-up (no co-ref before turn 0)", () => {
    for (const p of problems) {
      const first = p.turns.find((t) => t.turn_index === 0);
      if (first) expect(first.is_followup, `${p.id}: turn 0 marked follow-up`).toBe(false);
    }
  });
});

describe("question-set ground truth vs corpus index", () => {
  it("the corpus index loaded as a non-empty object", () => {
    expect(Object.keys(index).length, "db/_search_index.json empty or missing").toBeGreaterThan(0);
  });

  it("every expected chunk id resolves to a live corpus chunk", () => {
    for (const { id, t } of turns) {
      const ids = [...(t.expected_chunk_ids ?? []), ...(t.expected_chunk_groups ?? []).flat()];
      for (const cid of ids) expect(chunkExists(cid), `${id}#${t.turn_index}: ${cid} missing from index`).toBe(true);
    }
  });

  it("expected chunk ids have <doc>/<segment> shape (docIdOf relies on it)", () => {
    for (const { id, t } of turns) {
      for (const cid of [...(t.expected_chunk_ids ?? []), ...(t.expected_chunk_groups ?? []).flat()]) {
        const slash = cid.indexOf("/");
        expect(slash > 0 && slash < cid.length - 1, `${id}#${t.turn_index}: malformed chunk id ${cid}`).toBe(true);
      }
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
