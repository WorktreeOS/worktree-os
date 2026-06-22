import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createDefaultTerminalBackend } from "@worktreeos/daemon/terminal-layer/default-backend";
import { createTmuxTerminalBackend } from "@worktreeos/daemon/terminal-layer/tmux-backend";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import type {
  TerminalBackendAdapter,
  TerminalBackendSession,
} from "@worktreeos/daemon/terminal-layer/backend";
import { DaemonEventBus } from "@worktreeos/daemon/event-bus";
import { NotificationEngine } from "@worktreeos/daemon/notifications/engine";
import type { NotificationChannel } from "@worktreeos/daemon/notifications/channels/types";
import {
  defaultNotificationsConfig,
  type Notification,
  type NotificationsConfig,
} from "@worktreeos/core/notifications";
import type { AgentActivityChangedEvent } from "@worktreeos/core/unified-events";

const IS_WIN = process.platform === "win32";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-snapshot-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("default backend captureScreenSnapshot", () => {
  test("reports no snapshot available (no screen grid)", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const created = await backend.createSession({
      id: "t1",
      worktreePath: tmp,
      cwd: tmp,
      shell: "/bin/zsh",
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    const result = await backend.captureScreenSnapshot!(created.session);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("screen grid");
  });
});

describe("manager captureScreenSnapshot", () => {
  // A default backend with an injected capture capability lets us exercise the
  // manager wiring (bundling the snapshot with agent identity) without tmux.
  function captureBackend(): TerminalBackendAdapter {
    const r = createFakeTerminalRuntime();
    const base = createDefaultTerminalBackend({ runtime: r.runtime });
    return {
      ...base,
      async captureScreenSnapshot() {
        return {
          available: true as const,
          snapshot: { lines: ["\x1b[31mhello\x1b[0m", "world"], cols: 120, rows: 40 },
        };
      },
    };
  }

  test("returns flat SGR rows + geometry bundled with session metadata", async () => {
    const mgr = new TerminalSessionManager({
      backend: captureBackend(),
      // Agent identity comes from the daemon's active-command detection, not
      // any tmux pane_current_command — inject it deterministically here.
      activeCommandResolver: () => ({
        pid: 4242,
        command: "claude",
        args: "",
        agent: "claude",
      }),
    });
    const meta = await mgr.create({ worktreePath: tmp });

    const promise = mgr.captureScreenSnapshot(meta.id);
    // Capture is async (non-blocking): the manager returns a Promise.
    expect(promise).toBeInstanceOf(Promise);
    const captured = await promise;

    expect(captured).not.toBeNull();
    expect(captured!.session.id).toBe(meta.id);
    expect(captured!.session.activeCommand?.agent).toBe("claude");
    expect(captured!.snapshot.available).toBe(true);
    if (captured!.snapshot.available) {
      expect(captured!.snapshot.snapshot.lines).toEqual([
        "\x1b[31mhello\x1b[0m",
        "world",
      ]);
      expect(captured!.snapshot.snapshot.cols).toBe(120);
      expect(captured!.snapshot.snapshot.rows).toBe(40);
    }
  });

  test("returns null for an unknown session", async () => {
    const mgr = new TerminalSessionManager({ backend: captureBackend() });
    expect(await mgr.captureScreenSnapshot("does-not-exist")).toBeNull();
  });
});

// Real tmux capture: POSIX-only, gated on a tmux binary being present. Mirrors
// the live-tmux gating in tmux-backend.test.ts.
const tmuxAvailable = (() => {
  if (IS_WIN) return false;
  try {
    return spawnSync("tmux", ["-V"], { timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
})();
const liveTmux = tmuxAvailable ? test : test.skip;

describe("tmux backend captureScreenSnapshot (live)", () => {
  liveTmux("captures the current screen as flat rows with geometry", async () => {
    const socket = `wos-snap-${process.pid}-${Date.now()}`;
    const sock = ["-L", socket];
    const sessionName = "wos-term-snaptest";
    // Create a detached tmux session on an isolated socket directly, then ask
    // the backend to capture it. echo gives deterministic visible content.
    const create = spawnSync("tmux", [
      ...sock,
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "100",
      "-y",
      "30",
      "sh",
      "-c",
      "printf 'SNAPSHOT_MARKER\\n'; sleep 30",
    ]);
    expect(create.status).toBe(0);
    try {
      // Give the shell a beat to render the marker into the pane.
      await Bun.sleep(200);
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: tmp,
        socketName: socket,
      });
      const session: TerminalBackendSession = {
        id: "snaptest",
        backend: "tmux",
        worktreePath: tmp,
        cwd: tmp,
        shell: "sh",
        cols: 100,
        rows: 30,
        createdAt: new Date().toISOString(),
        meta: { tmuxSessionName: sessionName },
      };
      const result = await backend.captureScreenSnapshot!(session);
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.snapshot.lines.join("\n")).toContain("SNAPSHOT_MARKER");
        expect(result.snapshot.cols).toBe(100);
        expect(result.snapshot.rows).toBe(30);
      }
    } finally {
      spawnSync("tmux", [...sock, "kill-server"]);
    }
  });
});

// ---- Presence gate: the snapshot stream must not mute agent notifications ----

class RecordingChannel implements NotificationChannel {
  readonly id: string;
  readonly delivered: Notification[] = [];
  constructor(id: string) {
    this.id = id;
  }
  updateConfig(): void {}
  validateConfig() {
    return { ok: true } as const;
  }
  isEnabled() {
    return true;
  }
  async deliver(n: Notification): Promise<void> {
    this.delivered.push(n);
  }
}

function enabledConfig(): NotificationsConfig {
  const cfg = defaultNotificationsConfig();
  cfg.rules["agent.question"] = {
    enabled: true,
    channels: { telegram: true, webpush: true },
  };
  return cfg;
}

function questionEvent(): AgentActivityChangedEvent {
  return {
    type: "agent.activity.changed",
    terminalSessionId: "sess-1",
    worktreePath: "/wt/x",
    activity: {
      state: "awaiting-input",
      agent: "claude",
      lastEvent: "question_asked",
      at: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:00:00.000Z",
      question: { summary: "Approve edit?", askedAt: "2026-06-15T10:00:00.000Z" },
    },
    source: {
      eventId: "q1",
      agent: "claude",
      event: "question_asked",
      severity: "needs-attention",
    },
  };
}

describe("snapshot capture stays passive", () => {
  test("agent.question still fires while a snapshot was captured", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    const meta = await mgr.create({ worktreePath: tmp });

    // Passive capture — no attachment is opened.
    await mgr.captureScreenSnapshot(meta.id);
    expect(mgr.hasActiveAttachments()).toBe(false);

    // The engine gates on focused-client presence, not terminal attachment, so
    // with no focused client it treats the user as away and delivers.
    const bus = new DaemonEventBus();
    const channel = new RecordingChannel("telegram");
    const engine = new NotificationEngine({
      bus,
      channels: [channel],
      config: enabledConfig(),
      hasFocusedClient: () => false,
    });
    engine.handleActivity(questionEvent());
    await new Promise((res) => setTimeout(res, 0));

    expect(channel.delivered).toHaveLength(1);
    expect(channel.delivered[0]?.kind).toBe("agent.question");
  });
});
