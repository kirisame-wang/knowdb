import { readFile, writeFile, mkdir, rm, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, extname } from "path";
import { createHash } from "crypto";
import type { ChunkEntry, SearchIndex } from "../src/types.js";

const DB_DIR = process.env["DB_DIR"] ?? join(process.cwd(), "db");

// ── Types ────────────────────────────────────────────────────────────────────

interface Section {
  id: string;
  title: string;
  depth: number; // 0 = preamble, 1 = H1, 2 = H2, ...
  content: string;
  children: Section[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseSections(text: string): Section[] {
  const lines = text.split("\n");
  const root: Section = { id: "root", title: "", depth: 0, content: "", children: [] };
  const stack: Section[] = [root];
  let preambleLines: string[] = [];
  let currentLines: string[] = [];
  let inSection = false;

  const flush = (section: Section, bodyLines: string[]) => {
    section.content = bodyLines.join("\n").trim();
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6}) (.+)$/.exec(line);
    if (!headingMatch) {
      (inSection ? currentLines : preambleLines).push(line);
      continue;
    }

    const depth = headingMatch[1]!.length;
    const title = headingMatch[2]!.trim();

    // flush previous section
    if (inSection) {
      flush(stack[stack.length - 1]!, currentLines);
      currentLines = [];
    } else {
      flush(root, preambleLines);
      preambleLines = [];
      inSection = true;
    }

    // pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]!;
    const siblingCount = parent.children.filter((c) => c.depth === depth).length;
    const idSegment = String(siblingCount + 1).padStart(2, "0");
    const id = parent.id === "root" ? idSegment : `${parent.id}-${idSegment}`;

    const section: Section = { id, title, depth, content: "", children: [] };
    parent.children.push(section);
    stack.push(section);
  }

  // flush last section
  if (inSection && stack.length > 1) {
    flush(stack[stack.length - 1]!, currentLines);
  } else if (!inSection) {
    flush(root, preambleLines);
  }

  return collectSections(root);
}

function collectSections(node: Section): Section[] {
  const result: Section[] = [];
  if (node.id !== "root") result.push(node);
  for (const child of node.children) result.push(...collectSections(child));
  return result;
}

// ── ID helpers ───────────────────────────────────────────────────────────────

function docId(stem: string): string {
  return createHash("sha256").update(stem, "utf8").digest("hex").slice(0, 8);
}

// ── Output ───────────────────────────────────────────────────────────────────

function buildIndexMd(sections: Section[], source: string, id: string): string {
  const lines = [`# ${id} Index`, `# source: ${source}`, ""];
  const renderChildren = (nodes: Section[], indent: string) => {
    for (const s of nodes) {
      lines.push(`${indent}- ${s.id}: ${s.title}`);
      if (s.children.length > 0) renderChildren(s.children, indent + "  ");
    }
  };
  // rebuild tree just for index rendering
  renderChildren(buildTree(sections), "");
  return lines.join("\n") + "\n";
}

function buildTree(flat: Section[]): Section[] {
  // Return only top-level sections (depth === 1) preserving children
  const top = flat.filter((s) => !s.id.includes("-"));
  // Recursively attach children already in flat list
  return top;
}

async function ingestFile(filePath: string): Promise<void> {
  const text = await readFile(filePath, "utf-8");
  const stem = basename(filePath, extname(filePath));
  const id = docId(stem);
  const outDir = join(DB_DIR, id);

  // collision check
  const manifestPath = join(DB_DIR, "_manifest.json");
  let manifest: Record<string, { originalFilename: string; title: string }> = {};
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  }
  if (manifest[id] && manifest[id].originalFilename !== basename(filePath)) {
    throw new Error(`doc_id collision: ${id} already mapped to ${manifest[id].originalFilename}`);
  }

  // clear and recreate doc dir
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const sections = parseSections(text);

  // write preamble (root content)
  const rootSection = { id: "root", title: "", depth: 0, content: "", children: [] };
  // preamble is the content before first heading — reconstruct from parseSections result
  // The root preamble lives in the parseSections result as the pre-first-section content.
  // We need to re-extract it. Let's get it directly:
  const preamble = extractPreamble(text);
  if (preamble.trim()) {
    await writeFile(join(outDir, "00.md"), preamble.trim() + "\n", "utf-8");
  }

  // write chunk files
  for (const section of sections) {
    if (section.content.trim()) {
      await writeFile(join(outDir, `${section.id}.md`), section.content + "\n", "utf-8");
    }
  }

  // write _index.md
  const indexContent = buildIndexMd(sections, basename(filePath), id);
  await writeFile(join(outDir, "_index.md"), indexContent, "utf-8");

  // update manifest
  manifest[id] = { originalFilename: basename(filePath), title: stem };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  // rebuild _search_index.json
  await rebuildSearchIndex();
}

function extractPreamble(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    if (/^#{1,6} /.test(line)) break;
    result.push(line);
  }
  return result.join("\n");
}

async function rebuildSearchIndex(): Promise<void> {
  const index: SearchIndex = {};
  const dirs = await readdir(DB_DIR, { withFileTypes: true });
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const docDir = join(DB_DIR, dirent.name);
    const files = await readdir(docDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const chunkId = file.replace(/\.md$/, "");
      const content = await readFile(join(docDir, file), "utf-8");
      index[`${dirent.name}/${chunkId}`] = content.trim();
    }
  }
  await writeFile(join(DB_DIR, "_search_index.json"), JSON.stringify(index, null, 2) + "\n", "utf-8");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: ingest.ts <file.md | directory/>");
    process.exit(1);
  }

  await mkdir(DB_DIR, { recursive: true });

  const { stat } = await import("fs/promises");
  const info = await stat(arg);

  if (info.isDirectory()) {
    const files = (await readdir(arg)).filter((f) => f.endsWith(".md"));
    for (const file of files) await ingestFile(join(arg, file));
  } else {
    await ingestFile(arg);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
