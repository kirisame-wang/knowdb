import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rm, mkdir, mkdtemp, writeFile as fsWriteFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FIXTURE, dbDir, runIngest } from "../helpers.js";

const DB_DIR = dbDir("db-test");

describe("ingest", () => {
  beforeAll(async () => {
    await mkdir(DB_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(DB_DIR, { recursive: true, force: true });
  });

  describe("integration: sample.md → db/", () => {
    let docId: string;

    beforeAll(() => {
      const result = runIngest([FIXTURE], DB_DIR);
      expect(result.status, result.stderr).toBe(0);

      // discover the doc_id from _manifest.json
      const manifest = JSON.parse(
        require("fs").readFileSync(join(DB_DIR, "_manifest.json"), "utf-8")
      );
      docId = Object.keys(manifest)[0] ?? "";
      expect(docId).toMatch(/^[0-9a-f]{8}$/);
    });

    it("produces _manifest.json with originalFilename and title", async () => {
      const manifest = JSON.parse(await readFile(join(DB_DIR, "_manifest.json"), "utf-8"));
      expect(manifest[docId]).toMatchObject({
        originalFilename: "sample.md",
        title: "sample",
      });
    });

    it("produces _search_index.json with docId/chunkId keys", async () => {
      const index = JSON.parse(await readFile(join(DB_DIR, "_search_index.json"), "utf-8"));
      const keys = Object.keys(index);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(/^[0-9a-f]{8}\//);
      }
    });

    it("produces _index.md with heading tree", async () => {
      const idx = await readFile(join(DB_DIR, docId, "_index.md"), "utf-8");
      expect(idx).toContain("First Section");
      expect(idx).toContain("Subsection A");
      expect(idx).toContain("Empty Subsection");
    });

    it("produces 00.md for preamble", async () => {
      const content = await readFile(join(DB_DIR, docId, "00.md"), "utf-8");
      expect(content).toContain("Preamble content");
      expect(content).not.toMatch(/^#/m);
    });

    it("produces 01.md for first H1 body, no heading line", async () => {
      const content = await readFile(join(DB_DIR, docId, "01.md"), "utf-8");
      expect(content).toContain("Body of the first H1 section");
      expect(content).not.toMatch(/^#/m);
      expect(content).not.toContain("Subsection A");
    });

    it("produces 01-01.md for Subsection A", async () => {
      const content = await readFile(join(DB_DIR, docId, "01-01.md"), "utf-8");
      expect(content).toContain("Body of subsection A");
      expect(content).not.toMatch(/^#/m);
    });

    it("produces 01-02-01.md for Deep Level (H3)", async () => {
      const content = await readFile(join(DB_DIR, docId, "01-02-01.md"), "utf-8");
      expect(content).toContain("Body of a deeply nested H3");
    });

    it("does NOT produce a chunk file for empty section (01-03.md)", () => {
      expect(existsSync(join(DB_DIR, docId, "01-03.md"))).toBe(false);
    });

    it("still records empty section in _index.md", async () => {
      const idx = await readFile(join(DB_DIR, docId, "_index.md"), "utf-8");
      expect(idx).toContain("Empty Subsection");
    });

    it("produces chunk for special-character heading", async () => {
      const content = await readFile(join(DB_DIR, docId, "02.md"), "utf-8");
      expect(content).toContain("Body of the special-character heading");
    });

    it("produces 03.md for Second H1", async () => {
      const content = await readFile(join(DB_DIR, docId, "03.md"), "utf-8");
      expect(content).toContain("Body of the second H1");
    });

    it("chunk content does not contain heading lines", async () => {
      const files = ["01.md", "01-01.md", "01-02.md", "03.md"];
      for (const f of files) {
        const path = join(DB_DIR, docId, f);
        if (existsSync(path)) {
          const content = await readFile(path, "utf-8");
          expect(content, `${f} should not contain heading lines`).not.toMatch(/^#{1,6} /m);
        }
      }
    });

    it("is idempotent: running twice produces same output", async () => {
      const before = await readFile(join(DB_DIR, "_manifest.json"), "utf-8");
      runIngest([FIXTURE], DB_DIR);
      const after = await readFile(join(DB_DIR, "_manifest.json"), "utf-8");
      expect(after).toBe(before);
    });
  });

  describe("CRLF input tolerance (Windows-line-ended source must not silently degrade)", () => {
    const DB = dbDir("db-test-crlf");
    let tmp: string;

    afterAll(async () => {
      await rm(DB, { recursive: true, force: true });
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    it("CRLF input: 01.md exists, no 00.md preamble, title in _index.md (single self-contained pin)", async () => {
      await mkdir(DB, { recursive: true });
      tmp = await mkdtemp(join(tmpdir(), "knowdb-crlf-"));
      const path = join(tmp, "crlf-doc.md");
      await fsWriteFile(path, "# H1 Title\n\nBody under H1.\n".replace(/\n/g, "\r\n"), "utf-8");
      const r = runIngest([path], DB);
      expect(r.status, r.stderr).toBe(0);
      const manifest = JSON.parse(await readFile(join(DB, "_manifest.json"), "utf-8")) as Record<
        string,
        { originalFilename: string }
      >;
      const docId = Object.keys(manifest).find((k) => manifest[k]!.originalFilename === "crlf-doc.md")!;

      // Without normalization the heading regex fails → all text → 00.md.
      expect(existsSync(join(DB, docId, "01.md"))).toBe(true);
      expect(existsSync(join(DB, docId, "00.md"))).toBe(false);
      expect(await readFile(join(DB, docId, "01.md"), "utf-8")).toContain("Body under H1");
      expect(await readFile(join(DB, docId, "_index.md"), "utf-8")).toContain("- 01: H1 Title");
    });
  });
});
