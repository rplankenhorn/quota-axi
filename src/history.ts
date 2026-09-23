import { HISTORY_RATE_CARD, priceHistorySample } from "./history-rates.js";
import { PACE_EARLY_ELAPSED_PERCENT } from "./pace.js";

export const HISTORY_PROVIDERS = ["claude", "codex"] as const;
export type HistoryProvider = (typeof HISTORY_PROVIDERS)[number];
export type HistorySource = "claude-code" | "codex-cli" | "pi";
export const MONTHLY_BUDGET_USD = { claude: 3500, codex: 600 } as const;

/** Native token counts. Reasoning is a subset of output, 1h writes a subset of writes. */
export type HistoryTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  reasoningOutputTokens?: number;
};
export type HistorySample = {
  /** In-memory de-duplication identity; never published. */
  key: string;
  timestamp: string;
  provider: HistoryProvider;
  source: HistorySource;
  model: string;
  inputIncludesCache: boolean;
  tokens: HistoryTokens;
  unpricedReason?: string;
};
export type HistoryIssue = {
  source: HistorySource;
  /** Pi files can contain either provider, so an unattributed failure affects both. */
  provider?: HistoryProvider;
  reason: string;
  count: number;
};
export type HistorySourceState = {
  source: HistorySource;
  status: "read" | "absent" | "partial";
  filesRead: number;
};
export type HistoryRead = {
  samples: HistorySample[];
  issues: HistoryIssue[];
  sources: HistorySourceState[];
};
export type HistoryDay = {
  date: string;
  provider: HistoryProvider;
  source: HistorySource;
  model: string;
  inputIncludesCache: boolean;
  records: number;
  tokens: HistoryTokens;
  /** Sum of priced records only, not a complete cost when unpricedRecords > 0. */
  knownCostUsd: number;
  apiEquivalentUsd?: number;
  unpricedRecords: number;
  unpricedReasons: string[];
};
export type HistoryForecast = {
  provider: HistoryProvider;
  budgetUsd: number;
  status:
    | "over_budget"
    | "projected_over_budget"
    | "within_budget_at_observed_pace"
    | "unknown";
  reason?: string;
  records: number;
  unpricedRecords: number;
  knownCostUsd: number;
  elapsedDays: number;
  monthDays: number;
  projectionConfidence?: "early" | "established";
  apiEquivalentUsd?: number;
  dailyVelocityUsd?: number;
  budgetVelocityUsd: number;
  projectedMonthUsd?: number;
  projectedOverageUsd?: number;
  remainingBudgetUsd?: number;
};
export type HistoryReport = {
  schemaVersion: 1;
  generatedAt: string;
  month: string;
  timeZone: "UTC";
  coverage: "local_records_only";
  pricing: typeof HISTORY_RATE_CARD;
  daily: HistoryDay[];
  forecast: HistoryForecast[];
  sources: HistorySourceState[];
  issues: HistoryIssue[];
};

const DAY = 86_400_000;

export function historyMonthBounds(month: string): {
  start: number;
  end: number;
} {
  const start = Date.parse(`${month}-01T00:00:00.000Z`);
  const date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, end: date.getTime() };
}

/** Calendar-month average of observed records only; never inferred from quota deltas. */
export function createHistoryReport(
  read: HistoryRead,
  month: string,
  generatedAt: string,
  providers: readonly HistoryProvider[] = HISTORY_PROVIDERS,
): HistoryReport {
  const { start, end } = historyMonthBounds(month);
  const cutoff = Math.min(Date.parse(generatedAt), end);
  const elapsedDays = Math.max(0, (cutoff - start) / DAY);
  const monthDays = (end - start) / DAY;
  const groups = new Map<string, HistoryDay>();
  for (const sample of read.samples) {
    const time = Date.parse(sample.timestamp);
    if (
      !providers.includes(sample.provider) ||
      time < start ||
      time >= end ||
      time > cutoff
    )
      continue;
    const date = new Date(time).toISOString().slice(0, 10);
    const key = JSON.stringify([
      date,
      sample.provider,
      sample.source,
      sample.model,
      sample.inputIncludesCache,
    ]);
    let day = groups.get(key);
    if (!day) {
      day = {
        date,
        provider: sample.provider,
        source: sample.source,
        model: sample.model,
        inputIncludesCache: sample.inputIncludesCache,
        records: 0,
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        knownCostUsd: 0,
        unpricedRecords: 0,
        unpricedReasons: [],
      };
      groups.set(key, day);
    }
    day.records++;
    for (const name of Object.keys(sample.tokens) as (keyof HistoryTokens)[]) {
      const value = sample.tokens[name];
      if (value !== undefined)
        day.tokens[name] = (day.tokens[name] ?? 0) + value;
    }
    const price = priceHistorySample(sample);
    if ("usd" in price) day.knownCostUsd += price.usd;
    else {
      day.unpricedRecords++;
      if (!day.unpricedReasons.includes(price.reason))
        day.unpricedReasons.push(price.reason);
    }
  }
  const daily = [...groups.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      HISTORY_PROVIDERS.indexOf(a.provider) -
        HISTORY_PROVIDERS.indexOf(b.provider) ||
      a.source.localeCompare(b.source) ||
      a.model.localeCompare(b.model),
  );
  const issues = read.issues.filter(
    (issue) => !issue.provider || providers.includes(issue.provider),
  );
  const forecast = HISTORY_PROVIDERS.filter((provider) =>
    providers.includes(provider),
  ).map((provider): HistoryForecast => {
    const days = daily.filter((day) => day.provider === provider);
    const records = days.reduce((sum, day) => sum + day.records, 0);
    const knownCostUsd = days.reduce((sum, day) => sum + day.knownCostUsd, 0);
    const unpricedRecords = days.reduce(
      (sum, day) => sum + day.unpricedRecords,
      0,
    );
    const budgetUsd = MONTHLY_BUDGET_USD[provider];
    const reason = issues.some(
      (issue) => !issue.provider || issue.provider === provider,
    )
      ? "incomplete_history"
      : !records
        ? "no_records"
        : unpricedRecords
          ? "unpriced_usage"
          : elapsedDays <= 0
            ? "month_not_started"
            : undefined;
    const result: HistoryForecast = {
      provider,
      budgetUsd,
      status: knownCostUsd > budgetUsd ? "over_budget" : "unknown",
      records,
      unpricedRecords,
      knownCostUsd: money(knownCostUsd),
      elapsedDays,
      monthDays,
      budgetVelocityUsd: money(budgetUsd / monthDays),
    };
    if (reason) return { ...result, reason };
    const velocity = knownCostUsd / elapsedDays;
    const projected = velocity * monthDays;
    const projectionConfidence =
      (elapsedDays / monthDays) * 100 < PACE_EARLY_ELAPSED_PERCENT
        ? "early"
        : "established";
    return {
      ...result,
      status:
        knownCostUsd > budgetUsd
          ? "over_budget"
          : projected > budgetUsd
            ? "projected_over_budget"
            : "within_budget_at_observed_pace",
      projectionConfidence,
      apiEquivalentUsd: money(knownCostUsd),
      dailyVelocityUsd: money(velocity),
      projectedMonthUsd: money(projected),
      projectedOverageUsd: money(Math.max(0, projected - budgetUsd)),
      remainingBudgetUsd: money(budgetUsd - knownCostUsd),
    };
  });
  for (const day of daily) {
    day.knownCostUsd = money(day.knownCostUsd);
    if (!day.unpricedRecords) day.apiEquivalentUsd = day.knownCostUsd;
  }
  return {
    schemaVersion: 1,
    generatedAt,
    month,
    timeZone: "UTC",
    coverage: "local_records_only",
    pricing: HISTORY_RATE_CARD,
    daily,
    forecast,
    sources: read.sources,
    issues,
  };
}

function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
