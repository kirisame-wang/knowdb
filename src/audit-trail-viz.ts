// Query Audit Trail UI: subscribes to the trace collector's event stream and
// projects it onto the left panel (current-node highlight + footprint list).
// Read-side only — never owns, persists, or mutates the trace.

import type { TraceCollectorEvent } from "./traces.js";

/** Inline truncation to n chars with an ellipsis. */
const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");

/** Current location = the target chunk id of the latest read-class tool call.
 *  Non-read tools (search, etc.) return undefined and don't move the highlight. */
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

/** One-line, human-readable summary of a tool call's input. For read_chunk it
 *  surfaces whether a pattern was used; an empty-string pattern counts as
 *  not-used, matching the tool's own truthy check. */
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
  chunk_id?: string; // set when derivable from the tool input
}

export interface VizState {
  current_query_id: string | null;
  current_node_chunk_id: string | null;
  footprint: FootprintEntry[];
  tokens: { input: number; output: number }; // accumulated from api-round events
}

export const initialState = (): VizState => ({
  current_query_id: null,
  current_node_chunk_id: null,
  footprint: [],
  tokens: { input: 0, output: 0 },
});

/** Pure reducer over the collector's event stream — kept pure (rather than
 *  mutating in place) so state transitions are unit-testable without a DOM. */
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
      return state; // footprint retained until the next query_start
  }
}

// ── DOM rendering + mount ─────────────────────────────────────────────────

/** Subscribe-only view of the collector (returns an unsubscribe). Narrowed so
 *  tests can stub it. */
interface SubscribableCollector {
  subscribe(cb: (e: TraceCollectorEvent) => void): () => void;
}

export interface Pricing {
  inputPerMTok: number; // USD per 1M input tokens
  outputPerMTok: number; // USD per 1M output tokens
}

/** Hover text for the token ⓘ. Scoped to the current query (tokens reset each
 *  query, so this is not a session total). Adds an estimated-cost line when
 *  pricing is supplied. */
const tokenTitle = (s: VizState, pricing?: Pricing): string => {
  const base = `this query — tokens in ${s.tokens.input} / out ${s.tokens.output}`;
  if (!pricing) return base;
  const cost = (s.tokens.input * pricing.inputPerMTok + s.tokens.output * pricing.outputPerMTok) / 1_000_000;
  return `${base}\nest. cost — $${cost.toFixed(4)}`;
};

/** Toggle the current-node class on the existing tree/search nodes (which are
 *  <div>s tagged with data-id). */
function renderHighlight(state: VizState): void {
  const current = state.current_node_chunk_id;
  document.querySelectorAll<HTMLElement>(".chunk-item, .search-result-item").forEach((node) => {
    const isCurrent = node.dataset.id === current;
    node.classList.toggle("knowdb-current-node", isCurrent);
    if (isCurrent) {
      // Expand the containing doc so the highlight is visible (the chunk list is
      // collapsed by default; mirror the demo's doc-label toggle).
      const list = node.closest<HTMLElement>(".chunk-list");
      if (list) {
        list.classList.add("open");
        (list.previousElementSibling as HTMLElement | null)?.classList.add("open");
      }
      node.scrollIntoView?.({ block: "nearest" });
    }
  });
}

/** Render the footprint list + token ⓘ into root. The token total is hover-only
 *  (native title), never standing text. */
function renderFootprint(
  state: VizState,
  root: HTMLElement,
  onJump: (chunkId: string) => void,
  pricing?: Pricing
): void {
  root.innerHTML = "";

  const head = document.createElement("div");
  head.className = "knowdb-footprint-head";
  head.textContent = "Footprint";
  const info = document.createElement("span");
  info.className = "knowdb-token-info";
  info.textContent = "ⓘ";
  info.title = tokenTitle(state, pricing);
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

/** Update only the token ⓘ title; api rounds don't change the footprint. */
function updateTokenTitle(state: VizState, footprintRoot: HTMLElement, pricing?: Pricing): void {
  const info = footprintRoot.querySelector<HTMLElement>(".knowdb-token-info");
  if (info) info.title = tokenTitle(state, pricing);
}

/** Subscribe to the collector and project events onto the left panel. Returns a
 *  teardown (unsubscribe). onSelect — optional, injected by the caller — lets a
 *  footprint click or navigation open the chunk preview without coupling the viz
 *  to the demo. */
export function mount(
  collector: SubscribableCollector,
  footprintRoot: HTMLElement,
  onSelect?: (chunkId: string) => void,
  pricing?: Pricing
): () => void {
  let state = initialState();
  const onJump = (chunkId: string): void => {
    state = { ...state, current_node_chunk_id: chunkId };
    renderHighlight(state);
    onSelect?.(chunkId); // also open the preview
  };
  const renderFull = (): void => {
    renderHighlight(state);
    renderFootprint(state, footprintRoot, onJump, pricing);
  };
  renderFull();
  // Render granularity per event kind: query_start / tool_call_added redraw the
  // footprint; api_round_added updates only the token title; query_end is a noop.
  const unsubscribe = collector.subscribe((e) => {
    const prevNode = state.current_node_chunk_id;
    state = reduce(state, e);
    switch (e.kind) {
      case "query_start":
        renderFull();
        break;
      case "tool_call_added":
        renderFull();
        // Auto-open the preview for the chunk the agent just read.
        if (state.current_node_chunk_id && state.current_node_chunk_id !== prevNode) {
          onSelect?.(state.current_node_chunk_id);
        }
        break;
      case "api_round_added":
        updateTokenTitle(state, footprintRoot, pricing);
        break;
      case "query_end":
        break;
    }
  });
  return () => unsubscribe();
}
