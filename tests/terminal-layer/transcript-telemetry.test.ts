import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TELEMETRY_CONTEXT_WINDOW,
  STALE_DEMOTION_EVENT,
} from "@worktreeos/core/agent-activity";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import { TranscriptTelemetryReader } from "@worktreeos/daemon/terminal-layer/transcript-telemetry";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-transcript-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function assistantLine(opts: {
  model?: string;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  input?: number;
  sidechain?: boolean;
}): string {
  return (
    JSON.stringify({
      type: "assistant",
      isSidechain: opts.sidechain ?? false,
      message: {
        role: "assistant",
        model: opts.model ?? "claude-opus-4-8",
        usage: {
          input_tokens: opts.input ?? 2,
          output_tokens: opts.output ?? 0,
          cache_creation_input_tokens: opts.cacheCreate ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
        },
      },
    }) + "\n"
  );
}

const SERVICE_LINES =
  JSON.stringify({ type: "attachment", attachment: { type: "x" } }) +
  "\n" +
  JSON.stringify({ type: "ai-title", title: "t" }) +
  "\n" +
  JSON.stringify({ type: "future-unknown-type", weird: [1, 2] }) +
  "\n";

async function setup() {
  const r = createFakeTerminalRuntime();
  // Telemetry only surfaces while an agent is the foreground command, so the
  // fake runtime needs a resolver that reports one.
  const mgr = new TerminalSessionManager({
    runtime: r.runtime,
    activeCommandResolver: () => ({
      pid: 1001,
      command: "claude",
      args: "claude",
      agent: "claude",
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

/** Wait until the session snapshot satisfies `predicate` (or time out). */
async function waitFor(
  mgr: TerminalSessionManager,
  id: string,
  predicate: (t: ReturnType<TerminalSessionManager["get"]>) => boolean,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate(mgr.get(id))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for telemetry");
}

describe("TranscriptTelemetryReader", () => {
  test("derives model, spent tokens, and context usage from assistant records", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "sess-1.jsonl");
    await writeFile(
      transcript,
      SERVICE_LINES +
        assistantLine({ output: 100, cacheCreate: 50, cacheRead: 1000 }) +
        assistantLine({
          model: "claude-fable-5",
          output: 200,
          cacheCreate: 30,
          cacheRead: 2000,
          input: 5,
        }),
    );
    reader.bind(meta.id, transcript, "sess-1", "startup");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry !== undefined);

    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.model).toBe("claude-fable-5");
    expect(t.mainTokens).toBe(100 + 50 + 200 + 30);
    expect(t.subagentTokens).toBe(0);
    expect(t.contextUsed).toBe(5 + 2000 + 30);
    expect(t.contextWindow).toBe(AGENT_TELEMETRY_CONTEXT_WINDOW);
    reader.stop();
  });

  test("tails appended records and ignores a partial trailing line", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "sess-2.jsonl");
    await writeFile(transcript, assistantLine({ output: 10 }));
    reader.bind(meta.id, transcript, "sess-2");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 10);

    // Append a complete record plus a partial line (no trailing newline).
    await appendFile(
      transcript,
      assistantLine({ output: 7 }) + '{"type":"assistant","mess',
    );
    await reader.pollOnce();
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 17);

    // Complete the partial line; it must be counted exactly once.
    await appendFile(
      transcript,
      'age":{"model":"claude-opus-4-8","usage":{"output_tokens":3}}}\n',
    );
    await reader.pollOnce();
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 20);
    reader.stop();
  });

  test("sidechain and synthetic records never drive model or context", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "sess-3.jsonl");
    await writeFile(
      transcript,
      assistantLine({ output: 10, cacheRead: 500 }) +
        assistantLine({
          sidechain: true,
          model: "claude-haiku-4-5",
          output: 99,
          cacheRead: 9999,
        }) +
        assistantLine({ model: "<synthetic>", output: 0, cacheRead: 700 }),
    );
    reader.bind(meta.id, transcript, "sess-3");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry !== undefined);

    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.model).toBe("claude-opus-4-8");
    // Sidechain spends count toward the main file total…
    expect(t.mainTokens).toBe(10 + 99);
    // …but context tracks the latest non-sidechain record (the synthetic-model
    // one still carries real usage).
    expect(t.contextUsed).toBe(2 + 700);
    reader.stop();
  });

  test("a trailing all-zero synthetic record never zeroes contextUsed", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "sess-zero.jsonl");
    // Resumed transcripts often end with a synthetic interrupt record whose
    // usage block is entirely zero — context must keep the last real value.
    await writeFile(
      transcript,
      assistantLine({ output: 10, cacheRead: 500 }) +
        assistantLine({ model: "<synthetic>", input: 0, output: 0 }),
    );
    reader.bind(meta.id, transcript, "sess-zero");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry !== undefined);
    expect(mgr.get(meta.id)!.agentTelemetry!.contextUsed).toBe(2 + 500);
    reader.stop();
  });

  test("missing transcript yields no telemetry and no error", async () => {
    const { mgr, meta, reader } = await setup();
    reader.bind(meta.id, join(tmp, "missing.jsonl"), "sess-4");
    await reader.pollOnce();
    expect(mgr.get(meta.id)!.agentTelemetry).toBeUndefined();
    reader.stop();
  });

  test("clear rebind resets totals; compact rebind preserves spent totals", async () => {
    const { mgr, meta, reader } = await setup();
    const first = join(tmp, "sess-5.jsonl");
    await writeFile(first, assistantLine({ output: 40, cacheRead: 4000 }));
    reader.bind(meta.id, first, "sess-5", "startup");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 40);

    // /compact: new transcript, spent totals carry over, context restarts.
    const compacted = join(tmp, "sess-6.jsonl");
    await writeFile(compacted, assistantLine({ output: 5, cacheRead: 100 }));
    reader.bind(meta.id, compacted, "sess-6", "compact");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 45);
    expect(mgr.get(meta.id)!.agentTelemetry!.contextUsed).toBe(2 + 100);

    // /clear: fresh session, totals reset.
    const cleared = join(tmp, "sess-7.jsonl");
    await writeFile(cleared, assistantLine({ output: 8 }));
    reader.bind(meta.id, cleared, "sess-7", "clear");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 8);
    reader.stop();
  });

  test("rebind to an empty new transcript resets telemetry immediately", async () => {
    const { mgr, meta, reader } = await setup();
    const first = join(tmp, "sess-old.jsonl");
    await writeFile(first, assistantLine({ output: 40, cacheRead: 4000 }));
    reader.bind(meta.id, first, "sess-old", "startup");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 40);

    // New Claude session: the transcript file does not exist yet, so no
    // read-driven publish fires — the rebind itself must wipe stale telemetry.
    const next = join(tmp, "sess-new.jsonl");
    reader.bind(meta.id, next, "sess-new", "startup");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 0);
    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.contextUsed).toBe(0);
    expect(t.subagentTokens).toBe(0);
    expect(t.model).toBeUndefined();
    reader.stop();
  });

  test("subagent transcripts feed subagentTokens only", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "sess-8.jsonl");
    await writeFile(transcript, assistantLine({ output: 10, cacheRead: 300 }));
    const subDir = join(tmp, "sess-8", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "agent-abc123.jsonl"),
      assistantLine({ model: "claude-haiku-4-5", output: 500, cacheCreate: 20, cacheRead: 9000 }),
    );
    await writeFile(join(subDir, "notes.txt"), "not a transcript");

    reader.bind(meta.id, transcript, "sess-8");
    await waitFor(
      mgr,
      meta.id,
      (m) => m?.agentTelemetry?.subagentTokens === 520,
    );
    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.mainTokens).toBe(10);
    expect(t.model).toBe("claude-opus-4-8");
    expect(t.contextUsed).toBe(2 + 300);
    reader.stop();
  });

  test("unbind clears the telemetry block", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "sess-9.jsonl");
    await writeFile(transcript, assistantLine({ output: 1 }));
    reader.bind(meta.id, transcript, "sess-9");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry !== undefined);
    reader.unbind(meta.id);
    expect(mgr.get(meta.id)!.agentTelemetry).toBeUndefined();
    reader.stop();
  });

  test("bind persists the binding key and compact carry through the manager", async () => {
    const { mgr, meta, reader } = await setup();
    const calls: Array<{ id: string; binding: unknown }> = [];
    const original = mgr.persistTranscriptBinding.bind(mgr);
    mgr.persistTranscriptBinding = (id, binding) => {
      calls.push({ id, binding });
      original(id, binding);
    };

    const first = join(tmp, "persist-1.jsonl");
    await writeFile(first, assistantLine({ output: 40, cacheRead: 4000 }));
    reader.bind(meta.id, first, "persist-1", "startup");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 40);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: meta.id,
      binding: {
        path: first,
        agentSessionId: "persist-1",
        mainCarry: 0,
        subagentCarry: 0,
        agent: "claude",
      },
    });

    // A compact rebind persists the grown carry (previous spent folded in).
    const compacted = join(tmp, "persist-2.jsonl");
    await writeFile(compacted, assistantLine({ output: 5 }));
    reader.bind(meta.id, compacted, "persist-2", "compact");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 45);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      id: meta.id,
      binding: {
        path: compacted,
        agentSessionId: "persist-2",
        mainCarry: 40,
        subagentCarry: 0,
        agent: "claude",
      },
    });

    // unbind clears the persisted binding.
    reader.unbind(meta.id);
    expect(calls[2]).toEqual({ id: meta.id, binding: undefined });
    reader.stop();
  });

  test("seed-carry restores the pre-compact total on a fresh reader", async () => {
    const { mgr, meta } = await setup();
    // A fresh reader (as after a daemon restart) has no in-memory previous
    // binding; the persisted carry is seeded explicitly.
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 0,
      pollIntervalMs: 60_000,
    });
    const transcript = join(tmp, "restored.jsonl");
    await writeFile(transcript, assistantLine({ output: 5, cacheRead: 100 }));
    reader.bind(meta.id, transcript, "restored", undefined, {
      mainCarry: 40,
      subagentCarry: 7,
    });
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 45);
    const t = mgr.get(meta.id)!.agentTelemetry!;
    expect(t.mainTokens).toBe(40 + 5);
    expect(t.subagentTokens).toBe(7);
    reader.stop();
  });

  test("publishes are debounced per session", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      activeCommandResolver: () => ({
        pid: 1001,
        command: "claude",
        args: "claude",
        agent: "claude",
      }),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 10_000,
      pollIntervalMs: 60_000,
    });
    const transcript = join(tmp, "sess-10.jsonl");
    await writeFile(transcript, assistantLine({ output: 1 }));
    reader.bind(meta.id, transcript, "sess-10");
    // First publish goes out immediately (lastPublishedAt = 0).
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 1);

    // A follow-up within the debounce window stays pending.
    await appendFile(transcript, assistantLine({ output: 2 }));
    await reader.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mgr.get(meta.id)!.agentTelemetry!.mainTokens).toBe(1);
    reader.stop();
  });

  function aiTitleLine(title: string): string {
    return JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "s" }) + "\n";
  }

  test("ai-title records set the agent-sourced session title, latest wins", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "title-1.jsonl");
    await writeFile(
      transcript,
      aiTitleLine("Draft title") +
        assistantLine({ output: 1 }) +
        aiTitleLine("Migrate docs to Docusaurus"),
    );
    reader.bind(meta.id, transcript, "title-1");
    await waitFor(
      mgr,
      meta.id,
      (m) => m?.title === "Migrate docs to Docusaurus",
    );
    expect(mgr.get(meta.id)!.titleSource).toBe("agent");
    expect(reader.aiTitle(meta.id)).toBe("Migrate docs to Docusaurus");
    reader.stop();
  });

  test("ai-title never replaces a user-sourced title", async () => {
    const { mgr, meta, reader } = await setup();
    await mgr.rename(meta.id, "my name");
    const transcript = join(tmp, "title-2.jsonl");
    await writeFile(transcript, aiTitleLine("AI name") + assistantLine({ output: 1 }));
    reader.bind(meta.id, transcript, "title-2");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 1);
    expect(mgr.get(meta.id)!.title).toBe("my name");
    expect(mgr.get(meta.id)!.titleSource).toBe("user");
    reader.stop();
  });

  function activityEvent(
    event: string,
    at: string,
  ): Parameters<TerminalSessionManager["applyAgentActivity"]>[1] {
    return {
      v: 1,
      eventId: `ev-${event}-${at}`,
      agent: "claude",
      event,
      agentSessionId: "act-1",
      cwd: "/",
      at,
      severity: "info",
    };
  }

  test("transcript growth refreshes a working block's freshness", async () => {
    const { mgr, meta } = await setup();
    const refreshedAt = "2026-06-12T12:05:00.000Z";
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 0,
      pollIntervalMs: 60_000,
      now: () => Date.parse(refreshedAt),
    });
    const startedAt = "2026-06-12T12:00:00.000Z";
    const block = mgr.applyAgentActivity(
      meta.id,
      activityEvent("prompt_submit", startedAt),
    )!.activity!;
    expect(block.lastEventAt).toBe(startedAt);

    const transcript = join(tmp, "liveness.jsonl");
    // Non-assistant records count as liveness too.
    await writeFile(transcript, SERVICE_LINES);
    reader.bind(meta.id, transcript, "liveness");
    // The bind-triggered read is async; poll until the refresh lands.
    for (let i = 0; i < 100 && block.lastEventAt !== refreshedAt; i++) {
      await reader.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(block.state).toBe("working");
    expect(block.lastEventAt).toBe(refreshedAt);
    reader.stop();
  });

  test("transcript growth never resumes an awaiting-input block", async () => {
    const { mgr, meta } = await setup();
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 0,
      pollIntervalMs: 60_000,
    });
    const askedAt = "2026-06-12T12:00:00.000Z";
    const block = mgr.applyAgentActivity(
      meta.id,
      activityEvent("question_asked", askedAt),
    )!.activity!;

    const transcript = join(tmp, "awaiting.jsonl");
    await writeFile(transcript, assistantLine({ output: 1 }));
    reader.bind(meta.id, transcript, "awaiting");
    // Telemetry publishing proves the read (and any refresh) has happened.
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 1);
    expect(block.state).toBe("awaiting-input");
    expect(block.lastEventAt).toBe(askedAt);
    reader.stop();
  });

  test("subagent transcript growth resurrects a stale idle to working", async () => {
    const { mgr, meta, reader } = await setup();
    const main = join(tmp, "sub-main.jsonl");
    await writeFile(main, assistantLine({ output: 1 }));
    reader.bind(meta.id, main, "subsess");
    // Consume the main transcript first so later growth is subagent-only.
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 1);

    // Drive the session into a soft staleness idle (the sweep's guess).
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-12T12:00:00.000Z"));
    mgr.applyAgentActivity(meta.id, activityEvent(STALE_DEMOTION_EVENT, "2026-06-12T12:01:30.000Z"));
    expect(mgr.get(meta.id)?.agentActivity?.state).toBe("idle");
    expect(mgr.get(meta.id)?.agentActivity?.idleKind).toBe("stale");

    // A subagent appends while the main transcript stays quiet.
    const subDir = join(tmp, "subsess", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-abc.jsonl"), assistantLine({ output: 5 }));
    await reader.pollOnce();

    await waitFor(mgr, meta.id, (m) => m?.agentActivity?.state === "working");
    expect(mgr.get(meta.id)?.agentActivity?.idleKind).toBeUndefined();
    reader.stop();
  });

  test("transcript growth does not disturb a hook-stop idle", async () => {
    const { mgr, meta, reader } = await setup();
    const transcript = join(tmp, "stopped.jsonl");
    await writeFile(transcript, assistantLine({ output: 1 }));
    reader.bind(meta.id, transcript, "stopsess");
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 1);

    // A real hook stop: a hard, sticky idle.
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-12T12:00:00.000Z"));
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-12T12:00:10.000Z"));
    expect(mgr.get(meta.id)?.agentActivity?.idleKind).toBe("stop");

    // A trailing summary/title record written after the turn ended must not
    // flip a genuinely-finished turn back to working.
    await appendFile(transcript, assistantLine({ output: 2 }));
    await reader.pollOnce();
    await waitFor(mgr, meta.id, (m) => m?.agentTelemetry?.mainTokens === 3);

    expect(mgr.get(meta.id)?.agentActivity?.state).toBe("idle");
    expect(mgr.get(meta.id)?.agentActivity?.idleKind).toBe("stop");
    reader.stop();
  });
});
