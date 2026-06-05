import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import {
  search,
  fetchChunk,
  expand,
  expandWithContent,
  parent,
  grepChunk,
  related,
  reconstructDocument,
  splitId,
} from "../db_query.js";
import { SKILL } from "./skill.js";
import {
  makeGapId,
  checkKnownGap,
  noIndexMatch,
  expandKeywordToTopics,
  type GapSink,
} from "../gaps.js";
import { nextDailySeq } from "../utils.js";
import type { SearchIndex, SearchResult, Manifest, GapEvent, ResultsResponse } from "../types.js";

// read_chunk on a container heading (an empty stub, no body of its own) returns
// this instead of a blank string. A content-less node is a real outcome, so it's
// named in prose the agent reads — kept as a plain string (read_chunk's contract
// is markdown text, not a tagged JSON envelope) that points at the tools which
// reach the actual content.
const CONTENTLESS_CHUNK_HINT =
  "This chunk is a section heading with no direct content of its own — its text lives in subsections. " +
  "Use read_index to see the heading tree, read_chunks to list its subsections, or parent to step up.";

/** Attach the human-readable doc_title (from _manifest) to each result. */
function withDocTitles(results: SearchResult[], manifest?: Manifest): SearchResult[] {
  if (!manifest) return results;
  return results.map((r) => {
    const title = manifest[splitId(r.id)[0]]?.title;
    return title ? { ...r, doc_title: title } : r;
  });
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const KNOWDB_TOOLS: Tool[] = [
  {
    name: "get_instructions",
    description: "Get usage instructions for all available tools. Call this before using any other tool.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_docs",
    description: "List all documents in the knowledge base. Call this first to discover available documents.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_index",
    description: "Fetch a document's _index.md — a heading tree showing all section titles and chunk IDs. Use this to orient yourself within a document before searching.",
    input_schema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "8-hex doc_id from list_docs" },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "search",
    description: "Search the knowledge base by keyword (regex supported). Returns an object with a `status`: \"results\" (hits in `hits`, each [{id, score, excerpt, doc_title, breadcrumb, siblings, parent_summary}] carrying its hierarchy position), \"known_gap\" (nothing matched — see `gaps` and `recommendation`), or \"no_index_match\" (index_only miss — see `recommendation`). Always set scope once you know the target document. Use index_only:true to search heading trees only (fast navigation).",
    input_schema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Keyword or regex pattern, e.g. 'revenue|profit' or '每股盈餘'",
        },
        scope: {
          type: "string",
          description: "8-hex doc_id to limit search to one document (recommended)",
        },
        case_sensitive: {
          type: "boolean",
          description: "Default false (case-insensitive). Set true only when case matters.",
        },
        index_only: {
          type: "boolean",
          description: "If true, search only heading trees (_index.md) — useful for document discovery.",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "read_chunk",
    description: "Read a chunk's full content. Use pattern to return only lines matching a regex (like grep -C), avoiding irrelevant content in long chunks.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Chunk id — format: <doc_id>/<chunk_id>, e.g. a3f2b1c9/01-02",
        },
        pattern: {
          type: "string",
          description: "Regex pattern (case-insensitive). If provided, return only matching lines with context lines around them.",
        },
        context: {
          type: "number",
          description: "Lines of context around each pattern match. Default 2.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "read_chunks",
    description: "List a chunk and its neighbours — returns [{id, preview}] where preview is the first line only. Use read_chunk to fetch full content for any item of interest. level 1=chunk+siblings, 2=+parent, 3=whole document.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Chunk id — format: <doc_id>/<chunk_id>" },
        level: {
          type: "number",
          description: "1=chunk+siblings (default), 2=+parent header, 3=whole document (use sparingly)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "parent",
    description: "Get the parent chunk id. Returns null if already at the root section.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "jump_to_ref",
    description: "Lateral cross-document jump: given a chunk id, return related chunks in OTHER documents, ranked by implicit term overlap (not an explicit [[ref]] system). Use after reading a chunk to discover connected material elsewhere in the knowledge base.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Source chunk id — format: <doc_id>/<chunk_id>" },
        top_k: { type: "number", description: "Max related chunks to return. Default 5." },
      },
      required: ["id"],
    },
  },
  {
    name: "reconstruct_document",
    description: "Reassemble a document's full Markdown from its chunks, with headings restored from the heading tree. Use when chunked navigation isn't enough and you need the whole document as continuous text.",
    input_schema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "8-hex doc_id from list_docs" },
      },
      required: ["doc_id"],
    },
  },
];

// ── Tool dispatcher ───────────────────────────────────────────────────────────

export async function processToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  index: SearchIndex,
  manifest?: Manifest,
  sink?: GapSink,
  query_id?: string
): Promise<string> {
  switch (toolName) {
    case "get_instructions":
      return SKILL;

    case "list_docs": {
      const docs = Object.entries(manifest ?? {}).map(([id, info]) => ({
        id,
        title: info.title,
        filename: info.originalFilename,
      }));
      return JSON.stringify(docs);
    }

    case "read_index": {
      const docId = toolInput["doc_id"] as string;
      return fetchChunk(`${docId}/_index`);
    }

    case "search": {
      const keyword = toolInput["keyword"] as string;
      const scope = toolInput["scope"] as string | undefined;
      const caseSensitive = toolInput["case_sensitive"] as boolean | undefined;
      const indexOnly = toolInput["index_only"] as boolean | undefined;
      const opts = { caseInsensitive: !caseSensitive, ...(indexOnly !== undefined && { indexOnly }) };
      const results = search(index, keyword, scope, opts);

      // index_only miss: return a hint, don't record it (see noIndexMatch).
      if (results.length === 0 && indexOnly) {
        return JSON.stringify(noIndexMatch(keyword));
      }

      // A content search miss with a sink is a recordable gap.
      if (results.length === 0 && !indexOnly && sink) {
        const now = new Date();
        const existing = sink.readAll(); // single parse; reused below
        // Record-time fan-out: simple-OR keyword becomes one event per
        // alternative; out-of-contract regex stays as one raw event.
        const topics = expandKeywordToTopics(keyword);
        const baseSeq = nextDailySeq(existing, now);
        const stamped: GapEvent[] = topics.map((kw, i) => ({
          source: "browser",
          gap_id: makeGapId(now, baseSeq + i),
          keyword: kw,
          scope: scope ?? null,
          timestamp: now.toISOString(),
          ...(query_id !== undefined ? { query_id } : {}),
        }));
        for (const e of stamped) sink.record(e);
        // Count the just-recorded gaps without a second full parse.
        const known = checkKnownGap([...existing, ...stamped], keyword);
        if (known) return JSON.stringify(known);
        // null = empty/whitespace keyword the sink skipped: fall through to empty results.
      }

      const out: ResultsResponse = {
        status: "results",
        hits: withDocTitles(results.slice(0, 20), manifest),
      };
      return JSON.stringify(out);
    }

    case "read_chunk": {
      const id = toolInput["id"] as string;
      const pattern = toolInput["pattern"] as string | undefined;
      const context = (toolInput["context"] as number | undefined) ?? 2;
      const content = await fetchChunk(id);
      // Container heading (empty stub) → hint, before pattern: a hint beats
      // grepChunk's "(no matches)" when there's no body to match against.
      if (!content.trim()) return CONTENTLESS_CHUNK_HINT;
      return pattern ? grepChunk(content, pattern, context) : content;
    }

    case "read_chunks": {
      const id = toolInput["id"] as string;
      const level = (toolInput["level"] as number | undefined) ?? 1;
      const chunks = expandWithContent(index, id, level);
      const previews = chunks.map(({ id: cid, content }) => ({
        id: cid,
        preview: content.split("\n").find((l) => l.trim()) ?? "",
      }));
      return JSON.stringify(previews);
    }

    case "parent": {
      const id = toolInput["id"] as string;
      return JSON.stringify(parent(id));
    }

    case "jump_to_ref": {
      const id = toolInput["id"] as string;
      const topK = (toolInput["top_k"] as number | undefined) ?? 5;
      const results = related(index, id, { topK });
      return JSON.stringify(withDocTitles(results, manifest));
    }

    case "reconstruct_document": {
      const docId = toolInput["doc_id"] as string;
      return reconstructDocument(index, docId);
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
