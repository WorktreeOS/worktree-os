import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import {
  parsePiAssistantRecord,
  TranscriptTelemetryReader,
} from "@worktreeos/daemon/terminal-layer/transcript-telemetry";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-pi-transcript-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface PiUsage {
  output?: number;
  cacheWrite?: number;
  input?: number;
  cacheRead?: number;
}

/**
 * A pi assistant JSONL record in the real shape:
 * `{ type: "message", message: { role: "assistant", model, usage } }`.
 */
function piAssistantLine(opts: { model?: string; usage?: PiUsage }): string {
  const usage: Record<string, number> = {};
  const u = opts.usage ?? {};
  if (u.output !== undefined) usage.output = u.output;
  if (u.cacheWrite !== undefined) usage.cacheWrite = u.cacheWrite;
  if (u.input !== undefined) usage.input = u.input;
  if (u.cacheRead !== undefined) usage.cacheRead = u.cacheRead;
  return (
    JSON.stringify({
      type: "message",
      id: "rec-1",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        usage,
      },
    }) + "\n"
  );
}

/** A pi user-message record (no usage) — the reader must skip it. */
function piUserLine(text: string): string {
  return (
    JSON.stringify({
      type: "message",
      id: "rec-u",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

async function setup() {
  const r = createFakeTerminalRuntime();
  const mgr = new TerminalSessionManager({
    runtime: r.runtime,
    activeCommandResolver: () => ({
      pid: 1001,
      command: "pi",
      args: "pi",
      agent: "pi",
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
  throw new Error("timed out waiting for pi telemetry");
}

describe("pi assistant parser", () => {
  test("spent = output + cacheWrite, context = input + cacheRead + cacheWrite", () => {
    const rec = parsePiAssistantRecord(
      piAssistantLine({
        model: "claude-sonnet-4-6",
        usage: { output: 20, cacheWrite: 5, input: 100, cacheRead: 50 },
      }).trim(),
    );
    expect(rec).toEqual({
      model: "claude-sonnet-4-6",
      spent: 25, // 20 + 5
      contextUsed: 155, // 100 + 50 + 5
    });
  });

  test("missing usage sub-fields count as zero", () => {
    const rec = parsePiAssistantRecord(
      piAssistantLine({ usage: { output: 10, input: 30 } }).trim(),
    );
    // cacheWrite / cacheRead absent → 0.
    expect(rec).toEqual({ spent: 10, contextUsed: 30 });
  });

  test("model comes from message.model", () => {
    const rec = parsePiAssistantRecord(
      piAssistantLine({ model: "gemini-2.5-pro", usage: { output: 1 } }).trim(),
    );
    expect(rec?.model).toBe("gemini-2.5-pro");
  });

  test("ignores user messages, non-message records, and unparseable lines", () => {
    // A user-role message carries no usage → skipped.
    expect(parsePiAssistantRecord(piUserLine("hi"))).toBeNull();
    // Non-message record types (session / model_change / text / thinking).
    expect(
      parsePiAssistantRecord(
        JSON.stringify({ type: "model_change", modelId: "x", provider: "y" }),
      ),
    ).toBeNull();
    expect(
      parsePiAssistantRecord(JSON.stringify({ type: "thinking", thinking: "…" })),
    ).toBeNull();
    // An assistant message with no usage block → null (not an error).
    expect(
      parsePiAssistantRecord(
        JSON.stringify({ type: "message", message: { role: "assistant" } }),
      ),
    ).toBeNull();
    expect(parsePiAssistantRecord("{not json")).toBeNull();
  });
});

describe("pi transcript telemetry reader", () => {
  test("sums mainTokens per record, context tracks the latest record", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "pi-sess.jsonl");
    // Interleave a user message (no usage) — it must be skipped, not summed.
    await writeFile(
      transcript,
      piUserLine("do the thing") +
        piAssistantLine({
          model: "claude-sonnet-4-6",
          usage: { output: 10, cacheWrite: 2, input: 50, cacheRead: 5 },
        }),
    );
    reader.bind(meta.id, transcript, "pi-sess", "startup", undefined, {
      agent: "pi",
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 12);

    // A second assistant record: mainTokens accumulate (summed), context = latest.
    await appendFile(
      transcript,
      piAssistantLine({
        model: "claude-sonnet-4-6",
        usage: { output: 30, cacheWrite: 0, input: 80, cacheRead: 10 },
      }),
    );
    await reader.pollOnce();
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 42);

    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.model).toBe("claude-sonnet-4-6");
    expect(t.mainTokens).toBe(42); // (10+2) + (30+0), summed
    expect(t.contextUsed).toBe(90); // latest record: 80 + 10 + 0, NOT summed
    expect(t.subagentTokens).toBe(0); // pi has no separate subagent transcripts
    expect(t.contextWindow).toBe(1_048_576); // claude → flat 1M
    reader.stop();
  });

  test("contextWindow prefers the bind option (pi's real window) over the lookup", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "pi-window.jsonl");
    // gpt-5-codex's lookup window is 400k; pi reports the exact window per model,
    // so the bind option must win — this is the path that fixes deepseek-v4-pro
    // being mis-reported as a guessed 128k instead of its real 1M.
    await writeFile(
      transcript,
      piAssistantLine({ model: "gpt-5-codex", usage: { output: 5, input: 9 } }),
    );
    reader.bind(meta.id, transcript, "pi-window", "startup", undefined, {
      agent: "pi",
      contextWindow: 1_048_576,
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.model === "gpt-5-codex");
    expect(mgr.get(meta.id)!.agentTelemetry!.contextWindow).toBe(1_048_576);
    reader.stop();
  });

  test("contextWindow falls back to the safe default when no option is given", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "pi-default.jsonl");
    // A model matching no lookup pattern, with no reported window → safe 1M
    // default (an honest approximation, not a wrong specific number).
    await writeFile(
      transcript,
      piAssistantLine({ model: "deepseek-v4-pro", usage: { output: 1, input: 2 } }),
    );
    reader.bind(meta.id, transcript, "pi-default", "startup", undefined, {
      agent: "pi",
    });
    await waitFor(
      mgr,
      meta.id,
      (m) => m?.agentTelemetry?.model === "deepseek-v4-pro",
    );
    expect(mgr.get(meta.id)!.agentTelemetry!.contextWindow).toBe(1_048_576);
    reader.stop();
  });

  test("a same-file rebind refreshes the window once pi reports it", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "pi-refresh.jsonl");
    await writeFile(
      transcript,
      piAssistantLine({
        model: "deepseek-v4-pro",
        usage: { output: 5, input: 9 },
      }),
    );
    // First bind (e.g. session_start) before pi has selected a model → no window
    // option, so the meter shows the safe default.
    reader.bind(meta.id, transcript, "pi-refresh", "startup", undefined, {
      agent: "pi",
    });
    await waitFor(
      mgr,
      meta.id,
      (m) => m?.agentTelemetry?.model === "deepseek-v4-pro",
    );
    expect(mgr.get(meta.id)!.agentTelemetry!.contextWindow).toBe(1_048_576);

    // A later same-file event reports the real window (a distinctive value, to
    // prove the refresh path rather than a coincidental default match).
    reader.bind(meta.id, transcript, "pi-refresh", undefined, undefined, {
      agent: "pi",
      contextWindow: 200_000,
    });
    await waitFor(
      mgr,
      meta.id,
      (m) => m?.agentTelemetry?.contextWindow === 200_000,
    );
    reader.stop();
  });

  test("a missing pi session file degrades to no telemetry", async () => {
    const { mgr, meta, reader } = await setup();
    reader.bind(meta.id, join(tmp, "nope.jsonl"), "pi-sess", undefined, undefined, {
      agent: "pi",
    });
    await reader.pollOnce();
    expect(mgr.get(meta.id)?.agentTelemetry).toBeUndefined();
    reader.stop();
  });
});
