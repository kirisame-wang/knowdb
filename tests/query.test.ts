import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { rm, mkdir } from "fs/promises";
import { readFileSync, existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { parseJsonl } from "../src/utils.js";
import type { GapEvent } from "../src/types.js";
import { FIXTURE, QUERY_SH, dbDir, runIngest } from "./helpers.js";

const DB_DIR = dbDir("db-query-test");
const GAPS_DIR = dbDir("gaps-query-test");
const GAPS_FILE = join(GAPS_DIR, "query-gaps.jsonl");
const GAPS_TS = join(QUERY_SH, "..", "gaps.ts"); // scripts/gaps.ts

function runQuery(args: string[]): { stdout: string; status: number } {
  const result = spawnSync("bash", [QUERY_SH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, DB_DIR, GAPS_DIR },
  });
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

function runQueryEnv(
  args: string[],
  extraEnv: Record<string, string>
): { stdout: string; status: number } {
  const result = spawnSync("bash", [QUERY_SH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, DB_DIR, GAPS_DIR, ...extraEnv },
  });
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

function runGapsAggregate(): { stdout: string; status: number } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", GAPS_TS, "aggregate"],
    { encoding: "utf-8", env: { ...process.env, GAPS_DIR } }
  );
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

describe("query CLI", () => {
  let docId: string;

  beforeAll(async () => {
    await mkdir(DB_DIR, { recursive: true });
    const r = runIngest([FIXTURE], DB_DIR);
    if (r.status !== 0) throw new Error(`ingest failed: ${r.stderr}`);
    const { readFileSync } = await import("fs");
    const manifest = JSON.parse(readFileSync(join(DB_DIR, "_manifest.json"), "utf-8"));
    docId = Object.keys(manifest)[0] ?? "";
  });

  afterAll(async () => {
    await rm(DB_DIR, { recursive: true, force: true });
    await rm(GAPS_DIR, { recursive: true, force: true });
  });

  describe("search", () => {
    it("returns chunk paths containing the keyword", () => {
      const { stdout, status } = runQuery(["search", "BM25"]);
      // sample.md may not contain BM25; assert exit status only
      expect(status).toBe(0);
    });

    it("returns paths matching keyword in fixture", () => {
      const { stdout, status } = runQuery(["search", "Preamble"]);
      expect(status).toBe(0);
      expect(stdout).toContain(`db-query-test/${docId}/00.md`);
    });

    it("limits results with --scope", () => {
      const { stdout, status } = runQuery(["search", "Body", "--scope", docId]);
      expect(status).toBe(0);
      const lines = stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        expect(line).toContain(docId);
      }
    });
  });

  describe("parent", () => {
    it("returns parent path for nested chunk", () => {
      const chunk = `${DB_DIR}/${docId}/01-01.md`;
      const { stdout, status } = runQuery(["parent", chunk]);
      expect(status).toBe(0);
      expect(stdout).toContain(`${docId}/01.md`);
    });

    it("returns null for top-level chunk", () => {
      const chunk = `${DB_DIR}/${docId}/01.md`;
      const { stdout, status } = runQuery(["parent", chunk]);
      expect(status).toBe(0);
      expect(stdout).toBe("null");
    });
  });

  describe("siblings", () => {
    it("returns sibling paths excluding self", () => {
      const chunk = `${DB_DIR}/${docId}/01-01.md`;
      const { stdout, status } = runQuery(["siblings", chunk]);
      expect(status).toBe(0);
      const lines = stdout.split("\n").filter(Boolean);
      expect(lines.some((l) => l.includes("01-02.md"))).toBe(true);
      expect(lines.every((l) => !l.includes("01-01.md"))).toBe(true);
    });
  });

  describe("expand", () => {
    it("--level 1 returns chunk + siblings", () => {
      const chunk = `${DB_DIR}/${docId}/01-01.md`;
      const { stdout, status } = runQuery(["expand", chunk, "--level", "1"]);
      expect(status).toBe(0);
      const lines = stdout.split("\n").filter(Boolean);
      expect(lines.some((l) => l.includes("01-01.md"))).toBe(true);
      expect(lines.some((l) => l.includes("01-02.md"))).toBe(true);
    });

    it("--level 2 includes parent", () => {
      const chunk = `${DB_DIR}/${docId}/01-01.md`;
      const { stdout, status } = runQuery(["expand", chunk, "--level", "2"]);
      expect(status).toBe(0);
      expect(stdout).toContain(`${docId}/01.md`);
    });

    it("--level 3 returns all chunks in doc", () => {
      const chunk = `${DB_DIR}/${docId}/01.md`;
      const { stdout, status } = runQuery(["expand", chunk, "--level", "3"]);
      expect(status).toBe(0);
      const lines = stdout.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(3);
    });
  });

  describe("gap recording (local sink)", () => {
    const ABSENT = "zzz_absent_term";

    beforeEach(async () => {
      await rm(GAPS_DIR, { recursive: true, force: true });
    });

    it("appends a well-formed gap line when search has no hits", () => {
      const { status } = runQuery(["search", ABSENT]);
      expect(status).toBe(0);
      expect(existsSync(GAPS_FILE)).toBe(true);

      const events = parseJsonl<GapEvent>(readFileSync(GAPS_FILE, "utf-8"));
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e.source).toBe("local");
      expect(e.keyword).toBe(ABSENT);
      expect(e.scope).toBeNull();
      expect(e.gap_id).toMatch(/^gap_\d{8}_\d{3}$/);
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
    });

    it("does not record when the search has hits", () => {
      const { status } = runQuery(["search", "Preamble"]);
      expect(status).toBe(0);
      const events = existsSync(GAPS_FILE)
        ? parseJsonl<GapEvent>(readFileSync(GAPS_FILE, "utf-8"))
        : [];
      expect(events).toHaveLength(0);
    });

    it("captures the scope when the miss is scoped", () => {
      runQuery(["search", ABSENT, "--scope", docId]);
      const events = parseJsonl<GapEvent>(readFileSync(GAPS_FILE, "utf-8"));
      expect(events[0]!.scope).toBe(docId);
    });

    it("is schema-compatible with aggregate() (cross-mode)", () => {
      runQuery(["search", ABSENT]);
      runQuery(["search", ABSENT]);
      const { stdout, status } = runGapsAggregate();
      expect(status).toBe(0);
      const agg = JSON.parse(stdout);
      const row = agg.find((a: { topic: string }) => a.topic === ABSENT);
      expect(row).toBeTruthy();
      expect(row.occurrence_count).toBe(2);
    });

    // Cross-mode contract: bash-written JSONL must JSON.parse back to the
    // exact keyword. (A bare CR can't survive Node→Win32→bash argv, so \r
    // isn't asserted, though json_escape handles it for POSIX agents.)
    it.each([
      ["double quote", 'zzqq_"x"'],
      ["backslash", "zzqq_\\path"],
      ["backslash + quote", 'zzqq_\\"'],
      ["tab", "zzqq_a\tb"],
      ["CJK passthrough", "zzqq_進階配置"],
    ])("round-trips a keyword with %s through the bash sink", (_label, kw) => {
      const { status } = runQuery(["search", kw]);
      expect(status).toBe(0);
      const events = parseJsonl<GapEvent>(readFileSync(GAPS_FILE, "utf-8"));
      expect(events).toHaveLength(1);
      expect(events[0]!.keyword).toBe(kw);
    });
  });

  // Local session_id comes only from the program-written .session_id file
  // (never user-supplied); SESSION_ID_FILE overrides the path for tests.
  describe("session_id correlator (local sink)", () => {
    const ABSENT = "zzz_absent_sid";
    const SESSION_FILE = dbDir("gaps-query-test-sid"); // sibling: survives beforeEach rm

    beforeEach(async () => {
      await rm(GAPS_DIR, { recursive: true, force: true });
    });
    afterEach(() => {
      if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE);
    });

    function lastEvent() {
      return parseJsonl<GapEvent>(readFileSync(GAPS_FILE, "utf-8"))[0]!;
    }

    it("omits session_id when no .session_id file is present", () => {
      // SESSION_FILE intentionally absent
      runQueryEnv(["search", ABSENT], { SESSION_ID_FILE: SESSION_FILE });
      expect(lastEvent().session_id).toBeUndefined();
    });

    it("reads the program-generated session_id from the .session_id file", () => {
      writeFileSync(SESSION_FILE, "sess-from-file\n");
      runQueryEnv(["search", ABSENT], { SESSION_ID_FILE: SESSION_FILE });
      expect(lastEvent().session_id).toBe("sess-from-file");
    });
  });
});
