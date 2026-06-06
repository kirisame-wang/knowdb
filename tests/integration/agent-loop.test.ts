import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn, type AgentLoopDeps, type MessagesClient } from "../../src/agent/loop.js";
import { KNOWDB_TOOLS } from "../../src/agent/tools.js";
import { SKILL } from "../../src/agent/skill.js";
import { BrowserGapSink } from "../../src/gaps.js";
import { BrowserTraceCollector, BrowserTraceSink } from "../../src/traces.js";
import { SessionContext, parseJsonl } from "../../src/utils.js";
import type { GapEvent, Manifest, QueryTrace, SearchIndex } from "../../src/types.js";

// In-memory KeyValueStore — mirrors localStorage for both sinks.
class FakeKV {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const INDEX: SearchIndex = {
  "aaa00001/_index": "# aaa00001 Index\n- 00: intro\n- 01: BM25",
  "aaa00001/00": "intro to BM25 ranking",
  "aaa00001/01": "BM25 is a retrieval function",
};
const MANIFEST: Manifest = {
  aaa00001: { originalFilename: "ir.md", title: "Information Retrieval" },
};

// Script a sequence of stub responses — one per messages.create call.
function scriptedClient(responses: Anthropic.Messages.Message[]): MessagesClient {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= responses.length) throw new Error("scriptedClient: ran out of responses");
        return responses[i++]!;
      },
    },
  };
}

const text = (s: string): Anthropic.Messages.TextBlock => ({ type: "text", text: s, citations: null });
const toolUse = (id: string, name: string, input: object): Anthropic.Messages.ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const msg = (
  content: (Anthropic.Messages.TextBlock | Anthropic.Messages.ToolUseBlock)[],
  inTok = 50,
  outTok = 20
): Anthropic.Messages.Message => ({
  id: "msg_" + Math.random().toString(36).slice(2, 10),
  type: "message",
  role: "assistant",
  model: "stub",
  content,
  stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: inTok,
    output_tokens: outTok,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Messages.Usage,
});

function makeDeps(
  client: MessagesClient,
  session = new SessionContext("sess-int-1")
): AgentLoopDeps & { traceKV: FakeKV; gapKV: FakeKV } {
  const traceKV = new FakeKV();
  const gapKV = new FakeKV();
  return {
    client,
    collector: new BrowserTraceCollector(session),
    traceSink: new BrowserTraceSink(traceKV),
    gapSink: new BrowserGapSink(gapKV, "knowdb-gaps", session),
    searchIndex: INDEX,
    manifest: MANIFEST,
    model: "stub-model",
    system: "stub-system",
    tools: KNOWDB_TOOLS,
    maxTokens: 1024,
    chatHistory: [],
    traceKV,
    gapKV,
  };
}

describe("runAgentTurn — integration", () => {
  it("completes a search→parent→answer flow and flushes one QueryTrace", async () => {
    // search + parent are both pure (no fetch); read_chunk needs network so
    // is exercised in unit tests against db_query directly.
    const client = scriptedClient([
      msg([text("looking it up"), toolUse("tu_1", "search", { keyword: "BM25" })], 100, 30),
      msg([toolUse("tu_2", "parent", { id: "aaa00001/01" })], 80, 25),
      msg([text("BM25 is a retrieval function.")], 60, 15),
    ]);
    const deps = makeDeps(client);

    const trace = (await runAgentTurn(deps, "What is BM25?"))!;

    expect(trace.source).toBe("browser");
    expect(trace.user_question).toBe("What is BM25?");
    expect(trace.final_answer).toBe("BM25 is a retrieval function.");
    expect(trace.error).toBeUndefined();
    expect(trace.tool_calls.map((c) => [c.ordinal, c.tool])).toEqual([
      [1, "search"],
      [2, "parent"],
    ]);
    expect(trace.api_rounds.map((r) => [r.ordinal, r.input_tokens, r.output_tokens])).toEqual([
      [1, 100, 30],
      [2, 80, 25],
      [3, 60, 15],
    ]);

    const persisted = parseJsonl<QueryTrace>(deps.traceKV.getItem("knowdb-traces") ?? "");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.query_id).toBe(trace.query_id);
  });

  it("zero-result search stamps GapEvent.query_id matching QueryTrace.query_id (cross-stream join)", async () => {
    const client = scriptedClient([
      msg([toolUse("tu_1", "search", { keyword: "absent_xyz_int" })]),
      msg([text("No results found.")]),
    ]);
    const deps = makeDeps(client);

    const trace = (await runAgentTurn(deps, "Tell me about absent_xyz_int"))!;

    const gaps = parseJsonl<GapEvent>(deps.gapKV.getItem("knowdb-gaps") ?? "");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.query_id).toBe(trace.query_id);
    expect(gaps[0]!.session_id).toBe("sess-int-1");
    expect(trace.session_id).toBe("sess-int-1");
  });

  // A tool throwing (e.g. read_chunk hitting a 404) must NOT kill the turn:
  // the loop converts it into an is_error tool_result so the agent can react.
  it("tool exception becomes an is_error tool_result and the turn survives", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    try {
      const client = scriptedClient([
        msg([toolUse("tu_1", "read_chunk", { id: "aaa00001/99" })]),
        msg([text("That section is missing; trying another route.")]),
      ]);
      const deps = makeDeps(client);

      const trace = (await runAgentTurn(deps, "read a missing chunk"))!;

      // Turn survived the tool throw: a final answer was produced, no fatal error.
      expect(trace.error).toBeUndefined();
      expect(trace.final_answer).toContain("another route");
      expect(trace.tool_calls).toHaveLength(1);

      // The failure reached the agent as an is_error tool_result, not a dead turn.
      const toolResultTurn = deps.chatHistory.find(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((b) => (b as { type: string }).type === "tool_result")
      )!;
      const block = (toolResultTurn.content as Anthropic.Messages.ToolResultBlockParam[]).find(
        (b) => b.type === "tool_result"
      )!;
      expect(block.is_error).toBe(true);
      expect(String(block.content)).toMatch(/read_index|re-locate|stale/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mid-flow client error: trace records error, omits final_answer, still flushes", async () => {
    const client: MessagesClient = {
      messages: {
        create: async () => {
          throw new Error("network down");
        },
      },
    };
    const deps = makeDeps(client);

    const trace = (await runAgentTurn(deps, "Q during outage"))!;
    expect(trace.final_answer).toBeUndefined();
    expect(trace.error).toBe("network down");

    const persisted = parseJsonl<QueryTrace>(deps.traceKV.getItem("knowdb-traces") ?? "");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.error).toBe("network down");
  });

  // A trace subscriber crashing must not break the agent loop or corrupt
  // the trace sink. The collector isolates subscriber errors so endQuery
  // still returns the assembled trace.
  it("throwing subscriber on query_end: trace still returned and flushed cleanly", async () => {
    const client = scriptedClient([msg([text("Done.")])]);
    const deps = makeDeps(client);
    deps.collector.subscribe((e) => {
      if (e.kind === "query_end") throw new Error("subscriber boom");
    });

    const trace = (await runAgentTurn(deps, "Q"))!;
    expect(trace.final_answer).toBe("Done.");

    const raw = deps.traceKV.getItem("knowdb-traces") ?? "";
    expect(raw).not.toContain("undefined");
    const persisted = parseJsonl<QueryTrace>(raw);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.query_id).toBe(trace.query_id);
  });

  // Defensive: even if a custom TraceCollector throws on endQuery in the
  // catch path (no trace assembled), runAgentTurn must not flush a
  // null/undefined trace and corrupt the JSONL.
  it("catch-path endQuery failure: no garbage in trace sink", async () => {
    const client: MessagesClient = {
      messages: {
        create: async () => {
          throw new Error("network down");
        },
      },
    };
    const deps = makeDeps(client);
    // Force the catch-path endQuery to throw by stubbing it.
    const realEndQuery = deps.collector.endQuery.bind(deps.collector);
    let endQueryCalls = 0;
    deps.collector.endQuery = ((qid: string, fa?: string, err?: string, now?: Date) => {
      endQueryCalls++;
      if (err !== undefined) throw new Error("collector boom");
      return realEndQuery(qid, fa, err, now);
    }) as typeof deps.collector.endQuery;

    await runAgentTurn(deps, "Q during outage");
    expect(endQueryCalls).toBe(1); // the catch-path call

    const raw = deps.traceKV.getItem("knowdb-traces") ?? "";
    expect(raw).toBe(""); // no flush attempted with an undefined trace
  });

  it("hooks fire in order for the happy path", async () => {
    const client = scriptedClient([
      msg([toolUse("tu_1", "search", { keyword: "BM25" })]),
      msg([text("Done.")]),
    ]);
    const deps = makeDeps(client);
    const log: string[] = [];
    let toolArgs: { name: string; input: unknown; result: string } | null = null;
    deps.hooks = {
      onUserMessage: (t) => log.push(`user:${t}`),
      onThinkingStart: () => log.push("thinking"),
      onToolsStart: () => log.push("tools"),
      onToolCall: (name, input, result) => {
        log.push(`tool:${name}`);
        toolArgs = { name, input, result };
      },
      onAssistantMessage: (t) => log.push(`asst:${t}`),
    };

    await runAgentTurn(deps, "Q");
    expect(log).toEqual(["user:Q", "thinking", "tools", "tool:search", "asst:Done."]);
    // onToolCall delivers the live input and raw result, not just the name.
    expect(toolArgs).toEqual({ name: "search", input: { keyword: "BM25" }, result: expect.any(String) });
  });

  it("records raw output_chars (pre-truncation) and clock-stamped timestamps", async () => {
    // get_instructions returns SKILL (>600 chars), so the raw output_chars and
    // the truncated output_summary must differ — guards output_chars wiring.
    const client = scriptedClient([
      msg([toolUse("tu_1", "get_instructions", {})]),
      msg([text("ok")]),
    ]);
    const deps = makeDeps(client);
    let t = Date.parse("2026-05-16T10:00:00Z");
    deps.now = () => {
      const d = new Date(t);
      t += 1000;
      return d;
    };

    const trace = (await runAgentTurn(deps, "How do I use the tools?"))!;

    const tc = trace.tool_calls[0]!;
    expect(tc.output_chars).toBe(SKILL.length);
    expect(tc.output_summary.length).toBeLessThan(tc.output_chars!);
    expect(tc.duration_ms).toBeGreaterThanOrEqual(0);
    // Injected clock stamps start → tool → end on successive ticks.
    expect(trace.started_at).toBe("2026-05-16T10:00:00.000Z");
    expect(tc.timestamp).toBe("2026-05-16T10:00:01.000Z");
    expect(trace.ended_at).toBe("2026-05-16T10:00:02.000Z");
  });

  // ── User-side cancel (Stop button) ──────────────────────────────────────
  // The UI passes an AbortSignal; clicking Stop fires it. A cancelled turn is
  // recorded as the QueryTrace "interrupted" state — no final_answer, no error
  // — so metrics never count a user stop as a failed query.

  it("abort in-flight (SDK throws after signal fires): recorded as cancel, not error", async () => {
    const controller = new AbortController();
    // Models the Anthropic SDK: an aborted request rejects with APIUserAbortError.
    const client: MessagesClient = {
      messages: {
        create: async (_params, options) => {
          controller.abort();
          const err = new Error("Request was aborted.");
          err.name = "APIUserAbortError";
          void options;
          throw err;
        },
      },
    };
    const deps = makeDeps(client);
    deps.signal = controller.signal;
    const events: string[] = [];
    deps.hooks = {
      onAbort: () => events.push("abort"),
      onError: () => events.push("error"),
    };

    const trace = (await runAgentTurn(deps, "stop me"))!;

    expect(trace.final_answer).toBeUndefined();
    expect(trace.error).toBeUndefined();
    expect(trace.aborted).toBe(true); // distinct outcome, not inferred from absence
    expect(events).toEqual(["abort"]); // onAbort fired, onError did NOT
    // The partial trace still flushes — the steps taken so far are real data.
    const persisted = parseJsonl<QueryTrace>(deps.traceKV.getItem("knowdb-traces") ?? "");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.aborted).toBe(true);
    expect(persisted[0]!.error).toBeUndefined();
  });

  it("abort between rounds: stops at the round boundary, chatHistory stays well-formed", async () => {
    const controller = new AbortController();
    // Round 1 returns a tool_use and trips the abort (models the user clicking
    // Stop while the local tool runs). Round 2 must never be issued.
    const client: MessagesClient = (() => {
      let i = 0;
      const responses = [
        msg([toolUse("tu_1", "search", { keyword: "BM25" })]),
        msg([text("should never be reached")]),
      ];
      return {
        messages: {
          create: async () => {
            const r = responses[i++]!;
            if (i === 1) controller.abort(); // abort during/after round 1
            return r;
          },
        },
      };
    })();
    const deps = makeDeps(client);
    deps.signal = controller.signal;
    let aborts = 0;
    deps.hooks = { onAbort: () => aborts++ };

    const trace = (await runAgentTurn(deps, "Q"))!;

    expect(trace.final_answer).toBeUndefined();
    expect(trace.error).toBeUndefined();
    expect(trace.aborted).toBe(true);
    expect(aborts).toBe(1);
    // Only round 1 ran; the loop broke before issuing round 2.
    expect(trace.api_rounds).toHaveLength(1);
    expect(trace.tool_calls.map((c) => c.tool)).toEqual(["search"]);
    // chatHistory ends on a complete tool_result turn — a following turn's
    // messages.create would not 400 on a dangling tool_use.
    const last = deps.chatHistory[deps.chatHistory.length - 1]!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    expect(
      (last.content as Anthropic.Messages.ToolResultBlockParam[]).every((b) => b.type === "tool_result")
    ).toBe(true);
  });

  it("passes the abort signal through to messages.create", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const client: MessagesClient = {
      messages: {
        create: async (_params, options) => {
          seenSignal = options?.signal;
          return msg([text("done")]);
        },
      },
    };
    const deps = makeDeps(client);
    deps.signal = controller.signal;

    await runAgentTurn(deps, "Q");
    expect(seenSignal).toBe(controller.signal);
  });

  it("two tool_use blocks in one response: both recorded, ordinals in block order", async () => {
    const client = scriptedClient([
      msg([
        toolUse("tu_1", "search", { keyword: "BM25" }),
        toolUse("tu_2", "parent", { id: "aaa00001/01" }),
      ]),
      msg([text("Done.")]),
    ]);
    const deps = makeDeps(client);

    const trace = (await runAgentTurn(deps, "Q"))!;

    // One round fans out two tool calls; ordinals follow block order.
    expect(trace.tool_calls.map((c) => [c.ordinal, c.tool])).toEqual([
      [1, "search"],
      [2, "parent"],
    ]);
    expect(trace.tool_calls.every((c) => typeof c.output_chars === "number")).toBe(true);
    expect(trace.api_rounds).toHaveLength(2);
  });
});
