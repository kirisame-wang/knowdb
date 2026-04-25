import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import { search, fetchChunk, expand, expandWithContent, parent, grepChunk } from "../db_query.js";
import { SKILL } from "./skill.js";
import type { SearchIndex } from "../types.js";

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
    description: "Search the knowledge base by keyword (regex supported). Returns [{id, score, excerpt}] sorted by relevance. Always set scope once you know the target document. Use index_only:true to search heading trees only (fast navigation).",
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
];

// ── Tool dispatcher ───────────────────────────────────────────────────────────

export async function processToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  index: SearchIndex,
  manifest?: Record<string, { originalFilename: string; title: string }>
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
      return JSON.stringify(results.slice(0, 20));
    }

    case "read_chunk": {
      const id = toolInput["id"] as string;
      const pattern = toolInput["pattern"] as string | undefined;
      const context = (toolInput["context"] as number | undefined) ?? 2;
      const content = await fetchChunk(id);
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

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
