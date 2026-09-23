import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { readHistory } from "../src/history-reader.js";
import type { HistoryReport } from "../src/history.js";
import { PROVIDERS } from "../src/providers/index.js";

let root: string;
const NOW = "2026-09-16T00:00:00.000Z";
const TIME = "2026-09-10T12:00:00.000Z";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quota-history-test-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, records: unknown[]): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    records
      .map((record) =>
        typeof record === "string" ? record : JSON.stringify(record),
      )
      .join("\n") + "\n",
  );
}
function claude(id = "msg-test", timestamp = TIME, output = 2000): unknown {
  return {
    type: "assistant",
    timestamp,
    requestId: "request-private",
    cwd: "private-project",
    message: {
      id,
      model: "claude-opus-4-6",
      content: [{ text: "PRIVATE RESPONSE" }],
      usage: {
        input_tokens: 1000,
        output_tokens: output,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 4000,
        cache_creation: {
          ephemeral_5m_input_tokens: 3000,
          ephemeral_1h_input_tokens: 1000,
        },
      },
    },
  };
}
function pi(
  id = "pi-id",
  model = "gpt-5.3-codex",
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: TIME,
    message: {
      role: "assistant",
      provider: "openai-codex",
      model,
      content: [{ type: "text", text: "PRIVATE PI RESPONSE" }],
      usage: {
        input: 1000,
        output: 2000,
        cacheRead: 3000,
        cacheWrite: 0,
        reasoning: 1500,
        cost: { total: 999999 },
      },
      ...overrides,
    },
  };
}
function tokenCount(
  input: number,
  cached: number,
  output: number,
  timestamp = TIME,
  last?: unknown,
): unknown {
  const total = {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: output / 2,
    total_tokens: input + output,
  };
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last ?? total },
    },
  };
}
const meta = {
  type: "session_meta",
  payload: { id: "session-test", cwd: "private-codex-project" },
};
const context = (model: string) => ({
  type: "turn_context",
  payload: { model },
});
async function capture(args: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv: args,
    binPath: "quota-axi",
    stdout: { write: (chunk) => chunks.push(String(chunk)) },
  });
  return chunks.join("");
}
async function json(args: string[] = []): Promise<HistoryReport> {
  return JSON.parse(await capture(["history", ...args, "--json"]));
}

describe("history CLI using synthetic local stores", () => {
  it("reports daily Claude/Codex/Pi usage and forecasts without quota I/O, caching, or transcript leakage", async () => {
    const claudeProbe = vi.spyOn(PROVIDERS.claude, "fetchQuota");
    const codexProbe = vi.spyOn(PROVIDERS.codex, "fetchQuota");
    const network = vi.fn(() => {
      throw new Error("history must not fetch");
    });
    vi.stubGlobal("fetch", network);
    write("claude/projects/project/session.jsonl", [claude()]);
    write("codex/sessions/2026/09/10/rollout.jsonl", [
      meta,
      context("gpt-5.3-codex"),
      tokenCount(1000, 600, 2000),
    ]);
    write("pi/sessions/project/session.jsonl", [pi()]);
    write("claude/.credentials.json", ["DO NOT OPEN CREDENTIALS"]);
    write("codex/auth.json", ["DO NOT OPEN CREDENTIALS"]);
    write("pi/auth.json", ["DO NOT OPEN CREDENTIALS"]);
    write("cache/quota-axi/quotas.json", ["UNCHANGED CACHE"]);

    const result = await json();
    expect(result).toMatchObject({
      schemaVersion: 1,
      month: "2026-09",
      timeZone: "UTC",
      coverage: "local_records_only",
      generatedAt: NOW,
    });
    expect(result.daily).toHaveLength(3);
    expect(result.daily[0]).toMatchObject({
      provider: "claude",
      source: "claude-code",
      inputIncludesCache: false,
      apiEquivalentUsd: 0.08525,
    });
    expect(result.daily[1]).toMatchObject({
      provider: "codex",
      source: "codex-cli",
      inputIncludesCache: true,
      apiEquivalentUsd: 0.028805,
      tokens: { inputTokens: 1000, reasoningOutputTokens: 1000 },
    });
    expect(result.daily[2]).toMatchObject({
      provider: "codex",
      source: "pi",
      inputIncludesCache: false,
      apiEquivalentUsd: 0.030275,
    });
    expect(result.forecast[1]).toMatchObject({
      budgetUsd: 600,
      knownCostUsd: 0.05908,
      projectedMonthUsd: 0.11816,
    });
    expect(result.issues).toEqual([]);
    const rendered = JSON.stringify(result);
    for (const secret of [
      "PRIVATE",
      "private-project",
      "session-test",
      "msg-test",
      "pi-id",
      "999999",
      root,
      "DO NOT OPEN",
    ])
      expect(rendered).not.toContain(secret);
    expect(network).not.toHaveBeenCalled();
    expect(claudeProbe).not.toHaveBeenCalled();
    expect(codexProbe).not.toHaveBeenCalled();
    expect(
      readFileSync(join(root, "cache/quota-axi/quotas.json"), "utf8"),
    ).toBe("UNCHANGED CACHE\n");
    const toon = await capture(["history"]);
    expect(toon).toContain("daily[3]");
    expect(toon).toContain("forecast[2]");
    expect(toon).toContain("standard global API-token-rate equivalents");
    expect(process.exitCode).toBeUndefined();
  });

  it("deduplicates Claude content blocks and copied sessions, keeping final usage once", async () => {
    write("claude/projects/a/main.jsonl", [
      claude("same", TIME, 1000),
      claude("same", TIME, 2000),
    ]);
    write("claude/projects/b/copy.jsonl", [claude("same", TIME, 2000)]);
    write("claude/projects/a/subagents/agent.jsonl", [
      claude("different", "2026-09-11T12:00:00Z", 1000),
    ]);
    const result = await json(["--provider", "claude"]);
    expect(result.daily).toHaveLength(2);
    expect(result.daily[0]).toMatchObject({
      records: 1,
      tokens: { outputTokens: 2000 },
      apiEquivalentUsd: 0.08525,
    });
    expect(result.daily[1]).toMatchObject({ date: "2026-09-11", records: 1 });
  });

  it("deduplicates Pi forks/clones and accounts for explicit model-attributed usage entries", async () => {
    const usage = {
      type: "usage",
      id: "warm",
      timestamp: TIME,
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: { input: 0, output: 0, cacheRead: 50000, cacheWrite: 0 },
    };
    write("pi/sessions/a/a.jsonl", [pi(), usage]);
    write("pi/sessions/b/fork.jsonl", [pi(), usage, pi("new-id")]);
    const result = await json();
    expect(result.daily).toHaveLength(2);
    expect(result.daily[0]).toMatchObject({
      provider: "claude",
      records: 1,
      apiEquivalentUsd: 0.025,
    });
    expect(result.daily[1]).toMatchObject({
      provider: "codex",
      records: 2,
      tokens: { inputTokens: 2000 },
    });
  });

  it("uses Codex cumulative deltas across days and model switches, excluding repeated rate-limit events and archive copies", async () => {
    const records = [
      meta,
      context("gpt-5.3-codex"),
      tokenCount(1000, 200, 1000, "2026-09-09T23:59:00Z"),
      tokenCount(1000, 200, 1000, "2026-09-10T00:00:00Z"),
      context("gpt-6-astra"),
      tokenCount(2000, 400, 3000, "2026-09-10T01:00:00Z"),
      {
        type: "event_msg",
        timestamp: TIME,
        payload: {
          type: "token_count",
          info: null,
          rate_limits: { primary: { used_percent: 99 } },
        },
      },
    ];
    write("codex/sessions/rollout.jsonl", records);
    write("codex/archived_sessions/copy.jsonl", records);
    const result = await json(["--provider=codex"]);
    expect(result.daily).toHaveLength(2);
    expect(result.daily[0]).toMatchObject({
      date: "2026-09-09",
      records: 1,
      model: "gpt-5.3-codex",
      tokens: { inputTokens: 1000, outputTokens: 1000 },
    });
    expect(result.daily[1]).toMatchObject({
      date: "2026-09-10",
      records: 1,
      model: "gpt-6-astra",
      tokens: { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 2000 },
      apiEquivalentUsd: 0.1082,
    });
    expect(result.issues).toEqual([]);
  });

  it("keeps the pre-month Codex baseline without attributing cumulative spend to the selected month", async () => {
    write("codex/sessions/rollout.jsonl", [
      meta,
      context("gpt-5.3-codex"),
      tokenCount(1000, 200, 1000, "2026-08-31T23:59:00Z"),
      tokenCount(2000, 400, 3000, "2026-09-01T00:01:00Z"),
    ]);
    const result = await json(["--provider", "codex"]);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0].tokens).toMatchObject({
      inputTokens: 1000,
      outputTokens: 2000,
    });
    expect(result.issues).toEqual([]);
  });

  it("discloses truncated cumulative history and counter resets instead of treating totals as daily spend", async () => {
    const last = {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 200,
      reasoning_output_tokens: 100,
    };
    write("codex/sessions/rollout.jsonl", [
      meta,
      context("gpt-5.3-codex"),
      tokenCount(10_000, 2000, 20_000, TIME, last),
      tokenCount(100, 20, 200, "2026-09-11T00:00:00Z"),
    ]);
    const result = await json(["--provider", "codex"]);
    expect(result.daily[0].tokens).toMatchObject({
      inputTokens: 100,
      outputTokens: 200,
    });
    expect(result.forecast[0]).toMatchObject({
      status: "unknown",
      reason: "incomplete_history",
    });
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      "unattributed_cumulative_usage",
      "cumulative_counter_reset",
    ]);
  });

  it("honors provider selection, archived months, UTC date grouping, and relocated Pi agent roots", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "custom-agent"));
    write("custom-agent/sessions/session.jsonl", [
      pi(),
      pi("claude-pi", "claude-opus-4-6", { provider: "anthropic" }),
    ]);
    write("claude/projects/a/log.jsonl", [
      claude("aug", "2026-09-01T00:30:00+02:00"),
      claude("sep", TIME),
    ]);
    const result = await json(["--provider", "claude", "--month", "2026-08"]);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({
      date: "2026-08-31",
      source: "claude-code",
    });
    expect(result.forecast).toHaveLength(1);
    expect(result.forecast[0]).toMatchObject({
      elapsedDays: 31,
      monthDays: 31,
    });
    const piResult = await json(["--provider", "codex"]);
    expect(piResult.daily).toHaveLength(1);
    expect(piResult.daily[0].source).toBe("pi");
  });

  it("keeps unpriced usage in token units, ignores Pi dollar claims and unrelated provider credentials", async () => {
    write("pi/sessions/log.jsonl", [
      pi("new", "new-model"),
      pi("other", "gpt-5.3-codex", { provider: "openai" }),
    ]);
    const result = await json(["--provider", "codex"]);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({
      model: "new-model",
      tokens: { inputTokens: 1000 },
      unpricedRecords: 1,
    });
    expect(result.forecast[0]).toMatchObject({
      status: "unknown",
      reason: "unpriced_usage",
    });
    const toon = await capture(["history", "--provider", "codex"]);
    expect(toon).toContain("unknown");
    expect(toon).not.toContain("999999");
  });

  it("reports no histories as unknown with exit 1, without invented zero-use daily rows", async () => {
    const result = await json();
    expect(result.daily).toEqual([]);
    expect(result.forecast.map((forecast) => forecast.reason)).toEqual([
      "no_records",
      "no_records",
    ]);
    expect(result.sources.every((source) => source.status === "absent")).toBe(
      true,
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["--month", "2026-13"],
    ["--month", "2026-9"],
    ["--month", "2027-01"],
    ["--month"],
    ["--provider", "cursor"],
    ["--provider", "claude,"],
    ["--provider"],
    ["--tui"],
    ["--allow-claude-inference"],
    ["--profile-only"],
    ["--month", "auth"],
  ])(
    "rejects invalid history flags %j before reading stores",
    async (...args) => {
      const output = await capture(["history", ...args]);
      expect(process.exitCode).toBe(2);
      expect(output).not.toContain("daily[");
    },
  );

  it("routes flag-first history and help/version through existing SDK conventions", async () => {
    write("pi/sessions/log.jsonl", [pi()]);
    const result = JSON.parse(
      await capture([
        "--provider",
        "codex",
        "--month",
        "2026-09",
        "history",
        "--json",
      ]),
    );
    expect(result.forecast).toHaveLength(1);
    expect(await capture(["history", "--help"])).toContain(
      "history [--month YYYY-MM]",
    );
    expect(await capture(["history", "--version"])).not.toContain("daily[");
  });
});

describe("honest partial-history failures", () => {
  it("refuses contradictory duplicate usage instead of inventing a component-wise maximum", async () => {
    write("pi/sessions/log.jsonl", [
      pi("same"),
      pi("same", "gpt-5.3-codex", {
        usage: {
          input: 500,
          output: 4000,
          cacheRead: 3000,
          cacheWrite: 0,
          reasoning: 1500,
        },
      }),
    ]);
    const result = await json(["--provider", "codex"]);
    expect(result.daily[0]).toMatchObject({
      records: 1,
      tokens: { inputTokens: 1000, outputTokens: 2000 },
    });
    expect(result.issues).toContainEqual({
      source: "pi",
      provider: "codex",
      reason: "conflicting_duplicate",
      count: 1,
    });
    expect(result.forecast[0].projectedMonthUsd).toBeUndefined();
  });

  it("does not silently price a future token-counter schema", async () => {
    const event = {
      type: "event_msg",
      timestamp: TIME,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 100,
            output_tokens: 100,
            audio_tokens: 50,
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 100,
            output_tokens: 100,
            audio_tokens: 50,
          },
        },
      },
    };
    write("codex/sessions/log.jsonl", [meta, context("gpt-5.3-codex"), event]);
    const result = await json(["--provider", "codex"]);
    expect(result.daily[0]).toMatchObject({
      tokens: { inputTokens: 1000 },
      unpricedReasons: ["unrecognized_token_counters"],
    });
    expect(result.daily[0].apiEquivalentUsd).toBeUndefined();
    expect(result.forecast[0]).toMatchObject({
      status: "unknown",
      reason: "unpriced_usage",
    });
  });

  it("keeps Pi usage with unknown cache retention as tokens, without assuming a 5m write", async () => {
    write("pi/sessions/log.jsonl", [
      pi("claude", "claude-opus-4-6", {
        provider: "anthropic",
        usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 1000 },
      }),
    ]);
    const result = await json(["--provider", "claude"]);
    expect(result.daily[0]).toMatchObject({
      tokens: { cacheWriteTokens: 1000 },
      unpricedReasons: ["cache_retention_unreported"],
    });
    expect(result.forecast[0].projectedMonthUsd).toBeUndefined();
  });

  it("rejects malformed counters, bad timestamps, missing identities, and partial JSONL without leaking the raw line", async () => {
    write("pi/sessions/log.jsonl", [
      pi(),
      pi("bad", "gpt-5.3-codex", {
        usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      {
        type: "message",
        timestamp: "bad-time",
        id: "x",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
      '{"PRIVATE BROKEN TRANSCRIPT":',
    ]);
    write("claude/projects/a/log.jsonl", [
      {
        type: "assistant",
        timestamp: TIME,
        message: {
          model: "claude-opus-4-6",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const result = await json();
    expect(result.issues.map((issue) => issue.reason)).toEqual(
      expect.arrayContaining([
        "invalid_usage",
        "invalid_timestamp",
        "malformed_jsonl",
        "missing_record_identity",
      ]),
    );
    expect(
      result.forecast.every(
        (forecast) => forecast.reason === "incomplete_history",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE BROKEN");
  });

  it("does not silently drop model-unattributed compaction or nested tool usage", async () => {
    write("pi/sessions/log.jsonl", [
      pi(),
      {
        type: "compaction",
        timestamp: TIME,
        usage: { input: 100, output: 100 },
      },
      {
        type: "message",
        timestamp: TIME,
        message: { role: "toolResult", usage: { input: 100, output: 100 } },
      },
    ]);
    const result = await json();
    expect(result.issues).toContainEqual({
      source: "pi",
      reason: "unattributed_pi_usage",
      count: 2,
    });
    expect(result.forecast[1].projectedMonthUsd).toBeUndefined();
  });

  it("discloses assistant usage with no provider attribution, but excludes explicit other providers", async () => {
    write("pi/sessions/log.jsonl", [
      pi("no-provider", "gpt-5.3-codex", { provider: undefined }),
      pi("other-provider", "gpt-5.3-codex", { provider: "openai" }),
    ]);
    const result = await json();
    expect(result.daily).toEqual([]);
    expect(result.issues).toContainEqual({
      source: "pi",
      reason: "unattributed_pi_usage",
      count: 1,
    });
    expect(result.forecast[1]).toMatchObject({
      status: "unknown",
      reason: "incomplete_history",
    });
  });

  it("skips symlinks and directory errors, leaving forecast unknown rather than silently undercounting", async () => {
    write("outside/log.jsonl", [pi()]);
    mkdirSync(join(root, "pi/sessions"), { recursive: true });
    symlinkSync(
      join(root, "outside/log.jsonl"),
      join(root, "pi/sessions/link.jsonl"),
    );
    write("claude/projects", ["not a directory"]);
    const result = await json();
    expect(result.daily).toEqual([]);
    expect(result.issues.map((issue) => issue.reason)).toContain(
      "symlink_skipped",
    );
    expect(result.issues.map((issue) => issue.reason)).toContain(
      "invalid_session_directory",
    );
  });

  it("bounds individual records but continues reading later valid usage", async () => {
    write("pi/sessions/log.jsonl", [
      JSON.stringify({ type: "message", text: "x".repeat(8 * 1024 * 1024) }),
      pi(),
    ]);
    const read = await readHistory("2026-09", NOW);
    expect(read.samples).toHaveLength(1);
    expect(read.issues).toContainEqual({
      source: "pi",
      reason: "oversized_jsonl_record",
      count: 1,
    });
  });
});
