// The model the demo agent runs, with the token economics it is billed at.
// id + pricing are kept together deliberately: they must change as a unit —
// swapping the model without updating the rates yields a misleading cost
// estimate. Rates per Anthropic API pricing (Claude Haiku 4.5: $1 / MTok input,
// $5 / MTok output) — https://platform.claude.com/docs/en/about-claude/pricing
export const MODEL = {
  id: "claude-haiku-4-5-20251001",
  maxTokens: 2048,
  pricing: { inputPerMTok: 1, outputPerMTok: 5 }, // USD per 1M tokens
} as const;
