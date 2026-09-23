import { describe, expect, it } from "vitest";
import {
  createHistoryReport,
  type HistoryProvider,
  type HistoryRead,
  type HistorySample,
} from "../src/history.js";
import { priceHistorySample } from "../src/history-rates.js";

function sample(
  provider: HistoryProvider = "codex",
  overrides: Partial<HistorySample> = {},
): HistorySample {
  return {
    key: "sample",
    timestamp: "2026-09-10T12:00:00.000Z",
    provider,
    source: "pi",
    model: provider === "codex" ? "gpt-5.3-codex" : "claude-opus-4-6",
    inputIncludesCache: false,
    tokens: {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
    },
    ...overrides,
  };
}
const read = (samples: HistorySample[]): HistoryRead => ({
  samples,
  sources: [],
  issues: [],
});
const report = (samples: HistorySample[], now = "2026-09-16T00:00:00.000Z") =>
  createHistoryReport(read(samples), "2026-09", now);

function outputCost(
  provider: HistoryProvider,
  outputTokens: number,
): HistorySample {
  return sample(provider, {
    tokens: {
      inputTokens: 0,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
}

describe("verified API token-rate equivalents", () => {
  it("prices Claude's disjoint input, reads, 5m writes, 1h writes, and output separately", () => {
    const value = sample("claude", {
      tokens: {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        cacheWriteTokens: 4000,
        cacheWrite1hTokens: 1000,
      },
    });
    expect(priceHistorySample(value)).toEqual({ usd: 0.08525 });
  });

  it("subtracts native Codex cached input but never adds reasoning a second time", () => {
    const value = sample("codex", {
      source: "codex-cli",
      inputIncludesCache: true,
      tokens: {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 600,
        cacheWriteTokens: 0,
        reasoningOutputTokens: 1500,
      },
    });
    expect(priceHistorySample(value)).toEqual({ usd: 0.028805 });
  });

  it("prices Pi Codex when the exclusive shape is proven, and withholds cost when it is not", () => {
    const proven = sample("codex", {
      source: "pi",
      inputIncludesCache: false,
      tokens: {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
      },
    });
    expect(priceHistorySample(proven)).toEqual({ usd: 0.030275 });
    expect(
      priceHistorySample({
        ...proven,
        tokens: { ...proven.tokens, cacheReadTokens: 600 },
      }),
    ).toEqual({ reason: "pi_codex_input_units_unverified" });
    expect(
      priceHistorySample({
        ...proven,
        tokens: { ...proven.tokens, cacheReadTokens: 0 },
      }),
    ).toEqual({ usd: 0.02975 });
  });

  it("applies GPT-6's verified long-context threshold to each request, not daily totals", () => {
    const atThreshold = sample("codex", {
      model: "gpt-6-astra",
      tokens: {
        inputTokens: 2000,
        cacheReadTokens: 270_000,
        outputTokens: 1000,
        cacheWriteTokens: 0,
      },
    });
    expect(priceHistorySample(atThreshold)).toEqual({ usd: 0.34 });
    expect(
      priceHistorySample({
        ...atThreshold,
        tokens: { ...atThreshold.tokens, inputTokens: 2001 },
      }),
    ).toEqual({ usd: 0.65502 });
    const daily = report([atThreshold, { ...atThreshold, key: "second" }])
      .daily[0];
    expect(daily.apiEquivalentUsd).toBe(0.68);
  });

  it.each([
    "new-model",
    "gpt-5.3-codex-unverified-alias",
    "constructor",
    "__proto__",
  ])("never guesses the price of %s", (model) => {
    expect(priceHistorySample(sample("codex", { model }))).toEqual({
      reason: "model_rate_unverified",
    });
  });

  it("withholds prices for unreported cache retention and unsupported older long-context rates", () => {
    expect(
      priceHistorySample(
        sample("claude", {
          tokens: {
            inputTokens: 0,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 10,
          },
        }),
      ),
    ).toEqual({ reason: "cache_retention_unreported" });
    expect(
      priceHistorySample(
        sample("claude", {
          model: "claude-sonnet-4-5",
          tokens: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 200_000,
            cacheWriteTokens: 0,
          },
        }),
      ),
    ).toEqual({ reason: "long_context_rate_unverified" });
    expect(
      priceHistorySample(
        sample("codex", {
          tokens: {
            inputTokens: 0,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 10,
          },
        }),
      ),
    ).toEqual({ reason: "cache_write_rate_unverified" });
  });
});

describe("monthly budget velocity", () => {
  it("keeps the $3500 Claude and $600 Codex budgets independent, with declaration order", () => {
    const result = report([
      outputCost("codex", 25_000_000),
      outputCost("claude", 70_000_000),
    ]);
    expect(result.forecast).toMatchObject([
      {
        provider: "claude",
        budgetUsd: 3500,
        apiEquivalentUsd: 1750,
        elapsedDays: 15,
        monthDays: 30,
        projectedMonthUsd: 3500,
        status: "within_budget_at_observed_pace",
        remainingBudgetUsd: 1750,
      },
      {
        provider: "codex",
        budgetUsd: 600,
        apiEquivalentUsd: 350,
        projectedMonthUsd: 700,
        projectedOverageUsd: 100,
        status: "projected_over_budget",
        remainingBudgetUsd: 250,
      },
    ]);
    expect(result.forecast[1].dailyVelocityUsd).toBeCloseTo(350 / 15, 6);
    expect(result.forecast[1].budgetVelocityUsd).toBe(20);
  });

  it("distinguishes already over budget from projected overspend", () => {
    const result = report([outputCost("codex", 50_000_000)]).forecast[1];
    expect(result).toMatchObject({
      status: "over_budget",
      apiEquivalentUsd: 700,
      projectedMonthUsd: 1400,
      remainingBudgetUsd: -100,
    });
  });

  it("uses fractional elapsed UTC days rather than the count of active days", () => {
    const value = outputCost("codex", 1_000_000);
    value.timestamp = "2026-09-01T02:00:00.000Z";
    const result = report([value], "2026-09-01T12:00:00.000Z").forecast[1];
    expect(result).toMatchObject({
      elapsedDays: 0.5,
      dailyVelocityUsd: 28,
      projectedMonthUsd: 840,
    });
  });

  it.each([
    ["2024-02", 29],
    ["2025-02", 28],
    ["2026-01", 31],
    ["2026-04", 30],
  ] as const)(
    "honors calendar length for %s and caps a past month's clock at its end",
    (month, days) => {
      const value = outputCost("codex", 1_000_000);
      value.timestamp = `${month}-01T00:00:00.000Z`;
      const result = createHistoryReport(
        read([value]),
        month,
        "2026-09-23T00:00:00.000Z",
      ).forecast[1];
      expect(result).toMatchObject({
        monthDays: days,
        elapsedDays: days,
        projectedMonthUsd: 14,
      });
    },
  );

  it("reports no data and month-start zero elapsed time as unknown, not zero spend", () => {
    expect(report([]).forecast[1]).toMatchObject({
      status: "unknown",
      reason: "no_records",
    });
    expect(report([]).forecast[1].projectedMonthUsd).toBeUndefined();
    const value = sample("codex", {
      timestamp: "2026-09-01T00:00:00.000Z",
      tokens: {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
      },
    });
    const result = report([value], value.timestamp).forecast[1];
    expect(result).toMatchObject({
      status: "unknown",
      reason: "month_not_started",
    });
    expect(JSON.stringify(result)).not.toContain("null");
  });

  it("keeps unknown prices in native tokens and never reports a partial cost as the total", () => {
    const result = report([
      outputCost("codex", 1_000_000),
      sample("codex", { model: "unknown" }),
    ]);
    expect(result.daily[1]).toMatchObject({
      model: "unknown",
      unpricedRecords: 1,
      unpricedReasons: ["model_rate_unverified"],
      tokens: { inputTokens: 1000 },
    });
    expect(result.daily[1].apiEquivalentUsd).toBeUndefined();
    expect(result.forecast[1]).toMatchObject({
      knownCostUsd: 14,
      unpricedRecords: 1,
      status: "unknown",
      reason: "unpriced_usage",
    });
    expect(result.forecast[1].apiEquivalentUsd).toBeUndefined();
    expect(result.forecast[1].projectedMonthUsd).toBeUndefined();
  });

  it("preserves tokens but withholds cost and projection for unverifiable Pi Codex units", () => {
    const result = report([
      sample("codex", {
        source: "pi",
        inputIncludesCache: false,
        tokens: {
          inputTokens: 1000,
          outputTokens: 2000,
          cacheReadTokens: 600,
          cacheWriteTokens: 0,
        },
      }),
    ]);
    expect(result.daily[0]).toMatchObject({
      unpricedRecords: 1,
      unpricedReasons: ["pi_codex_input_units_unverified"],
      tokens: { inputTokens: 1000, cacheReadTokens: 600 },
    });
    expect(result.daily[0].apiEquivalentUsd).toBeUndefined();
    expect(result.forecast[1]).toMatchObject({
      status: "unknown",
      reason: "unpriced_usage",
    });
    expect(result.forecast[1].apiEquivalentUsd).toBeUndefined();
    expect(result.forecast[1].projectedMonthUsd).toBeUndefined();
    expect(result.forecast[1].dailyVelocityUsd).toBeUndefined();
    expect(result.forecast[1].projectedOverageUsd).toBeUndefined();
  });

  it("discloses partial reads, while a known subtotal can still prove the budget was exceeded", () => {
    const input = read([
      outputCost("codex", 50_000_000),
      outputCost("claude", 1_000_000),
    ]);
    input.issues = [
      {
        source: "codex-cli",
        provider: "codex",
        reason: "session_read_error",
        count: 1,
      },
    ];
    const result = createHistoryReport(
      input,
      "2026-09",
      "2026-09-16T00:00:00.000Z",
    );
    expect(result.forecast[1]).toMatchObject({
      status: "over_budget",
      reason: "incomplete_history",
      knownCostUsd: 700,
    });
    expect(result.forecast[1].projectedMonthUsd).toBeUndefined();
    expect(result.forecast[0].status).toBe("within_budget_at_observed_pace");
  });

  it("filters by timestamp, converts offsets to UTC days, and never includes future events", () => {
    const result = report([
      sample("claude", { timestamp: "2026-09-01T00:30:00+02:00" }),
      sample("claude", { timestamp: "2026-09-09T23:30:00-02:00" }),
      sample("claude", { timestamp: "2026-09-17T00:00:00Z" }),
    ]);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({ date: "2026-09-10", records: 1 });
  });
});
