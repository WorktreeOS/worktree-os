import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TerminalBackendAdapter,
  TerminalBackendRestoreResult,
  TerminalBackendSession,
  TerminalTranscriptBinding,
} from "@worktreeos/daemon/terminal-layer/backend";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import {
  createFakeTerminalProcess,
  createFakeTerminalRuntime,
} from "@worktreeos/daemon/terminal-layer/testing";
import { TranscriptTelemetryReader } from "@worktreeos/daemon/terminal-layer/transcript-telemetry";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-transcript-restore-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function assistantLine(output: number, cacheRead = 0): string {
  return (
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 2,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
        },
      },
    }) + "\n"
  );
}

/**
 * Minimal restorable backend: re-adopts a single session carrying a persisted
 * transcript binding, mirroring how the tmux backend surfaces one after a
 * daemon restart.
 */
function restorableBackend(opts: {
  id: string;
  transcript?: TerminalTranscriptBinding;
}): TerminalBackendAdapter {
  const session: TerminalBackendSession = {
    id: opts.id,
    backend: "tmux",
    worktreePath: tmp,
    cwd: tmp,
    shell: "/bin/zsh",
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    meta: {},
  };
  return {
    id: "tmux",
    label: "tmux",
    isAvailable: () => ({ available: true }),
    async createSession() {
      throw new Error("not used");
    },
    async openTransport(s) {
      return createFakeTerminalProcess({
        shell: s.shell,
        cwd: s.cwd,
        env: {},
        cols: s.cols,
        rows: s.rows,
      }).process;
    },
    async restoreSessions(): Promise<TerminalBackendRestoreResult[]> {
      return [
        { session, ...(opts.transcript ? { transcript: opts.transcript } : {}) },
      ];
    },
    async onDaemonShutdown() {},
    async terminateSession() {},
  };
}

/** Replay daemon-server's restore wiring: re-bind every restored binding. */
function rebindRestored(
  restored: Awaited<ReturnType<TerminalSessionManager["restore"]>>,
  reader: TranscriptTelemetryReader,
): void {
  for (const entry of restored) {
    const t = entry.transcript;
    if (!t) continue;
    reader.bind(entry.metadata.id, t.path, t.agentSessionId, undefined, {
      mainCarry: t.mainCarry,
      subagentCarry: t.subagentCarry,
    });
  }
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
  throw new Error("timed out waiting for telemetry");
}

describe("transcript binding restore wiring", () => {
  test("recomputes telemetry from the transcript without a session_start event", async () => {
    const transcript = join(tmp, "restored.jsonl");
    // Fixture carries only assistant usage — no session_start hook event.
    await writeFile(transcript, assistantLine(5, 100));
    const mgr = new TerminalSessionManager({
      // Telemetry only surfaces while an agent is the foreground command.
      activeCommandResolver: () => ({
        pid: 1001,
        command: "claude",
        args: "claude",
        agent: "claude",
      }),
      backend: restorableBackend({
        id: "term_restore_tx",
        transcript: {
          path: transcript,
          agentSessionId: "restored",
          mainCarry: 40,
          subagentCarry: 0,
        },
      }),
    });
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 0,
      pollIntervalMs: 60_000,
    });

    const restored = await mgr.restore();
    rebindRestored(restored, reader);
    await waitFor(mgr, "term_restore_tx", (m) => m?.agentTelemetry !== undefined);

    const t = mgr.get("term_restore_tx")!.agentTelemetry!;
    // Seeded carry (40) + active transcript spend (5).
    expect(t.mainTokens).toBe(45);
    expect(t.model).toBe("claude-opus-4-8");
    reader.stop();
  });

  test("a missing transcript file degrades silently", async () => {
    const mgr = new TerminalSessionManager({
      backend: restorableBackend({
        id: "term_restore_missing",
        transcript: {
          path: join(tmp, "gone.jsonl"),
          agentSessionId: "gone",
          mainCarry: 0,
          subagentCarry: 0,
        },
      }),
    });
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 0,
      pollIntervalMs: 60_000,
    });

    const restored = await mgr.restore();
    rebindRestored(restored, reader);
    await reader.pollOnce();

    expect(mgr.get("term_restore_missing")!.agentTelemetry).toBeUndefined();
    reader.stop();
  });

  test("the default backend performs no re-bind", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const reader = new TranscriptTelemetryReader({
      terminalLayer: mgr,
      debounceMs: 0,
      pollIntervalMs: 60_000,
    });
    // The default backend has no restoreSessions → nothing to re-bind.
    const restored = await mgr.restore();
    expect(restored).toEqual([]);
    rebindRestored(restored, reader);
    reader.stop();
  });
});
