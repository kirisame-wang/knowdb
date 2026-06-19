// Live side-by-side ablation compare — one lane per arm. Each lane subscribes to
// its arm's trace collector and renders the event stream as a mini main-UI chat.
// Read-only — it never feeds back into the agent. Reuses the main UI's
// .chat-bubble / .tool-trace styling; only the lane header is new.

import type { TraceCollectorEvent } from "../traces.js";
import { isContextOverflowError } from "../utils.js";
import { buildBubble, buildToolTrace } from "./chat-dom.js";

export type LaneStatus = "idle" | "running" | "answered" | "overflow" | "aborted" | "errored";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "tool"; ordinal: number; tool: string; input: Record<string, unknown>; result: string }
  | { kind: "answer"; text: string }
  | { kind: "overflow"; text: string }
  | { kind: "aborted"; text: string }
  | { kind: "errored"; text: string };

export interface LaneState {
  variant: string;
  items: ChatItem[];
  toolCalls: number;
  status: LaneStatus;
  tokens: { input: number; output: number };
}

export const initialLane = (variant: string): LaneState => ({
  variant,
  items: [],
  toolCalls: 0,
  status: "idle",
  tokens: { input: 0, output: 0 },
});

/** Pure reducer over the collector's event stream — kept pure so lane state
 *  transitions are unit-testable without a DOM. Chat items come straight from the
 *  raw events (tool result = output_summary, answer = trace.final_answer). */
export function reduceLane(state: LaneState, e: TraceCollectorEvent): LaneState {
  switch (e.kind) {
    case "query_start":
      return { ...state, status: "running", items: [...state.items, { kind: "user", text: e.user_question }] };
    case "tool_call_added":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "tool", ordinal: e.event.ordinal, tool: e.event.tool, input: e.event.input, result: e.event.output_summary },
        ],
        toolCalls: state.toolCalls + 1,
      };
    case "api_round_added":
      return {
        ...state,
        tokens: {
          input: state.tokens.input + e.round.input_tokens,
          output: state.tokens.output + e.round.output_tokens,
        },
      };
    case "query_end": {
      const t = e.trace;
      // A finished trace carries one terminal outcome — the collector sets aborted,
      // or error, or final_answer, never together — so this ladder is defensive.
      if (t.error && isContextOverflowError(t.error))
        return { ...state, items: [...state.items, { kind: "overflow", text: "ran out of context — no answer" }], status: "overflow" };
      if (t.aborted)
        return { ...state, items: [...state.items, { kind: "aborted", text: "stopped" }], status: "aborted" };
      if (t.error)
        // A non-overflow error (e.g. a bad key): keep the lane honest rather than
        // labelling it answered with no answer.
        return { ...state, items: [...state.items, { kind: "errored", text: t.error }], status: "errored" };
      if (t.final_answer)
        return { ...state, items: [...state.items, { kind: "answer", text: t.final_answer }], status: "answered" };
      return { ...state, status: "answered" }; // clean end, no answer text (degenerate, rare)
    }
  }
}

// ── DOM rendering ─────────────────────────────────────────────────────────

const STATUS_TEXT: Record<LaneStatus, string> = {
  idle: "ready",
  running: "running…",
  answered: "answered",
  overflow: "overflow · no answer",
  aborted: "stopped",
  errored: "error · no answer",
};

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const tokenTitle = (s: LaneState, pricing?: Pricing): string => {
  // "this lane", not "this query": the lane is reused across follow-ups, so the
  // total is cumulative over the whole conversation, not the latest turn.
  const base = `this lane — tokens in ${s.tokens.input} / out ${s.tokens.output}`;
  if (!pricing) return base;
  const cost = (s.tokens.input * pricing.inputPerMTok + s.tokens.output * pricing.outputPerMTok) / 1_000_000;
  return `${base}\nest. cost — $${cost.toFixed(4)}`;
};

const div = (cls: string, text?: string): HTMLDivElement => {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

/** Render the lane (header + mini chat) into columnEl, replacing its contents.
 *  The body reuses the shared chat builders; output_summary is already capped, so
 *  it is passed through without extra truncation. */
export function renderColumn(state: LaneState, columnEl: HTMLElement, pricing?: Pricing, hint?: string): void {
  columnEl.innerHTML = "";

  const head = div("lane-head");
  const name = div("lane-name", state.variant);
  if (hint) {
    // An explicit ⓘ next to the name carries the arm's tools / ablation on hover —
    // a clearer affordance than a tooltip on the bare name.
    const info = document.createElement("span");
    info.className = "lane-info";
    info.textContent = "ⓘ";
    info.title = hint;
    name.appendChild(info);
  }
  head.appendChild(name);
  const status = div("lane-status");
  const badge = document.createElement("span");
  badge.className = `badge ${state.status}`;
  badge.textContent = STATUS_TEXT[state.status];
  const steps = document.createElement("span");
  steps.textContent = `${state.toolCalls} tool calls`;
  const tok = document.createElement("span");
  tok.className = "tok";
  tok.textContent = "ⓘ";
  tok.title = tokenTitle(state, pricing);
  status.append(badge, steps, tok);
  head.appendChild(status);

  const chat = div("chat-messages");
  const lastToolIdx = state.items.map((i) => i.kind).lastIndexOf("tool");
  state.items.forEach((it, idx) => {
    switch (it.kind) {
      case "user":
        chat.appendChild(buildBubble("user", it.text));
        break;
      case "tool":
        chat.appendChild(buildToolTrace(it.tool, it.input, it.result, { open: idx === lastToolIdx }));
        break;
      case "answer":
        chat.appendChild(buildBubble("assistant", it.text));
        break;
      case "overflow":
        chat.appendChild(div("status-text overflow", it.text));
        break;
      case "aborted":
        chat.appendChild(div("status-text", it.text));
        break;
      case "errored":
        chat.appendChild(div("status-text overflow", it.text));
        break;
    }
  });

  columnEl.append(head, chat);
  chat.scrollTop = chat.scrollHeight;
}

// ── Mount ─────────────────────────────────────────────────────────────────

interface SubscribableCollector {
  subscribe(cb: (e: TraceCollectorEvent) => void): () => void;
}

/** Subscribe one arm's collector and project its event stream into columnEl as a
 *  live mini-chat. Returns a teardown (unsubscribe). Read-only. */
export function mountLane(
  variant: string,
  collector: SubscribableCollector,
  columnEl: HTMLElement,
  pricing?: Pricing,
  hint?: string,
): () => void {
  let state = initialLane(variant);
  renderColumn(state, columnEl, pricing, hint);
  const unsubscribe = collector.subscribe((e) => {
    state = reduceLane(state, e);
    renderColumn(state, columnEl, pricing, hint);
  });
  return () => unsubscribe();
}
