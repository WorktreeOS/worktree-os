import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import {
  parseCodexModel,
  parseCodexTokenCount,
  TranscriptTelemetryReader,
} from "@worktreeos/daemon/terminal-layer/transcript-telemetry";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-codex-rollout-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Usage {
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}

function usageFields(u?: Usage): Record<string, number> | undefined {
  if (!u) return undefined;
  const o: Record<string, number> = {};
  if (u.input !== undefined) o.input_tokens = u.input;
  if (u.cached !== undefined) o.cached_input_tokens = u.cached;
  if (u.output !== undefined) o.output_tokens = u.output;
  if (u.reasoning !== undefined) o.reasoning_output_tokens = u.reasoning;
  if (u.total !== undefined) o.total_tokens = u.total;
  return o;
}

/**
 * A Codex `token_count` rollout line in the real shape: `total_token_usage`
 * (cumulative) and `last_token_usage` (latest turn) nested under `payload.info`.
 */
function tokenCountLine(opts: {
  total?: Usage;
  last?: Usage;
  window?: number;
}): string {
  const info: Record<string, unknown> = {};
  const t = usageFields(opts.total);
  const l = usageFields(opts.last);
  if (t) info.total_token_usage = t;
  if (l) info.last_token_usage = l;
  if (opts.window !== undefined) info.model_context_window = opts.window;
  return (
    JSON.stringify({
      timestamp: "2026-06-19T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info },
    }) + "\n"
  );
}

function sessionMetaLine(model: string): string {
  return (
    JSON.stringify({
      timestamp: "2026-06-19T00:00:00.000Z",
      type: "session_meta",
      payload: { model, model_provider: "openai", cwd: "/x" },
    }) + "\n"
  );
}

/** A real Codex `turn_context` line — where the model id actually lives. */
function turnContextLine(model: string): string {
  return (
    JSON.stringify({
      timestamp: "2026-06-19T00:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "t1", cwd: "/x", model, approval_policy: "on-request" },
    }) + "\n"
  );
}

async function setup(resolverAgent: "codex" | "claude" = "codex") {
  const r = createFakeTerminalRuntime();
  const mgr = new TerminalSessionManager({
    runtime: r.runtime,
    activeCommandResolver: () => ({
      pid: 1001,
      command: resolverAgent,
      args: resolverAgent,
      agent: resolverAgent,
    }),
  });
  const meta = await mgr.create({ worktreePath: tmp });
  const reader = new TranscriptTelemetryReader({
    terminalLayer: mgr,
    debounceMs: 0,
    pollIntervalMs: 60_000,
  });
  return { mgr, meta, reader };
}

async function waitFor(
  mgr: TerminalSessionManager,
  id: string,
  predicate: (t: ReturnType<TerminalSessionManager["get"]>) => boolean,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate(mgr.get(id))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for codex telemetry");
}

describe("codex rollout parsers", () => {
  test("spent mirrors Claude, context comes from the last-turn total", () => {
    const usage = parseCodexTokenCount(
      tokenCountLine({
        total: { input: 100, cached: 50, output: 20, reasoning: 5, total: 120 },
        last: { input: 30, cached: 10, output: 6, reasoning: 2, total: 36 },
      }).trim(),
    );
    // mainTokens = output (reasoning included) + uncached input (100 − 50), NOT
    // output + reasoning. contextUsed = last-turn total, NOT cumulative input.
    expect(usage).toEqual({ mainTokens: 70, contextUsed: 36 });
  });

  test("context uses the last-turn total, not the cumulative session input", () => {
    // Regression for the 839k bug: a long session's cumulative input + cached is
    // ~839k, but the real window occupancy after the last turn is ~34k. Reading
    // total_token_usage here reported a context far larger than the window.
    const usage = parseCodexTokenCount(
      tokenCountLine({
        total: {
          input: 443961,
          cached: 395520,
          output: 3011,
          reasoning: 725,
          total: 446972,
        },
        last: {
          input: 33799,
          cached: 33024,
          output: 362,
          reasoning: 147,
          total: 34161,
        },
        window: 353400,
      }).trim(),
    );
    expect(usage).toEqual({
      mainTokens: 51452, // output 3011 + uncached input (443961 − 395520)
      contextUsed: 34161,
      contextWindow: 353400,
    });
  });

  test("missing usage sub-fields count as zero", () => {
    const usage = parseCodexTokenCount(
      tokenCountLine({ total: { output: 20 }, last: { total: 100 } }).trim(),
    );
    expect(usage).toEqual({ mainTokens: 20, contextUsed: 100 });
  });

  test("a record without last_token_usage reports zero context", () => {
    const usage = parseCodexTokenCount(
      tokenCountLine({ total: { input: 100, output: 20 } }).trim(),
    );
    // mainTokens = output 20 + uncached input 100 (no cached field → 0 cached).
    expect(usage).toEqual({ mainTokens: 120, contextUsed: 0 });
  });

  test("tolerates totals nested directly under payload (no info wrapper)", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        total_token_usage: { output_tokens: 3 },
        last_token_usage: { total_tokens: 9 },
      },
    });
    expect(parseCodexTokenCount(line)).toEqual({ mainTokens: 3, contextUsed: 9 });
  });

  test("ignores non-token_count and unparseable records", () => {
    expect(parseCodexTokenCount(sessionMetaLine("gpt-5-codex").trim())).toBeNull();
    expect(
      parseCodexTokenCount(JSON.stringify({ type: "event_msg", payload: {} })),
    ).toBeNull();
    expect(parseCodexTokenCount("{not json")).toBeNull();
  });

  test("a null info (provider reports no usage) yields null", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: {} },
    });
    expect(parseCodexTokenCount(line)).toBeNull();
  });

  test("reads model_context_window from payload.info", () => {
    const line = tokenCountLine({
      total: { output: 2 },
      last: { total: 10 },
      window: 258400,
    }).trim();
    expect(parseCodexTokenCount(line)).toEqual({
      mainTokens: 2,
      contextUsed: 10,
      contextWindow: 258400,
    });
  });

  test("parseCodexModel reads the model from turn_context and session_meta", () => {
    // Real Codex 0.141.0 carries the model on turn_context, not session_meta.
    expect(parseCodexModel(turnContextLine("gpt-5.5").trim())).toBe("gpt-5.5");
    expect(parseCodexModel(sessionMetaLine("gpt-5-codex").trim())).toBe("gpt-5-codex");
    expect(parseCodexModel(tokenCountLine({ total: { output: 1 } }).trim())).toBeNull();
    expect(
      parseCodexModel(JSON.stringify({ type: "turn_context", payload: {} })),
    ).toBeNull();
  });
});

describe("codex rollout telemetry reader", () => {
  test("tracks the latest cumulative token_count (latest wins, not summed)", async () => {
    const { mgr, meta, reader } = await setup();
    const rollout = join(tmp, "rollout-1.jsonl");
    await writeFile(
      rollout,
      sessionMetaLine("gpt-5-codex") +
        tokenCountLine({ total: { output: 10 }, last: { total: 100 } }),
    );
    reader.bind(meta.id, rollout, "codex-sess", undefined, undefined, {
      agent: "codex",
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 10);

    // A later cumulative record supersedes the previous totals.
    await appendFile(
      rollout,
      tokenCountLine({ total: { output: 40 }, last: { total: 250 } }),
    );
    await reader.pollOnce();
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 40);

    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.model).toBe("gpt-5-codex");
    expect(t.mainTokens).toBe(40); // latest 40, NOT 10 + 40
    expect(t.contextUsed).toBe(250); // latest last-turn total, NOT cumulative
    expect(t.subagentTokens).toBe(0);
    expect(t.contextWindow).toBe(400_000); // gpt-5-codex window, not 1M
    reader.stop();
  });

  test("model falls back to the session_start model until session_meta is read", async () => {
    const { mgr, meta, reader } = await setup();
    const rollout = join(tmp, "rollout-2.jsonl");
    await writeFile(
      rollout,
      tokenCountLine({ total: { output: 2 }, last: { total: 5 } }),
    );
    reader.bind(meta.id, rollout, "codex-sess", undefined, undefined, {
      agent: "codex",
      model: "gpt-5-codex",
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 2);
    expect(mgr.get(meta.id)!.agentTelemetry!.model).toBe("gpt-5-codex");

    // session_meta now arrives and overrides the fallback.
    await appendFile(rollout, sessionMetaLine("gpt-5-codex-mini"));
    await reader.pollOnce();
    await waitFor(
      mgr,
      meta.id,
      (m) => m?.agentTelemetry?.model === "gpt-5-codex-mini",
    );
    reader.stop();
  });

  test("derives model from turn_context and window from token_count info", async () => {
    const { mgr, meta, reader } = await setup();
    const rollout = join(tmp, "rollout-tc.jsonl");
    // Real Codex shape: no model on session_meta; model on turn_context; the
    // real context window inside token_count.info.model_context_window.
    await writeFile(
      rollout,
      turnContextLine("gpt-5.5") +
        tokenCountLine({
          total: { input: 200, cached: 150, output: 12 },
          last: { input: 150, output: 12, total: 162 },
          window: 258400,
        }),
    );
    reader.bind(meta.id, rollout, "codex-sess", undefined, undefined, {
      agent: "codex",
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.model === "gpt-5.5");
    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.mainTokens).toBe(62); // output 12 + uncached input (200 − 150)
    expect(t.contextUsed).toBe(162);
    expect(t.contextWindow).toBe(258400); // from the rollout, not the static table
    reader.stop();
  });

  test("publishes model telemetry even when the provider reports no token usage", async () => {
    // Some Codex providers emit token_count with info:null — no usage at all.
    // The model is still known (seeded from the session_start event), so a
    // telemetry block must surface (model + window), just with zero tokens.
    const { mgr, meta, reader } = await setup();
    const rollout = join(tmp, "rollout-nousage.jsonl");
    await writeFile(
      rollout,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: {} },
      }) + "\n",
    );
    reader.bind(meta.id, rollout, "codex-sess", undefined, undefined, {
      agent: "codex",
      model: "z/glm-5.2",
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.model === "z/glm-5.2");
    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.mainTokens).toBe(0);
    expect(t.contextUsed).toBe(0);
    expect(t.contextWindow).toBe(1_048_576); // unknown model → safe default
    reader.stop();
  });

  test("a missing rollout file degrades to no telemetry", async () => {
    const { mgr, meta, reader } = await setup();
    reader.bind(meta.id, join(tmp, "does-not-exist.jsonl"), "codex-sess", undefined, undefined, {
      agent: "codex",
    });
    await reader.pollOnce();
    expect(mgr.get(meta.id)?.agentTelemetry).toBeUndefined();
    reader.stop();
  });
});

describe("claude reader regression (per-record summation unchanged)", () => {
  function assistantLine(output: number, input: number): string {
    return (
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          usage: { input_tokens: input, output_tokens: output },
        },
      }) + "\n"
    );
  }

  test("claude main tokens are summed across records, window stays 1M", async () => {
    const { mgr, meta, reader } = await setup("claude");
    const transcript = join(tmp, "claude-sess.jsonl");
    await writeFile(transcript, assistantLine(10, 2) + assistantLine(30, 5));
    // No options → defaults to the claude parser.
    reader.bind(meta.id, transcript, "claude-sess", "startup");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 40);

    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.mainTokens).toBe(40); // 10 + 30 summed, not latest-wins
    expect(t.contextWindow).toBe(1_048_576);
    reader.stop();
  });
});
