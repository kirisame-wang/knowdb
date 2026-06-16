// Intrinsic facts about the model the demo agent runs: its id and the token
// rates it is billed at. Kept together so they change as a unit — a swapped
// model with stale rates would give a misleading cost estimate.
export const MODEL = {
  id: "claude-haiku-4-5-20251001",
  pricing: { inputPerMTok: 1, outputPerMTok: 5 }, // USD per 1M tokens
  contextWindowTokens: 200_000,
} as const;

// Per-request output cap the demo chooses for each turn — our setting, not a
// property of the model.
export const MAX_OUTPUT_TOKENS = 2048;

// Fraction of the context window at which the UI nudges the user to start fresh
// — our setting, leaving headroom for the reply and the next round.
export const CONTEXT_WARN_RATIO = 0.8;
