import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePiAgentDirectory } from "./lib/pi-agent-dir.js";
import {
  HISTORY_PROVIDERS,
  historyMonthBounds,
  type HistoryIssue,
  type HistoryProvider,
  type HistoryRead,
  type HistorySample,
  type HistorySource,
  type HistorySourceState,
  type HistoryTokens,
} from "./history.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const modelName = (value: unknown): string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)
    ? value
    : "unknown";
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 100_000;

type SourceRoot = {
  source: HistorySource;
  roots: string[];
  provider?: HistoryProvider;
};

/** Opens only session JSONL files, never credentials, provider processes, APIs, or quota cache. */
export async function readHistory(
  month: string,
  generatedAt: string,
  providers: readonly HistoryProvider[] = HISTORY_PROVIDERS,
): Promise<HistoryRead> {
  const claudeHome =
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const roots: SourceRoot[] = [
    ...(providers.includes("claude")
      ? [
          {
            source: "claude-code" as const,
            roots: [join(claudeHome, "projects")],
            provider: "claude" as const,
          },
        ]
      : []),
    ...(providers.includes("codex")
      ? [
          {
            source: "codex-cli" as const,
            roots: [
              join(codexHome, "sessions"),
              join(codexHome, "archived_sessions"),
            ],
            provider: "codex" as const,
          },
        ]
      : []),
    {
      source: "pi",
      roots: [join(resolvePiAgentDirectory(), "sessions")],
    },
  ];
  const { start, end } = historyMonthBounds(month);
  const cutoff = Math.min(Date.parse(generatedAt), end);
  const samples = new Map<string, HistorySample>();
  const issues = new Map<string, HistoryIssue>();
  const sources: HistorySourceState[] = [];
  for (const root of roots) {
    const state: HistorySourceState = {
      source: root.source,
      status: "absent",
      filesRead: 0,
    };
    sources.push(state);
    const issue = (reason: string, provider = root.provider): void => {
      if (provider && !providers.includes(provider)) return;
      state.status = "partial";
      const key = `${root.source}:${provider ?? "both"}:${reason}`;
      const prior = issues.get(key);
      if (prior) prior.count++;
      else
        issues.set(key, {
          source: root.source,
          ...(provider ? { provider } : {}),
          reason,
          count: 1,
        });
    };
    const add = (sample: HistorySample): void => {
      if (!providers.includes(sample.provider)) return;
      const time = Date.parse(sample.timestamp);
      if (!Number.isFinite(time)) {
        issue("invalid_timestamp", sample.provider);
        return;
      }
      if (time < start || time >= end || time > cutoff) return;
      sample.timestamp = new Date(time).toISOString();
      const previous = samples.get(sample.key);
      if (!previous) {
        samples.set(sample.key, sample);
        return;
      }
      // Claude can persist the same response once per content block, with later usage updates.
      if (
        previous.provider !== sample.provider ||
        previous.model !== sample.model ||
        previous.timestamp.slice(0, 10) !== sample.timestamp.slice(0, 10) ||
        previous.inputIncludesCache !== sample.inputIncludesCache
      ) {
        issue("conflicting_duplicate", sample.provider);
        return;
      }
      const names = Object.keys(sample.tokens) as (keyof HistoryTokens)[];
      const increases = names.some(
        (name) => (sample.tokens[name] ?? 0) > (previous.tokens[name] ?? 0),
      );
      const decreases = names.some(
        (name) => (sample.tokens[name] ?? 0) < (previous.tokens[name] ?? 0),
      );
      if (increases && decreases)
        issue("conflicting_duplicate", sample.provider);
      else if (!decreases) previous.tokens = sample.tokens;
      if (sample.unpricedReason)
        previous.unpricedReason = sample.unpricedReason;
    };
    let files = 0;
    for (const directory of root.roots) {
      for await (const file of sessionFiles(directory, issue)) {
        if (++files > MAX_FILES) {
          issue("file_limit_reached");
          break;
        }
        if (state.status === "absent") state.status = "read";
        const parser = new SessionParser(
          root.source,
          add,
          issue,
          start,
          cutoff,
        );
        try {
          for await (const line of jsonLines(file, issue)) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              issue("malformed_jsonl");
              continue;
            }
            const row = object(parsed);
            if (!text(row.type)) {
              issue("invalid_jsonl_record");
              continue;
            }
            parser.accept(row);
          }
          state.filesRead++;
        } catch {
          issue("session_read_error");
        }
      }
    }
  }
  return {
    samples: [...samples.values()],
    issues: [...issues.values()],
    sources,
  };
}

async function* sessionFiles(
  root: string,
  issue: (reason: string) => void,
): AsyncGenerator<string> {
  const pending = [{ path: root, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    try {
      const stat = await lstat(item.path);
      if (stat.isSymbolicLink()) {
        issue("symlink_skipped");
        continue;
      }
      if (!stat.isDirectory()) {
        issue("invalid_session_directory");
        continue;
      }
      const entries = await readdir(item.path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const path = join(item.path, entry.name);
        if (entry.isSymbolicLink()) {
          issue("symlink_skipped");
          continue;
        }
        if (entry.isDirectory()) {
          if (item.depth >= 32) issue("directory_depth_exceeded");
          else pending.push({ path, depth: item.depth + 1 });
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
      }
    } catch (error) {
      if (item.depth === 0 && object(error).code === "ENOENT") continue;
      issue("session_directory_read_error");
    }
  }
}

/** Bound memory even when a transcript contains one enormous tool-output line. */
async function* jsonLines(
  file: string,
  issue: (reason: string) => void,
): AsyncGenerator<string> {
  let parts: Uint8Array[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const raw of createReadStream(file)) {
    const chunk = new Uint8Array(raw as Buffer);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const stop = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, stop);
      bytes += part.length;
      if (bytes > MAX_LINE_BYTES) {
        if (!oversized) issue("oversized_jsonl_record");
        oversized = true;
        parts = [];
      } else if (!oversized) parts.push(part);
      if (newline >= 0) {
        if (!oversized && bytes) yield Buffer.concat(parts).toString("utf8");
        parts = [];
        bytes = 0;
        oversized = false;
      }
      offset = stop + 1;
    }
  }
  // A complete last line is valid without LF; an in-progress partial line is disclosed by JSON parsing.
  if (!oversized && bytes) yield Buffer.concat(parts).toString("utf8");
}

class SessionParser {
  private sessionId: string | undefined;
  private model = "unknown";
  private previousTotals: HistoryTokens | undefined;
  constructor(
    private source: HistorySource,
    private add: (sample: HistorySample) => void,
    private issue: (reason: string, provider?: HistoryProvider) => void,
    private start: number,
    private cutoff: number,
  ) {}

  accept(row: ObjectValue): void {
    if (this.source === "codex-cli") this.codex(row);
    else if (this.source === "claude-code") this.claude(row);
    else this.pi(row);
  }

  private relevant(timestamp: unknown): boolean {
    const time = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    return (
      !Number.isFinite(time) || (time >= this.start && time <= this.cutoff)
    );
  }

  private emit(
    row: ObjectValue,
    provider: HistoryProvider,
    model: unknown,
    tokens: HistoryTokens | undefined,
    key: string | undefined,
    unpricedReason?: string,
  ): void {
    if (!this.relevant(row.timestamp)) return;
    if (!tokens || !validTokens(tokens, this.source === "codex-cli")) {
      this.issue("invalid_usage", provider);
      return;
    }
    if (!key) {
      this.issue("missing_record_identity", provider);
      return;
    }
    this.add({
      key,
      timestamp: text(row.timestamp) ?? "",
      provider,
      source: this.source,
      model: modelName(model),
      inputIncludesCache: this.source === "codex-cli",
      tokens,
      ...(unpricedReason ? { unpricedReason } : {}),
    });
  }

  private claude(row: ObjectValue): void {
    if (row.type !== "assistant") return;
    const message = object(row.message);
    if (!this.relevant(row.timestamp)) return;
    const usage = object(message.usage);
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const writes = count(usage.cache_creation_input_tokens ?? 0);
    const creation = object(usage.cache_creation);
    const five = count(creation.ephemeral_5m_input_tokens);
    const hour = count(creation.ephemeral_1h_input_tokens);
    const id = text(message.id);
    this.emit(
      row,
      "claude",
      message.model,
      input === undefined || output === undefined || writes === undefined
        ? undefined
        : {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: count(usage.cache_read_input_tokens ?? 0) ?? NaN,
            cacheWriteTokens: writes,
            ...(five !== undefined &&
            hour !== undefined &&
            five + hour === writes
              ? { cacheWrite1hTokens: hour }
              : {}),
          },
      id ? `response:claude:${id}` : undefined,
      unfamiliarCounters(usage, [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ])
        ? "unrecognized_token_counters"
        : usage.cache_creation !== undefined &&
            (five === undefined || hour === undefined || five + hour !== writes)
          ? "inconsistent_cache_retention"
          : undefined,
    );
  }

  private pi(row: ObjectValue): void {
    const message = row.type === "message" ? object(row.message) : row;
    if (
      row.type !== "usage" &&
      !(row.type === "message" && message.role === "assistant")
    ) {
      if (
        row.usage !== undefined ||
        (row.type === "message" && message.usage !== undefined)
      ) {
        if (this.relevant(row.timestamp)) this.issue("unattributed_pi_usage");
      }
      return;
    }
    const provider =
      message.provider === "anthropic"
        ? "claude"
        : message.provider === "openai-codex"
          ? "codex"
          : undefined;
    if (!provider) {
      const attributed =
        typeof message.provider === "string" && message.provider.length > 0;
      if (
        !attributed &&
        message.usage !== undefined &&
        this.relevant(row.timestamp)
      )
        this.issue("unattributed_pi_usage");
      return;
    }
    const usage = object(message.usage);
    const responseId = text(message.responseId);
    const id = text(row.id);
    const model = message.responseModel ?? message.model;
    // Entry IDs and timestamps survive Pi /fork and /clone; a response ID is stronger when present.
    const key = responseId
      ? `response:${provider}:${responseId}`
      : id && text(row.timestamp)
        ? `pi:${provider}:${id}:${String(row.timestamp)}:${modelName(model)}`
        : undefined;
    this.emit(
      row,
      provider,
      model,
      {
        inputTokens: count(usage.input) ?? NaN,
        outputTokens: count(usage.output) ?? NaN,
        cacheReadTokens: count(usage.cacheRead) ?? NaN,
        cacheWriteTokens: count(usage.cacheWrite) ?? NaN,
        ...(usage.cacheWrite1h !== undefined
          ? { cacheWrite1hTokens: count(usage.cacheWrite1h) ?? NaN }
          : {}),
        ...(usage.reasoning !== undefined
          ? { reasoningOutputTokens: count(usage.reasoning) ?? NaN }
          : {}),
      },
      key,
      Object.keys(usage).some(
        (name) =>
          ![
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "cacheWrite1h",
            "reasoning",
            "totalTokens",
            "cost",
          ].includes(name),
      )
        ? "unrecognized_token_counters"
        : undefined,
    );
  }

  private codex(row: ObjectValue): void {
    const payload = object(row.payload);
    if (row.type === "session_meta") {
      this.sessionId = text(payload.id);
      return;
    }
    if (row.type === "turn_context") {
      this.model = modelName(payload.model);
      return;
    }
    if (
      row.type !== "event_msg" ||
      payload.type !== "token_count" ||
      payload.info == null
    )
      return;
    const info = object(payload.info);
    const totals = codexTokens(info.total_token_usage);
    const last = codexTokens(info.last_token_usage);
    if (!totals || !validTokens(totals, true)) {
      if (this.relevant(row.timestamp))
        this.issue("invalid_cumulative_usage", "codex");
      this.previousTotals = undefined;
      return;
    }
    const previous = this.previousTotals;
    this.previousTotals = totals;
    let delta = last;
    if (previous) {
      delta = subtract(totals, previous);
      if (!validTokens(delta, true)) {
        if (this.relevant(row.timestamp))
          this.issue("cumulative_counter_reset", "codex");
        delta = last;
      } else if (delta.inputTokens === 0 && delta.outputTokens === 0) return;
    } else if (!last || !sameTokens(totals, last)) {
      // A truncated/forked log's first cumulative total is not spend at this timestamp.
      if (this.relevant(row.timestamp))
        this.issue("unattributed_cumulative_usage", "codex");
    }
    const key = this.sessionId
      ? `codex:${this.sessionId}:${String(row.timestamp)}:${JSON.stringify(totals)}`
      : undefined;
    this.emit(
      row,
      "codex",
      this.model,
      delta,
      key,
      unfamiliarCounters(object(info.total_token_usage), [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
      ])
        ? "unrecognized_token_counters"
        : undefined,
    );
  }
}

function unfamiliarCounters(usage: ObjectValue, known: string[]): boolean {
  return Object.entries(usage).some(
    ([name, value]) =>
      name.endsWith("_tokens") && !known.includes(name) && value !== 0,
  );
}

function codexTokens(value: unknown): HistoryTokens | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = object(value);
  return {
    inputTokens: count(usage.input_tokens) ?? NaN,
    outputTokens: count(usage.output_tokens) ?? NaN,
    cacheReadTokens: count(usage.cached_input_tokens) ?? NaN,
    cacheWriteTokens: 0,
    ...(usage.reasoning_output_tokens !== undefined
      ? { reasoningOutputTokens: count(usage.reasoning_output_tokens) ?? NaN }
      : {}),
  };
}

function validTokens(tokens: HistoryTokens, includesCache: boolean): boolean {
  return (
    Object.values(tokens).every((value) => count(value) !== undefined) &&
    (!includesCache || tokens.cacheReadTokens <= tokens.inputTokens) &&
    (tokens.cacheWrite1hTokens ?? 0) <= tokens.cacheWriteTokens &&
    (tokens.reasoningOutputTokens ?? 0) <= tokens.outputTokens
  );
}
function subtract(
  current: HistoryTokens,
  previous: HistoryTokens,
): HistoryTokens {
  return Object.fromEntries(
    Object.entries(current).map(([key, value]) => [
      key,
      value - (previous[key as keyof HistoryTokens] ?? 0),
    ]),
  ) as HistoryTokens;
}
function sameTokens(a: HistoryTokens, b: HistoryTokens): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
