import type { Tool } from "@anthropic-ai/sdk/resources/index.js";
import { search, fetchChunk, expand, parent } from "../db_query.js";
import type { SearchIndex } from "../types.js";

export const KNOWDB_TOOLS: Tool[] = [
  {
    name: "search",
    description: "在知識庫中搜尋關鍵字，回傳命中的 chunk id 清單（依出現次數降冪）",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        scope: {
          type: "string",
          description: "8 位 hex doc_id，限縮至單份文件（可省略）",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "read_chunk",
    description: "讀取指定 chunk 的文字內容",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "格式：<doc_id>/<chunk_id>，例如 a3f2b1c9/01-02",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "expand",
    description: "展開 chunk 上下文，回傳相關 chunk ids（不含內容，需再呼叫 read_chunk）",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        level: {
          type: "number",
          description: "1=siblings, 2=+parent, 3=完整文件，預設 1",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "parent",
    description: "取得 chunk 的上層 chunk id，若已是根節點則回傳 null",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
];

export async function processToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  index: SearchIndex
): Promise<string> {
  switch (toolName) {
    case "search": {
      const keyword = toolInput["keyword"] as string;
      const scope = toolInput["scope"] as string | undefined;
      const results = search(index, keyword, scope);
      return JSON.stringify(results.map((r) => r.id));
    }
    case "read_chunk": {
      const id = toolInput["id"] as string;
      return fetchChunk(id);
    }
    case "expand": {
      const id = toolInput["id"] as string;
      const level = (toolInput["level"] as number | undefined) ?? 1;
      const ids = expand(index, id, level);
      return JSON.stringify(ids);
    }
    case "parent": {
      const id = toolInput["id"] as string;
      return JSON.stringify(parent(id));
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
