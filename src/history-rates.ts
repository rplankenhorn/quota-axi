import type { HistorySample } from "./history.js";

/** Reference prices, not an invoice or a historical tariff lookup. USD / 1M tokens. */
export const HISTORY_RATE_CARD = {
  asOf: "2026-09-23",
  basis: "standard_global_api_token_rates",
  sources: [
    "https://platform.claude.com/docs/en/about-claude/pricing",
    "https://developers.openai.com/api/docs/pricing",
    "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "https://developers.openai.com/api/docs/models/gpt-6-sol",
    "https://developers.openai.com/api/docs/models/gpt-6-luna",
    "https://developers.openai.com/api/docs/models/gpt-5.2-codex",
  ],
} as const;

type Rate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  /** Refuse older Claude long-context requests without a verified tariff. */
  maxInput?: number;
  longContextThreshold?: number;
};

function claude(input: number, output: number, cacheRead = input / 10): Rate {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

// Exact identifiers only: a new model or alias must never inherit another model's rate.
const CLAUDE_RATES: Readonly<Record<string, Rate>> = {
  "claude-fable-5-1": claude(10, 50, 0.25),
  "claude-mythos-5-1": claude(10, 50, 0.25),
  "claude-fable-5": claude(10, 50),
  "claude-mythos-5": claude(10, 50),
  "claude-opus-5-5": claude(4, 20, 0.2),
  "claude-opus-5": claude(5, 25),
  "claude-opus-4-8": claude(5, 25),
  "claude-opus-4-7": claude(5, 25),
  "claude-opus-4-6": claude(5, 25),
  "claude-opus-4-5": { ...claude(5, 25), maxInput: 200_000 },
  "claude-opus-4-5-20251101": { ...claude(5, 25), maxInput: 200_000 },
  "claude-sonnet-5": claude(2, 10),
  "claude-sonnet-4-6": claude(3, 15),
  "claude-sonnet-4-5": { ...claude(3, 15), maxInput: 200_000 },
  "claude-sonnet-4-5-20250929": { ...claude(3, 15), maxInput: 200_000 },
  "claude-haiku-4-5": { ...claude(1, 5), maxInput: 200_000 },
  "claude-haiku-4-5-20251001": { ...claude(1, 5), maxInput: 200_000 },
};
const CODEX_RATES: Readonly<Record<string, Rate>> = {
  "gpt-5.2-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-6-astra": {
    input: 10,
    cacheRead: 1,
    cacheWrite: 12.5,
    output: 50,
    longContextThreshold: 272_000,
  },
  "gpt-6-sol": {
    input: 2,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 10,
    longContextThreshold: 272_000,
  },
  "gpt-6-luna": {
    input: 0.1,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    longContextThreshold: 272_000,
  },
};

export type HistoryPrice = { usd: number } | { reason: string };

export function priceHistorySample(sample: HistorySample): HistoryPrice {
  if (sample.unpricedReason) return { reason: sample.unpricedReason };
  const rates = sample.provider === "claude" ? CLAUDE_RATES : CODEX_RATES;
  const rate = Object.hasOwn(rates, sample.model)
    ? rates[sample.model]
    : undefined;
  if (!rate) return { reason: "model_rate_unverified" };
  const t = sample.tokens;
  // Pi's openai-codex adapter subtracts cache reads AND writes before storing
  // usage.input. This is a verified producer contract, not a relation between
  // observed counter values; see test/fixtures/history/README.md for the pinned
  // publisher source and offline normalizer evidence. Native Codex is inclusive.
  const input =
    t.inputTokens - (sample.inputIncludesCache ? t.cacheReadTokens : 0);
  const prompt = input + t.cacheReadTokens + t.cacheWriteTokens;
  if (rate.maxInput !== undefined && prompt > rate.maxInput) {
    return { reason: "long_context_rate_unverified" };
  }
  if (t.cacheWriteTokens > 0 && rate.cacheWrite === undefined) {
    return { reason: "cache_write_rate_unverified" };
  }
  if (
    sample.provider === "claude" &&
    t.cacheWriteTokens > 0 &&
    t.cacheWrite1hTokens === undefined
  ) {
    return { reason: "cache_retention_unreported" };
  }
  if ((t.cacheWrite1hTokens ?? 0) > 0 && rate.cacheWrite1h === undefined) {
    return { reason: "cache_retention_rate_unverified" };
  }
  const long =
    rate.longContextThreshold !== undefined &&
    prompt > rate.longContextThreshold;
  const writes1h = t.cacheWrite1hTokens ?? 0;
  const inputCost =
    input * rate.input +
    t.cacheReadTokens * rate.cacheRead +
    (t.cacheWriteTokens - writes1h) * (rate.cacheWrite ?? 0) +
    writes1h * (rate.cacheWrite1h ?? 0);
  const usd =
    (inputCost * (long ? 2 : 1) +
      t.outputTokens * rate.output * (long ? 1.5 : 1)) /
    1_000_000;
  return Number.isFinite(usd) && usd >= 0
    ? { usd }
    : { reason: "invalid_cost" };
}
