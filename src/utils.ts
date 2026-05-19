// General utilities: UTC dates, ephemeral ids, generic JSONL (de)serialization.
// Domain-pure — must not import any domain model.

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
