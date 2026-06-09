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
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal | undefined }
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
  /** User cancel (Stop): aborts the in-flight request, stops at the next round boundary. */
  signal?: AbortSignal;
  /** Benchmark ablation hook: transforms a successful tool result before it is
   *  recorded and sent to the agent. Absent in normal use (identity). */
  ablation?: (toolName: string, result: string) => string;
}

export interface AgentLoopHooks {
  onUserMessage?(text: string): void;
  onThinkingStart?(): void;
  onToolsStart?(): void;
  onToolCall?(toolName: string, input: unknown, result: string): void;
  onAssistantMessage?(text: string): void;
  onError?(err: unknown): void;
  onAbort?(): void;
}

/** Drive one user→final-answer turn: stamp the trace, run the tool-use loop,
 *  flush on completion (or error). Returns the finalized QueryTrace, or
 *  undefined when the catch-path collector itself failed (rare; e.g. a
 *  buggy custom TraceCollector). The agent loop never re-throws. */
export async function runAgentTurn(
  deps: AgentLoopDeps,
  userText: string
): Promise<QueryTrace | undefined> {
  const now = deps.now ?? (() => new Date());
  const query_id = deps.collector.startQuery(userText, now());

  deps.chatHistory.push({ role: "user", content: userText });
  deps.hooks?.onUserMessage?.(userText);
  deps.hooks?.onThinkingStart?.();

  let trace: QueryTrace | undefined;
  try {
    // Tool-use agentic loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Safe abort point: chatHistory ends on a complete turn here, so no
      // dangling tool_use is left behind. Catches a Stop during tool execution.
      if (deps.signal?.aborted) {
        deps.hooks?.onAbort?.();
        trace = deps.collector.abortQuery(query_id, now());
        break;
      }
      const apiT0 = Date.now();
      const response = await deps.client.messages.create(
        {
          model: deps.model,
          max_tokens: deps.maxTokens,
          system: deps.system,
          tools: deps.tools,
          messages: deps.chatHistory,
        },
        { signal: deps.signal }
      );
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
        // A tool throwing must not kill the turn — surface it as an is_error
        // tool_result so the agent can react. Only messages.create stays fatal.
        let result: string;
        let isError = false;
        try {
          result = await processToolCall(
            block.name,
            input,
            deps.searchIndex,
            deps.manifest,
            deps.gapSink,
            query_id
          );
        } catch (err) {
          isError = true;
          result = err instanceof Error ? err.message : String(err);
          deps.hooks?.onError?.(err);
        }
        // Ablation (benchmark only): transform a successful result before it is
        // recorded and surfaced; errors skip it.
        if (!isError && deps.ablation) {
          result = deps.ablation(block.name, result);
        }
        deps.collector.recordToolCall(query_id, {
          tool: block.name,
          input,
          output_summary: truncateOutput(result),
          output_chars: result.length,
          ...(isError && { is_error: true }),
          duration_ms: Date.now() - tcT0,
          timestamp: now().toISOString(),
        });
        deps.hooks?.onToolCall?.(block.name, input, result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
          ...(isError && { is_error: true }),
        });
      }
      deps.chatHistory.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    // Classify by signal state, not error identity: an aborted signal means
    // the user cancelled, so record it as a cancel (abortQuery), not an error.
    const aborted = deps.signal?.aborted ?? false;
    if (aborted) deps.hooks?.onAbort?.();
    else deps.hooks?.onError?.(err);
    try {
      trace = aborted
        ? deps.collector.abortQuery(query_id, now())
        : deps.collector.endQuery(query_id, undefined, err instanceof Error ? err.message : String(err), now());
    } catch {
      // Collector itself failed; trace is unrecoverable. Original err is
      // already reported via onError above.
    }
  }

  // Observability sink is best-effort: a full localStorage must not surface
  // as an agent-loop failure. Hook reports it so the UI can prompt export.
  if (trace) {
    try {
      deps.traceSink.flush(trace);
    } catch (err) {
      deps.hooks?.onError?.(err);
    }
  }

  return trace;
}
