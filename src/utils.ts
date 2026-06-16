// General utilities: UTC dates, ephemeral ids, generic JSONL (de)serialization,
// API-error classification. Domain-pure — must not import any domain model.

/** UTC yyyymmdd. */
export function utcYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Ephemeral id. crypto.randomUUID when available, else time+random fallback. */
export function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Holder for an ephemeral browser session id, shared across sinks/collectors
 * so trace × gap join is unambiguous. The shared holder (not a string) is
 * the API surface — callers wrap their id in `new SessionContext(id)` when
 * they want deterministic injection (tests, fixtures).
 */
export class SessionContext {
  constructor(public readonly id: string = newSessionId()) {}
}

/**
 * Truncate a string for trace/UX display. Sentinel suffix mirrors what the
 * existing `appendToolTrace` UI shows so both call sites share one helper.
 */
export function truncateOutput(s: string, n = 600): string {
  return s.length <= n ? s : s.slice(0, n) + "\n… (truncated)";
}

/**
 * A 400 "prompt is too long" — context overflow. Two gates (status + phrase) so
 * a stray echo of the phrase isn't matched. Shared by the benchmark (on a
 * recorded trace error) and the main UI (on the live error the banner sees).
 */
export function isContextOverflowError(error: string | undefined): boolean {
  const e = error ?? "";
  return /\b400\b/.test(e) && /prompt is too long/i.test(e);
}

/** One JSON value per line (the "L" in JSONL). */
export function toJsonLine<T>(value: T): string {
  return JSON.stringify(value);
}

/** Parse newline-delimited JSON, skipping blank and corrupt lines instead of
 *  throwing — a damaged log must never break the caller's hot path. */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt/truncated line
    }
  }
  return out;
}

/**
 * 1-based per-day sequence number from a list of timestamped items. Same
 * shape both gap and trace recording use; lives here so domain modules
 * (gaps.ts / traces.ts) share one counter implementation rather than two.
 */
export function nextDailySeq<T extends { timestamp: string }>(items: T[], date: Date): number {
  const ymd = utcYmd(date);
  return items.filter((it) => utcYmd(new Date(it.timestamp)) === ymd).length + 1;
}
