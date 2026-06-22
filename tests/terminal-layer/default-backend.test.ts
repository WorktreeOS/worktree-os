import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultTerminalBackend } from "@worktreeos/daemon/terminal-layer/default-backend";
import { TerminalSessionManager } from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-default-backend-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("createDefaultTerminalBackend", () => {
  test("reports availability from the underlying runtime", () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    expect(backend.id).toBe("default");
    expect(backend.isAvailable().available).toBe(true);
    r.setAvailable(false);
    const avail = backend.isAvailable();
    expect(avail.available).toBe(false);
    expect(avail.reason).toContain("not available");
  });

  test("createSession spawns the runtime and returns a usable transport", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const result = await backend.createSession({
      id: "t1",
      worktreePath: tmp,
      cwd: tmp,
      shell: "/bin/zsh",
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    expect(result.session.backend).toBe("default");
    expect(result.session.id).toBe("t1");
    expect(r.spawned).toHaveLength(1);
    // The transport is the spawned PTY process.
    expect(result.transport).toBe(r.spawned[0]!.process);
  });

  test("onDaemonShutdown and terminateSession both kill the transport", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const a = await backend.createSession({
      id: "t1",
      worktreePath: tmp,
      cwd: tmp,
      shell: "/bin/zsh",
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    await backend.onDaemonShutdown(a.session, a.transport);
    expect(r.spawned[0]!.kills.length).toBe(1);

    const b = await backend.createSession({
      id: "t2",
      worktreePath: tmp,
      cwd: tmp,
      shell: "/bin/zsh",
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    await backend.terminateSession(b.session, b.transport, "SIGTERM");
    expect(r.spawned[1]!.kills).toEqual(["SIGTERM"]);
  });

  test("default backend exposes no restoreSessions", () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    expect(backend.restoreSessions).toBeUndefined();
  });
});

describe("TerminalSessionManager with explicit default backend", () => {
  test("create returns a running session through the backend boundary", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    const meta = await mgr.create({ worktreePath: tmp });
    expect(meta.status).toBe("running");
    expect(mgr.backendId()).toBe("default");
    expect(r.spawned).toHaveLength(1);
  });

  test("restore() returns empty for the default backend", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    const restored = await mgr.restore();
    expect(restored).toEqual([]);
  });

  test("terminate routes through backend.terminateSession", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    const meta = await mgr.create({ worktreePath: tmp });
    await mgr.terminate(meta.id, "SIGTERM");
    expect(r.spawned[0]!.kills).toEqual(["SIGTERM"]);
  });

  test("shutdown routes through backend.onDaemonShutdown", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    await mgr.create({ worktreePath: tmp });
    await mgr.create({ worktreePath: tmp });
    await mgr.shutdown();
    expect(r.spawned[0]!.kills.length).toBe(1);
    expect(r.spawned[1]!.kills.length).toBe(1);
  });

  test("availability surfaces backend reason for unavailable runtimes", async () => {
    const r = createFakeTerminalRuntime();
    r.setAvailable(false);
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    expect(mgr.isAvailable()).toBe(false);
    await expect(mgr.create({ worktreePath: tmp })).rejects.toThrow(
      /not available/,
    );
  });
});

describe("createDefaultTerminalBackend — login shell + session env", () => {
  const IS_WIN = process.platform === "win32";

  test("launches the default shell in login mode (POSIX) when login is set", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    await backend.createSession({
      id: "t1",
      worktreePath: tmp,
      cwd: tmp,
      shell: "/bin/zsh",
      env: { HOME: "/home/u" },
      login: true,
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    const args = r.spawned[0]!.spawn.args ?? [];
    if (IS_WIN) {
      expect(args).not.toContain("-l");
    } else {
      expect(args).toEqual(["-l"]);
    }
  });

  test("an explicit program is spawned as-is, never login mode", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    await backend.createSession({
      id: "t1",
      worktreePath: tmp,
      cwd: tmp,
      shell: "docker",
      args: ["compose", "exec", "api", "sh"],
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    expect(r.spawned[0]!.spawn.args).toEqual(["compose", "exec", "api", "sh"]);
  });

  test("through the manager, the spawn env is the allowlist + agent vars only", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({
      backend,
      agentEnv: (sessionId) => ({
        WOS_TERMINAL_SESSION_ID: sessionId,
        WOS_AGENT_TOKEN: "tok",
      }),
    });
    const meta = await mgr.create({
      worktreePath: tmp,
      env: { WOS_HOME: "/tmp/wos-x", HOME: "/home/u", TERM: "xterm", PATH: "/usr/bin" },
    });
    const spawnEnv = r.spawned[0]!.spawn.env;
    expect("WOS_HOME" in spawnEnv).toBe(false);
    expect("PATH" in spawnEnv).toBe(false);
    expect(spawnEnv.HOME).toBe("/home/u");
    expect(spawnEnv.TERM).toBe("xterm");
    expect(spawnEnv.WOS_TERMINAL_SESSION_ID).toBe(meta.id);
    expect(spawnEnv.WOS_AGENT_TOKEN).toBe("tok");
  });
});

describe("TerminalSessionManager backend selection", () => {
  test("requires backend or runtime", () => {
    expect(() => new TerminalSessionManager({})).toThrow(
      /requires either a `backend` adapter or a `runtime`/,
    );
  });
});

describe("TerminalSessionManager terminate end-to-end", () => {
  test("terminate moves the session to exited once the transport exits", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createDefaultTerminalBackend({ runtime: r.runtime });
    const mgr = new TerminalSessionManager({ backend });
    const meta = await mgr.create({ worktreePath: tmp });
    expect(meta.status).toBe("running");
    await mgr.terminate(meta.id, "SIGTERM");
    // Fake runtime records the kill signal but does not auto-exit. Drive
    // the exit event so the actor's onPtyExit handler can observe it.
    r.spawned[0]!.exit({ exitCode: 0 });
    await Bun.sleep(5);
    const after = mgr.get(meta.id);
    expect(after?.status).toBe("exited");
  });
});
