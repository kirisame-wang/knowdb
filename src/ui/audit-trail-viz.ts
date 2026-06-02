// Query Audit Trail — UI 層（軌跡可視化）。訂閱資料層 collector 的事件流，
// 投影為左 panel 的當前節點高亮 + footprint 列表。read-side only：不擁有
// trace、不持久化、不 mutate collector（spec-audit-trail-ui.md）。

import type { TraceCollectorEvent } from "../traces.js";

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

// ── VizState reducer ──────────────────────────────────────────────────────

export interface FootprintEntry {
  ordinal: number;
  tool: string;
  input_summary: string;
  chunk_id?: string; // 若可從 input 推斷 (U2)
}

export interface VizState {
  current_query_id: string | null;
  current_node_chunk_id: string | null;
  footprint: FootprintEntry[];
  tokens: { input: number; output: number }; // U6: 累計自 api_round_added
}

export const initialState = (): VizState => ({
  current_query_id: null,
  current_node_chunk_id: null,
  footprint: [],
  tokens: { input: 0, output: 0 },
});

/** Pure reducer over the frozen TraceCollectorEvent stream (spec §2). The spec
 *  sketches in-place mutation; a pure reducer is the same behavior but unit-
 *  testable in isolation (same rationale as the data layer's loop extraction). */
export function reduce(state: VizState, e: TraceCollectorEvent): VizState {
  switch (e.kind) {
    case "query_start":
      return {
        current_query_id: e.query_id,
        current_node_chunk_id: null,
        footprint: [],
        tokens: { input: 0, output: 0 },
      };
    case "tool_call_added": {
      const chunk_id = extractChunkId(e.event.tool, e.event.input);
      const entry: FootprintEntry = {
        ordinal: e.event.ordinal,
        tool: e.event.tool,
        input_summary: summarizeInput(e.event.tool, e.event.input),
        ...(chunk_id !== undefined ? { chunk_id } : {}),
      };
      return {
        ...state,
        footprint: [...state.footprint, entry],
        current_node_chunk_id: chunk_id ?? state.current_node_chunk_id,
      };
    }
    case "api_round_added":
      return {
        ...state,
        tokens: {
          input: state.tokens.input + e.round.input_tokens,
          output: state.tokens.output + e.round.output_tokens,
        },
      };
    case "query_end":
      return state; // 保留至下一 query_start (U3)
  }
}

// ── DOM rendering + mount ─────────────────────────────────────────────────

/** 訂閱面：只需 subscribe（回傳 unsubscribe）。narrow 介面便於測試 stub。 */
interface SubscribableCollector {
  subscribe(cb: (e: TraceCollectorEvent) => void): () => void;
}

/** token ⓘ 的 hover 文字（U6）。renderFootprint 與 api_round 的 title-only 更新共用。 */
const tokenTitle = (s: VizState): string => `tokens — in ${s.tokens.input} / out ${s.tokens.output}`;

/** 在既有 heading tree / search 節點上 toggle 當前節點 class（既有節點為 <div>
 *  標 data-id，見 src/ui.ts:createChunkItem）。 */
function renderHighlight(state: VizState): void {
  const current = state.current_node_chunk_id;
  document.querySelectorAll<HTMLElement>(".chunk-item, .search-result-item").forEach((node) => {
    const isCurrent = node.dataset.id === current;
    node.classList.toggle("knowdb-current-node", isCurrent);
    if (isCurrent) {
      // chunk-item 預設收在折疊的 .chunk-list 內——展開其所屬 doc，讓高亮可見
      // （對齊 demo 的 doc-label 展開：.open 同時加在 .chunk-list 與其前面的 .doc-label）。
      const list = node.closest<HTMLElement>(".chunk-list");
      if (list) {
        list.classList.add("open");
        (list.previousElementSibling as HTMLElement | null)?.classList.add("open");
      }
      node.scrollIntoView?.({ block: "nearest" });
    }
  });
}

/** 渲染 footprint 列表 + token ⓘ 到 root。token 僅 native title（hover 才現），
 *  不渲染為常駐文字（U6 / UR6）。 */
function renderFootprint(
  state: VizState,
  root: HTMLElement,
  onJump: (chunkId: string) => void
): void {
  root.innerHTML = "";

  const head = document.createElement("div");
  head.className = "knowdb-footprint-head";
  head.textContent = "Footprint";
  const info = document.createElement("span");
  info.className = "knowdb-token-info";
  info.textContent = "ⓘ";
  info.title = tokenTitle(state);
  head.appendChild(info);

  const ol = document.createElement("ol");
  ol.className = "knowdb-footprint";
  for (const f of state.footprint) {
    const li = document.createElement("li");
    li.dataset.ordinal = String(f.ordinal);
    const ord = document.createElement("span");
    ord.className = "ord";
    ord.textContent = `[${f.ordinal}]`;
    const tool = document.createElement("span");
    tool.className = "tool";
    tool.textContent = f.tool;
    const summary = document.createElement("span");
    summary.className = "summary";
    summary.textContent = f.input_summary;
    li.append(ord, document.createTextNode(" "), tool, document.createTextNode(" "), summary);
    if (f.chunk_id) {
      const chunkId = f.chunk_id;
      li.dataset.chunkId = chunkId;
      li.addEventListener("click", () => onJump(chunkId));
    }
    ol.appendChild(li);
  }

  root.append(head, ol);
}

/** api_round 的 title-only 更新（§2：footprint 不變，僅更新 ⓘ 的 title）。 */
function updateTokenTitle(state: VizState, footprintRoot: HTMLElement): void {
  const info = footprintRoot.querySelector<HTMLElement>(".knowdb-token-info");
  if (info) info.title = tokenTitle(state);
}

/** 訂閱 collector，把事件流投影為左 panel 的高亮 + footprint。回傳 teardown
 *  fn（每個 subscribe 配對 unsubscribe，U8）。onSelect（可選）讓 footprint 點擊
 *  亦載入預覽——由 caller 注入 demo 的 selectChunk，viz 不直接耦合 demo（C4）。 */
export function mount(
  collector: SubscribableCollector,
  footprintRoot: HTMLElement,
  onSelect?: (chunkId: string) => void
): () => void {
  let state = initialState();
  const onJump = (chunkId: string): void => {
    state = { ...state, current_node_chunk_id: chunkId }; // read-side only — 不 mutate trace
    renderHighlight(state); // §5: 移動當前節點高亮
    onSelect?.(chunkId); // C4: 點擊亦載入預覽（注入 selectChunk）
  };
  const renderFull = (): void => {
    renderHighlight(state);
    renderFootprint(state, footprintRoot, onJump);
  };
  renderFull();
  // 按事件種類分派渲染粒度（§2）：query_start / tool_call_added 重繪足跡，
  // api_round_added 僅更新 token title，query_end noop。
  const unsubscribe = collector.subscribe((e) => {
    state = reduce(state, e);
    switch (e.kind) {
      case "query_start":
      case "tool_call_added":
        renderFull();
        break;
      case "api_round_added":
        updateTokenTitle(state, footprintRoot);
        break;
      case "query_end":
        break;
    }
  });
  return () => unsubscribe();
}
