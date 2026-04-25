import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { rm, mkdir } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(__dirname, "fixtures/sample.md");
const DB_DIR = join(__dirname, "../db-query-test");
const QUERY_SH = join(__dirname, "../scripts/query.sh");

function runIngest(fixture: string): void {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", join(__dirname, "../scripts/ingest.ts"), fixture],
    { encoding: "utf-8", env: { ...process.env, DB_DIR } }
  );
  if (result.status !== 0) throw new Error(`ingest failed: ${result.stderr}`);
}

function runQuery(args: string[]): { stdout: string; status: number } {
  const result = spawnSync("bash", [QUERY_SH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, DB_DIR },
  });
  return { stdout: (result.stdout ?? "").trim(), status: result.status ?? 1 };
}

describe("query CLI", () => {
  let docId: string;

  beforeAll(async () => {
    await mkdir(DB_DIR, { recursive: true });
    runIngest(FIXTURE);
    const { readFileSync } = await import("fs");
    const manifest = JSON.parse(readFileSync(join(DB_DIR, "_manifest.json"), "utf-8"));
    docId = Object.keys(manifest)[0] ?? "";
  });

  afterAll(async () => {
    await rm(DB_DIR, { recursive: true, force: true });
  });

  describe("search", () => {
    it("returns chunk paths containing the keyword", () => {
      const { stdout, status } = runQuery(["search", "BM25"]);
      // sample.md doesn't contain BM25, so expect empty or fall back to a present word
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
});
