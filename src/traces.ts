import type {
  ApiRoundUsage,
  LocalCommandEvent,
  LocalSessionMetrics,
  QueryTrace,
  ToolCallEvent,
  TraceMetrics,
} from "./types.js";
import {
  SessionContext,
  nextDailySeq,
  parseJsonl,
  toJsonLine,
  utcYmd,
} from "./utils.js";

// ── ID helpers ───────────────────────────────────────────────────────────

/** "q_<yyyymmdd>_<seq3>" — per-day, per-source. Symmetric with makeGapId. */
export function makeQueryId(date: Date, seq: number): string {
  return `q_${utcYmd(date)}_${String(seq).padStart(3, "0")}`;
}

/** "c_<yyyymmdd>_<seq3>" — per-day, per-source. For LocalCommandEvent. */
export function makeCommandId(date: Date, seq: number): string {
  return `c_${utcYmd(date)}_${String(seq).padStart(3, "0")}`;
}

// ── Subscription event shape (UI layer contract) ─────────────────────────

export type TraceCollectorEvent =
  | { kind: "query_start"; query_id: string; user_question: string; started_at: string }
  | { kind: "tool_call_added"; query_id: string; event: ToolCallEvent }
  | { kind: "api_round_added"; query_id: string; round: ApiRoundUsage }
  | { kind: "query_end"; trace: QueryTrace };

// ── Collector interface ──────────────────────────────────────────────────

export interface TraceCollector {
  startQuery(user_question: string, now?: Date): string;
  recordToolCall(query_id: string, ev: Omit<ToolCallEvent, "ordinal">): void;
  recordApiRound(query_id: string, round: Omit<ApiRoundUsage, "ordinal">): void;
  endQuery(query_id: string, final_answer?: string, error?: string, now?: Date): QueryTrace;
  subscribe(cb: (e: TraceCollectorEvent) => void): () => void;
}

// ── Sink interface + browser impl ────────────────────────────────────────

export interface TraceSink {
  flush(trace: QueryTrace): void;
  /** Snapshot — a later flush() must not mutate a previously returned array. */
  readAll(): QueryTrace[];
}

/** Minimal Storage surface — `window.localStorage` satisfies this. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Browser sink: append-only JSONL in localStorage; symmetric to BrowserGapSink. */
export class BrowserTraceSink implements TraceSink {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "knowdb-traces"
  ) {}

  flush(trace: QueryTrace): void {
    this.store.setItem(this.key, (this.store.getItem(this.key) ?? "") + toJsonLine(trace) + "\n");
  }

  readAll(): QueryTrace[] {
    return parseJsonl<QueryTrace>(this.store.getItem(this.key) ?? "");
  }

  /** Raw JSONL for the Demo's user-triggered download (ui.ts wraps in a Blob). */
  dump(): string {
    return this.store.getItem(this.key) ?? "";
  }
}

// ── Browser collector ────────────────────────────────────────────────────

interface PartialTrace {
  query_id: string;
  user_question: string;
  started_at: string;
  tool_calls: ToolCallEvent[];
  api_rounds: ApiRoundUsage[];
}

const nowIso = (d: Date): string => d.toISOString();

/**
 * In-memory collector. Holds partial QueryTraces by query_id, emits events
 * to subscribers as they accrue, finalizes a QueryTrace at endQuery and
 * drops the partial state. Does not persist — caller flushes via TraceSink.
 *
 * `query_id` allocation uses `nextDailySeq` against the sink's existing
 * traces so ids stay monotonic across page reloads (counter persisted in
 * localStorage, not in memory).
 */
export class BrowserTraceCollector implements TraceCollector {
  private readonly partials = new Map<string, PartialTrace>();
  private readonly subs = new Set<(e: TraceCollectorEvent) => void>();
  private readonly session: SessionContext;
  private readonly sink: { readAll(): QueryTrace[] } | null;

  constructor(
    session: SessionContext,
    /** Optional sink — used to seed `query_id` daily counters from persisted traces. */
    sink: { readAll(): QueryTrace[] } | null = null
  ) {
    this.session = session;
    this.sink = sink;
  }

  startQuery(user_question: string, now: Date = new Date()): string {
    // Counter seeded from persisted traces (across reloads) + still-open
    // partials (within this load). Both contribute by their start timestamp.
    const persisted = (this.sink?.readAll() ?? []).map((t) => ({ timestamp: t.started_at }));
    const inFlight = [...this.partials.values()].map((p) => ({ timestamp: p.started_at }));
    const seq = nextDailySeq([...persisted, ...inFlight], now);
    const query_id = makeQueryId(now, seq);
    const started_at = nowIso(now);
    this.partials.set(query_id, {
      query_id,
      user_question,
      started_at,
      tool_calls: [],
      api_rounds: [],
    });
    this.emit({ kind: "query_start", query_id, user_question, started_at });
    return query_id;
  }

  recordToolCall(query_id: string, ev: Omit<ToolCallEvent, "ordinal">): void {
    const p = this.partials.get(query_id);
    if (!p) throw new Error(`recordToolCall: unknown query_id ${query_id}`);
    const event: ToolCallEvent = { ordinal: p.tool_calls.length + 1, ...ev };
    p.tool_calls.push(event);
    this.emit({ kind: "tool_call_added", query_id, event });
  }

  recordApiRound(query_id: string, round: Omit<ApiRoundUsage, "ordinal">): void {
    const p = this.partials.get(query_id);
    if (!p) throw new Error(`recordApiRound: unknown query_id ${query_id}`);
    const r: ApiRoundUsage = { ordinal: p.api_rounds.length + 1, ...round };
    p.api_rounds.push(r);
    this.emit({ kind: "api_round_added", query_id, round: r });
  }

  endQuery(query_id: string, final_answer?: string, error?: string, now: Date = new Date()): QueryTrace {
    const p = this.partials.get(query_id);
    if (!p) throw new Error(`endQuery: unknown query_id ${query_id}`);
    const trace: QueryTrace = {
      source: "browser",
      query_id,
      session_id: this.session.id,
      user_question: p.user_question,
      started_at: p.started_at,
      ended_at: nowIso(now),
      tool_calls: p.tool_calls,
      api_rounds: p.api_rounds,
      ...(final_answer !== undefined ? { final_answer } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    this.partials.delete(query_id);
    this.emit({ kind: "query_end", trace });
    return trace;
  }

  subscribe(cb: (e: TraceCollectorEvent) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  private emit(e: TraceCollectorEvent): void {
    for (const cb of this.subs) cb(e);
  }
}

// ── Aggregators (pure, deterministic) ────────────────────────────────────

/** Group LocalCommandEvent[] by session_id; empty session_id grouped under "". */
export function aggregateLocalSession(events: LocalCommandEvent[]): LocalSessionMetrics[] {
  const groups = new Map<string, LocalCommandEvent[]>();
  for (const e of events) {
    const sid = e.session_id ?? "";
    (groups.get(sid) ?? groups.set(sid, []).get(sid)!).push(e);
  }
  const result: LocalSessionMetrics[] = [];
  for (const [sid, evs] of groups) {
    const sorted = [...evs].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const duration =
      sorted.length === 0
        ? 0
        : Date.parse(sorted[sorted.length - 1]!.timestamp) - Date.parse(sorted[0]!.timestamp);
    result.push({
      session_id: sid,
      command_count: sorted.length,
      duration_ms: duration,
      commands: sorted,
    });
  }
  // Newest session first (by earliest command timestamp).
  return result.sort((a, b) => {
    const ta = a.commands[0] ? Date.parse(a.commands[0].timestamp) : 0;
    const tb = b.commands[0] ? Date.parse(b.commands[0].timestamp) : 0;
    return tb - ta;
  });
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

/**
 * MVP zero-result sniff (T8 / §6): a trace counts as zero-result iff at least
 * one of its tool_calls is a `search` whose output_summary, trimmed, is `[]`.
 * Final version replaces this with a trace × gap join via query_id.
 */
function isZeroResultTrace(t: QueryTrace): boolean {
  return t.tool_calls.some((c) => c.tool === "search" && c.output_summary.trim() === "[]");
}

export function aggregateMetrics(
  browserTraces: QueryTrace[],
  localEvents: LocalCommandEvent[]
): TraceMetrics {
  const stepsPerQuery = browserTraces.map((t) => t.tool_calls.length);
  const queryDurations = browserTraces.map(
    (t) => Date.parse(t.ended_at) - Date.parse(t.started_at)
  );
  const apiRounds = browserTraces.flatMap((t) => t.api_rounds);
  const tokensIn = apiRounds.reduce((s, r) => s + r.input_tokens, 0);
  const tokensOut = apiRounds.reduce((s, r) => s + r.output_tokens, 0);

  const toolDist: Record<string, number> = {};
  for (const t of browserTraces) {
    for (const c of t.tool_calls) {
      toolDist[c.tool] = (toolDist[c.tool] ?? 0) + 1;
    }
  }

  const sessions = aggregateLocalSession(localEvents);
  const commandsPerSession = sessions.map((s) => s.command_count);
  const sessionDurations = sessions.map((s) => s.duration_ms);
  const cmdDist: Record<string, number> = {};
  for (const e of localEvents) {
    cmdDist[e.command] = (cmdDist[e.command] ?? 0) + 1;
  }

  return {
    total_queries: browserTraces.length,
    avg_steps_per_query: mean(stepsPerQuery),
    avg_query_duration_ms: mean(queryDurations),
    total_tokens: { input: tokensIn, output: tokensOut },
    tool_call_distribution: toolDist,
    queries_with_zero_search_result: browserTraces.filter(isZeroResultTrace).length,
    queries_with_final_answer: browserTraces.filter((t) => t.final_answer && !t.error).length,
    total_local_sessions: sessions.length,
    avg_commands_per_local_session: mean(commandsPerSession),
    avg_local_session_duration_ms: mean(sessionDurations),
    local_command_distribution: cmdDist,
  };
}

