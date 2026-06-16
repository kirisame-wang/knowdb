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

    it("produces an empty chunk file for a content-less section (01-03.md) — tree↔disk invariant", async () => {
      // Content-less container → empty stub file (so it stays navigable).
      const path = join(DB_DIR, docId, "01-03.md");
      expect(existsSync(path)).toBe(true);
      expect((await readFile(path, "utf-8")).trim()).toBe("");
    });

    it("indexes the content-less section with an empty value (navigable, never 404s)", async () => {
      const index = JSON.parse(await readFile(join(DB_DIR, "_search_index.json"), "utf-8"));
      expect(index).toHaveProperty(`${docId}/01-03`);
      expect(index[`${docId}/01-03`]).toBe("");
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

  // Heading-level skips (a page break drops the intervening heading) must not
  // collide chunk ids. Two shapes: a jump under a sub-parent, and a jump at the
  // root (leading H2 then a later H1 — the corpus's duplicate `01`).
  describe("heading-level jumps: monotonic sibling numbering (no id collision / data loss)", () => {
    const DB = dbDir("db-test-jump");
    let tmp: string;
    let jumpId: string;
    let rootId: string;

    beforeAll(async () => {
      await mkdir(DB, { recursive: true });
      tmp = await mkdtemp(join(tmpdir(), "knowdb-jump-"));
      // Shape 1: jump under sub-parent P — ## P → #### X → #### Y → ### Z → #### Z-child
      await fsWriteFile(
        join(tmp, "jump-doc.md"),
        ["# Top", "", "## Section P", "", "#### Orphan X", "x-body", "", "#### Orphan Y", "y-body", "", "### Major Z", "z-body", "", "#### Z child", "zchild-body", ""].join("\n"),
        "utf-8"
      );
      // Shape 2: jump at root — leading ## then a later # both land under root.
      await fsWriteFile(
        join(tmp, "root-doc.md"),
        ["## Lead H2", "lead-body", "", "# Real H1", "h1-body", ""].join("\n"),
        "utf-8"
      );
      const r = runIngest([tmp], DB); // directory mode: one spawn ingests both
      expect(r.status, r.stderr).toBe(0);
      const manifest = JSON.parse(await readFile(join(DB, "_manifest.json"), "utf-8")) as Record<
        string,
        { originalFilename: string }
      >;
      const idOf = (f: string) => Object.keys(manifest).find((k) => manifest[k]!.originalFilename === f)!;
      jumpId = idOf("jump-doc.md");
      rootId = idOf("root-doc.md");
    });

    afterAll(async () => {
      await rm(DB, { recursive: true, force: true });
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    // Reading distinct ids back with the right bodies is the data-loss pin:
    // per-depth numbering collided X(H4)/Z(H3), so Z would overwrite X at 01-01-01.
    it("numbers X(H4)/Y(H4)/Z(H3) as distinct siblings under P — no collision, no overwrite", async () => {
      expect(await readFile(join(DB, jumpId, "01-01-01.md"), "utf-8")).toContain("x-body");
      expect(await readFile(join(DB, jumpId, "01-01-02.md"), "utf-8")).toContain("y-body");
      expect(await readFile(join(DB, jumpId, "01-01-03.md"), "utf-8")).toContain("z-body");
    });

    it("nests a deeper heading under the preceding shallower one (Z child under Z)", async () => {
      expect(await readFile(join(DB, jumpId, "01-01-03-01.md"), "utf-8")).toContain("zchild-body");
    });

    it("lists the jumped headings as siblings in _index.md", async () => {
      const idxMd = await readFile(join(DB, jumpId, "_index.md"), "utf-8");
      expect(idxMd).toContain("01-01-01: Orphan X");
      expect(idxMd).toContain("01-01-02: Orphan Y");
      expect(idxMd).toContain("01-01-03: Major Z");
      expect(idxMd).toContain("01-01-03-01: Z child");
    });

    // Root-level collision: a leading H2 and a later H1 are both root children.
    // Per-depth numbering gave both `01` (the H1 overwrote the H2's chunk).
    it("numbers a leading H2 and a later H1 as distinct top-level chunks", async () => {
      expect(await readFile(join(DB, rootId, "01.md"), "utf-8")).toContain("lead-body");
      expect(await readFile(join(DB, rootId, "02.md"), "utf-8")).toContain("h1-body");
    });
  });

  describe("fenced code blocks: `# ` lines inside fences are not headings", () => {
    const DB = dbDir("db-test-fence");
    let tmp: string;
    let fenceId: string;
    let preId: string;
    let mismatchId: string;
    let lengthId: string;

    beforeAll(async () => {
      await mkdir(DB, { recursive: true });
      tmp = await mkdtemp(join(tmpdir(), "knowdb-fence-"));
      // Fenced `# ` / `### ` lines inside a section stay in the body.
      await fsWriteFile(
        join(tmp, "fence-doc.md"),
        [
          "# Real Heading",
          "intro body",
          "",
          "```bash",
          "# install deps",
          "npm install",
          "```",
          "",
          "~~~",
          "### Step 3 example",
          "~~~",
          "",
          "after the fence",
          "",
          "## Real Subsection",
          "sub body",
          "",
        ].join("\n"),
        "utf-8"
      );
      // A fenced `# ` in the preamble must not cut it short.
      await fsWriteFile(
        join(tmp, "pre-doc.md"),
        ["```", "# not a heading", "```", "", "preamble prose", "", "# Real H1", "h1 body", ""].join("\n"),
        "utf-8"
      );
      // A `~~~` line must not close a backtick fence (marker-char rule).
      await fsWriteFile(
        join(tmp, "mismatch-doc.md"),
        ["# Heading One", "intro", "```text", "~~~", "# fenced hash", "```", "## Sub After", "sub body", ""].join("\n"),
        "utf-8"
      );
      // A shorter close fence must not close a longer one (length rule).
      await fsWriteFile(
        join(tmp, "length-doc.md"),
        ["# Length Heading", "intro", "````", "```", "# still fenced", "````", "## After Length", "after body", ""].join("\n"),
        "utf-8"
      );
      const r = runIngest([tmp], DB);
      expect(r.status, r.stderr).toBe(0);
      const manifest = JSON.parse(await readFile(join(DB, "_manifest.json"), "utf-8")) as Record<
        string,
        { originalFilename: string }
      >;
      const idOf = (f: string) => Object.keys(manifest).find((k) => manifest[k]!.originalFilename === f)!;
      fenceId = idOf("fence-doc.md");
      preId = idOf("pre-doc.md");
      mismatchId = idOf("mismatch-doc.md");
      lengthId = idOf("length-doc.md");
    });

    afterAll(async () => {
      await rm(DB, { recursive: true, force: true });
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    it("keeps fenced `# ` / `### ` lines in the section body, not as new chunks", async () => {
      const body = await readFile(join(DB, fenceId, "01.md"), "utf-8");
      expect(body).toContain("# install deps");
      expect(body).toContain("npm install");
      expect(body).toContain("### Step 3 example");
      expect(body).toContain("after the fence");
    });

    it("does not create a fake section from a fenced heading-looking line", async () => {
      const idx = await readFile(join(DB, fenceId, "_index.md"), "utf-8");
      expect(idx).not.toContain("install deps");
      expect(idx).not.toContain("Step 3 example");
      // Only the two real headings exist as top-level/nested chunks.
      expect(existsSync(join(DB, fenceId, "01.md"))).toBe(true);
      expect(existsSync(join(DB, fenceId, "01-01.md"))).toBe(true);
      expect(existsSync(join(DB, fenceId, "02.md"))).toBe(false);
    });

    it("nests the real subsection under the real heading", async () => {
      expect(await readFile(join(DB, fenceId, "01-01.md"), "utf-8")).toContain("sub body");
    });

    it("does not truncate the preamble at a fenced `# ` line", async () => {
      const pre = await readFile(join(DB, preId, "00.md"), "utf-8");
      expect(pre).toContain("# not a heading");
      expect(pre).toContain("preamble prose");
      // The real heading after the fence still starts the first section.
      expect(await readFile(join(DB, preId, "01.md"), "utf-8")).toContain("h1 body");
    });

    it("a different fence marker does not close the fence (marker-char check)", async () => {
      const body = await readFile(join(DB, mismatchId, "01.md"), "utf-8");
      expect(body).toContain("~~~");
      expect(body).toContain("# fenced hash");
      expect(await readFile(join(DB, mismatchId, "01-01.md"), "utf-8")).toContain("sub body");
      expect(await readFile(join(DB, mismatchId, "_index.md"), "utf-8")).not.toContain("fenced hash");
      expect(existsSync(join(DB, mismatchId, "02.md"))).toBe(false);
    });

    it("a shorter closing fence does not close a longer one (length rule)", async () => {
      const body = await readFile(join(DB, lengthId, "01.md"), "utf-8");
      expect(body).toContain("# still fenced");
      expect(await readFile(join(DB, lengthId, "01-01.md"), "utf-8")).toContain("after body");
      expect(await readFile(join(DB, lengthId, "_index.md"), "utf-8")).not.toContain("still fenced");
      expect(existsSync(join(DB, lengthId, "02.md"))).toBe(false);
    });
  });

  describe("title-less heading (`## ` with no title) stays content, not a break", () => {
    const DB = dbDir("db-test-titleless");
    let tmp: string;
    let titlelessId: string;

    beforeAll(async () => {
      await mkdir(DB, { recursive: true });
      tmp = await mkdtemp(join(tmpdir(), "knowdb-titleless-"));
      // `## ` has a marker and a space but no title. The unified parse treats it
      // as content and keeps it — and the text after it, up to the first real
      // heading — in the preamble; the old two-scan path dropped that text.
      await fsWriteFile(
        join(tmp, "titleless.md"),
        ["intro prose", "## ", "trailing after empty heading", "# Real H1", "h1 body", ""].join("\n"),
        "utf-8"
      );
      const r = runIngest([tmp], DB);
      expect(r.status, r.stderr).toBe(0);
      const manifest = JSON.parse(await readFile(join(DB, "_manifest.json"), "utf-8")) as Record<
        string,
        { originalFilename: string }
      >;
      titlelessId = Object.keys(manifest).find((k) => manifest[k]!.originalFilename === "titleless.md")!;
    });

    afterAll(async () => {
      await rm(DB, { recursive: true, force: true });
      if (tmp) await rm(tmp, { recursive: true, force: true });
    });

    it("keeps the title-less line and the text after it in the preamble", async () => {
      const pre = await readFile(join(DB, titlelessId, "00.md"), "utf-8");
      expect(pre).toContain("intro prose");
      expect(pre).toContain("trailing after empty heading");
    });

    it("creates no section for the title-less heading", async () => {
      expect(await readFile(join(DB, titlelessId, "01.md"), "utf-8")).toContain("h1 body");
      expect(existsSync(join(DB, titlelessId, "02.md"))).toBe(false);
      expect(await readFile(join(DB, titlelessId, "_index.md"), "utf-8")).toContain("Real H1");
    });
  });
});
