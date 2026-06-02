// Query Audit Trail — UI 層（軌跡可視化）。訂閱資料層 collector 的事件流，
// 投影為左 panel 的當前節點高亮 + footprint 列表。read-side only：不擁有
// trace、不持久化、不 mutate collector（spec-audit-trail-ui.md）。

/** Inline 截斷：超過 n 字元切到 n + 省略號（非 truncateOutput 的換行版）。 */
const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");

/** 當前定位 = 最近一次 read-class tool call 的目標 chunk id（spec §3, U2）。
 *  非 read-class（search 等）回 undefined，不更新高亮。 */
export function extractChunkId(tool: string, input: Record<string, unknown>): string | undefined {
  switch (tool) {
    case "read_chunk":
    case "read_chunks":
    case "parent":
    case "jump_to_ref":
      return typeof input.id === "string" ? input.id : undefined;
    case "read_index":
      return typeof input.doc_id === "string" ? `${input.doc_id}/_index` : undefined;
    default:
      return undefined;
  }
}

/** 一行人類友善的 input 摘要（spec §4, U5）。read_chunk 明示是否帶 pattern——
 *  把 OPEN-read-chunk-pattern-underuse 的 T15 議題 affordance-level 視覺化。
 *  空字串 pattern 視為「未帶」，與 read_chunk_pattern_usage_rate 的 truthy 檢查一致。 */
export function summarizeInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "search": {
      const kw = String(input.keyword ?? "");
      return input.scope ? `${kw}, scope=${String(input.scope)}` : kw;
    }
    case "read_chunk": {
      const id = String(input.id ?? "");
      return input.pattern ? `${id}, pattern="${truncate(String(input.pattern), 20)}"` : id;
    }
    case "read_chunks":
      return `${String(input.id ?? "")}, level=${String(input.level ?? "")}`;
    case "read_index":
      return String(input.doc_id ?? "");
    case "parent":
      return String(input.id ?? "");
    case "jump_to_ref":
      return `${String(input.id ?? "")}, top_k=${String(input.top_k ?? 3)}`;
    default:
      return truncate(JSON.stringify(input), 60);
  }
}
