import type Anthropic from "@anthropic-ai/sdk";
import { processToolCall } from "./tools.js";
import type { GapSink } from "../gaps.js";
import type { TraceCollector, TraceSink } from "../traces.js";
import { truncateOutput } from "../utils.js";
import type { Manifest, QueryTrace, SearchIndex } from "../types.js";

/** Subset of the Anthropic SDK surface this loop uses — keeps the loop
 *  testable with a stub instead of the live client. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Messages.Message>;
  };
}

export interface AgentLoopDeps {
  client: MessagesClient;
  collector: TraceCollector;
  traceSink: TraceSink;
  gapSink: GapSink;
  searchIndex: SearchIndex;
  manifest: Manifest;
  model: string;
  system: string;
  tools: Anthropic.Messages.Tool[];
  maxTokens: number;
  /** Mutable conversation history; the loop pushes user/assistant turns. */
  chatHistory: Anthropic.Messages.MessageParam[];
  hooks?: AgentLoopHooks;
  /** Injectable clock for deterministic tests. Defaults to Date.now/new Date. */
  now?: () => Date;
}

export interface AgentLoopHooks {
  onUserMessage?(text: string): void;
  onThinkingStart?(): void;
  onToolsStart?(): void;
  onToolCall?(toolName: string, input: unknown, result: string): void;
  onAssistantMessage?(text: string): void;
  onError?(err: unknown): void;
}

/** Drive one user→final-answer turn: stamp the trace, run the tool-use loop,
 *  flush on completion (or error). Returns the finalized QueryTrace. */
export async function runAgentTurn(
  deps: AgentLoopDeps,
  userText: string
): Promise<QueryTrace> {
  const now = deps.now ?? (() => new Date());
  const query_id = deps.collector.startQuery(userText, now());

  deps.chatHistory.push({ role: "user", content: userText });
  deps.hooks?.onUserMessage?.(userText);
  deps.hooks?.onThinkingStart?.();

  let trace: QueryTrace;
  try {
    // Tool-use agentic loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const apiT0 = Date.now();
      const response = await deps.client.messages.create({
        model: deps.model,
        max_tokens: deps.maxTokens,
        system: deps.system,
        tools: deps.tools,
        messages: deps.chatHistory,
      });
      deps.collector.recordApiRound(query_id, {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        duration_ms: Date.now() - apiT0,
      });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        const finalText = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        deps.chatHistory.push({ role: "assistant", content: response.content });
        deps.hooks?.onAssistantMessage?.(finalText);
        trace = deps.collector.endQuery(query_id, finalText, undefined, now());
        break;
      }

      deps.hooks?.onToolsStart?.();
      deps.chatHistory.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const tcT0 = Date.now();
        const input = block.input as Record<string, unknown>;
        const result = await processToolCall(
          block.name,
          input,
          deps.searchIndex,
          deps.manifest,
          deps.gapSink,
          query_id
        );
        deps.collector.recordToolCall(query_id, {
          tool: block.name,
          input,
          output_summary: truncateOutput(result),
          duration_ms: Date.now() - tcT0,
          timestamp: now().toISOString(),
        });
        deps.hooks?.onToolCall?.(block.name, input, result);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      deps.chatHistory.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace = deps.collector.endQuery(query_id, undefined, msg, now());
    deps.hooks?.onError?.(err);
  }

  // Observability sink is best-effort: a full localStorage must not surface
  // as an agent-loop failure. Hook reports it so the UI can prompt export.
  try {
    deps.traceSink.flush(trace);
  } catch (err) {
    deps.hooks?.onError?.(err);
  }

  return trace;
}
