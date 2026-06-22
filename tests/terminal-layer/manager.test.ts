import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TerminalSessionManager,
  TerminalSessionManagerError,
} from "@worktreeos/daemon/terminal-layer/manager";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";
import {
  type AgentActivityEvent,
  STALE_DEMOTION_EVENT,
} from "@worktreeos/core/agent-activity";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wos-term-mgr-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("TerminalSessionManager", () => {
  test("create requires the runtime to be available", async () => {
    const r = createFakeTerminalRuntime();
    r.setAvailable(false);
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await expect(mgr.create({ worktreePath: tmp })).rejects.toBeInstanceOf(
      TerminalSessionManagerError,
    );
  });

  test("create returns a metadata snapshot in running status", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    expect(meta.status).toBe("running");
    expect(meta.processId).toBe(1000);
    expect(meta.replay?.latestSeq).toBe(0);
    expect(meta.cols).toBeGreaterThan(0);
  });

  test("includes active command metadata from the resolver", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      activeCommandResolver: (rootPid) =>
        rootPid === 1000
          ? {
              pid: 1001,
              ppid: 1000,
              pgid: 1001,
              command: "/opt/homebrew/bin/codex",
              args: "codex",
              agent: "codex",
            }
          : undefined,
    });
    const meta = await mgr.create({ worktreePath: tmp });
    expect(meta.activeCommand?.agent).toBe("codex");
    expect(meta.activeCommand?.pid).toBe(1001);
  });

  test("rejects worktreePath that does not exist", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await expect(
      mgr.create({ worktreePath: join(tmp, "missing") }),
    ).rejects.toBeInstanceOf(TerminalSessionManagerError);
  });

  test("rejects cwd that escapes the worktree", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await expect(
      mgr.create({ worktreePath: tmp, cwd: tmpdir() }),
    ).rejects.toThrow(/escapes worktree/);
  });

  test("list filters by worktreePath", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const a = await mgr.create({ worktreePath: tmp });
    const tmp2 = await mkdtemp(join(tmpdir(), "wos-term-mgr-b-"));
    const b = await mgr.create({ worktreePath: tmp2 });
    expect(mgr.list(tmp).map((m) => m.id)).toEqual([a.id]);
    expect(mgr.list(tmp2).map((m) => m.id)).toEqual([b.id]);
    expect(mgr.list().length).toBe(2);
    await rm(tmp2, { recursive: true, force: true });
  });

  test("forwards lifecycle events to onLifecycle sink", async () => {
    const r = createFakeTerminalRuntime();
    const events: string[] = [];
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      onLifecycle: (e) => events.push(e.type),
    });
    await mgr.create({ worktreePath: tmp });
    expect(events.includes("created")).toBe(true);
    expect(events.includes("running")).toBe(true);
  });

  test("shutdown stops all sessions and clears the registry", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.create({ worktreePath: tmp });
    await mgr.create({ worktreePath: tmp });
    await mgr.shutdown();
    expect(mgr.list().length).toBe(0);
    expect(r.spawned[0]!.kills.length).toBe(1);
    expect(r.spawned[1]!.kills.length).toBe(1);
  });
});

describe("TerminalSessionManager session env allowlist", () => {
  test("drops arbitrary daemon-private vars from the spawned env", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.create({
      worktreePath: tmp,
      env: {
        WOS_HOME: "/tmp/wos-test-fallback-xyz",
        WOS_HOME_ALLOW_TMP: "1",
        FOO_PRODUCT_KEY: "secret",
        HOME: "/home/u",
      },
    });
    const spawnEnv = r.spawned[0]!.spawn.env;
    expect("WOS_HOME" in spawnEnv).toBe(false);
    expect("WOS_HOME_ALLOW_TMP" in spawnEnv).toBe(false);
    expect("FOO_PRODUCT_KEY" in spawnEnv).toBe(false);
  });

  test("preserves allowlist vars but never carries PATH from the base env", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.create({
      worktreePath: tmp,
      env: {
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        HOME: "/home/u",
        LC_ALL: "en_US.UTF-8",
        HTTPS_PROXY: "http://proxy:8080",
        PATH: "/usr/local/bin:/usr/bin",
      },
    });
    const spawnEnv = r.spawned[0]!.spawn.env;
    expect(spawnEnv.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(spawnEnv.LANG).toBe("en_US.UTF-8");
    expect(spawnEnv.TERM).toBe("xterm-256color");
    expect(spawnEnv.HOME).toBe("/home/u");
    expect(spawnEnv.LC_ALL).toBe("en_US.UTF-8");
    expect(spawnEnv.HTTPS_PROXY).toBe("http://proxy:8080");
    // PATH is rebuilt by the login shell, never propagated from the daemon.
    expect("PATH" in spawnEnv).toBe(false);
  });

  test("layers agent bindings on top of the allowlist", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      agentEnv: (sessionId) => ({
        WOS_TERMINAL_SESSION_ID: sessionId,
        WOS_AGENT_TOKEN: "agent-token",
        WOS_DAEMON_URL: "http://127.0.0.1:4317",
      }),
    });
    const meta = await mgr.create({
      worktreePath: tmp,
      env: { WOS_HOME: "/tmp/wos-x", HOME: "/home/u" },
    });
    const spawnEnv = r.spawned[0]!.spawn.env;
    expect("WOS_HOME" in spawnEnv).toBe(false);
    expect(spawnEnv.WOS_TERMINAL_SESSION_ID).toBe(meta.id);
    expect(spawnEnv.WOS_AGENT_TOKEN).toBe("agent-token");
    expect(spawnEnv.WOS_DAEMON_URL).toBe("http://127.0.0.1:4317");
    // No wos-binary PATH prefix is delivered anymore.
    expect("PATH" in spawnEnv).toBe(false);
  });

  test("runs the default interactive shell as a login shell (POSIX)", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.create({ worktreePath: tmp, env: { HOME: "/home/u" } });
    const spawnArgs = r.spawned[0]!.spawn.args ?? [];
    if (process.platform === "win32") {
      expect(spawnArgs).not.toContain("-l");
    } else {
      expect(spawnArgs).toContain("-l");
    }
  });

  test("an explicit program keeps its full env and is not a login shell", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.create({
      worktreePath: tmp,
      shell: "docker",
      args: ["compose", "exec", "api", "sh"],
      env: { WOS_HOME: "/tmp/wos-x", PATH: "/usr/bin", COMPOSE_PROJECT_NAME: "demo" },
    });
    const proc = r.spawned[0]!;
    // Explicit programs receive the caller's complete replacement env verbatim
    // (PATH to resolve the program, compose vars), not the narrow allowlist.
    expect(proc.spawn.env.PATH).toBe("/usr/bin");
    expect(proc.spawn.env.COMPOSE_PROJECT_NAME).toBe("demo");
    expect(proc.spawn.env.WOS_HOME).toBe("/tmp/wos-x");
    // No login flag is injected; the argv is the program's own.
    expect(proc.spawn.args).toEqual(["compose", "exec", "api", "sh"]);
  });
});

describe("TerminalSessionManager unread marker", () => {
  function activityEvent(
    kind: string,
    at: string,
    eventId: string,
  ): AgentActivityEvent {
    return {
      v: 1,
      eventId,
      agent: "claude",
      event: kind,
      agentSessionId: "agent-1",
      cwd: "/tmp",
      at,
      severity: "info",
    };
  }

  function attachOptions(attachmentId: string) {
    return {
      attachmentId,
      cols: 80,
      rows: 24,
      desiredControl: "controller" as const,
      sink: { send() {}, close() {} },
    };
  }

  test("sets unreadSince when activity goes idle with no attachments", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:00:00.000Z", "e2"));
    expect(mgr.get(meta.id)?.unreadSince).toBe("2026-06-11T10:00:00.000Z");
  });

  test("sets unreadSince on awaiting-input with no attachments", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    mgr.applyAgentActivity(meta.id, activityEvent("question_asked", "2026-06-11T10:00:00.000Z", "e2"));
    expect(mgr.get(meta.id)?.unreadSince).toBe("2026-06-11T10:00:00.000Z");
  });

  test("does not set unreadSince while a client is attached", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    await mgr.attach(meta.id, attachOptions("att-1"));
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:00:00.000Z", "e2"));
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
  });

  test("attach clears unreadSince; detach does not re-set it", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:00:00.000Z", "e2"));
    expect(mgr.get(meta.id)?.unreadSince).toBeDefined();
    await mgr.attach(meta.id, attachOptions("att-1"));
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
    await mgr.detach(meta.id, "att-1");
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
  });

  test("repeat idle events do not refresh the timestamp", async () => {
    const r = createFakeTerminalRuntime();
    let nowIso = "2026-06-11T10:00:00.000Z";
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      now: () => new Date(nowIso),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:00:00.000Z", "e2"));
    nowIso = "2026-06-11T10:05:00.000Z";
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:05:00.000Z", "e3"));
    expect(mgr.get(meta.id)?.unreadSince).toBe("2026-06-11T10:00:00.000Z");
  });

  test("non-agent sessions never gain unreadSince", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
    await mgr.attach(meta.id, attachOptions("att-1"));
    await mgr.detach(meta.id, "att-1");
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
  });

  test("a synthetic staleness demotion sets no unreadSince and is a soft idle", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    const applied = mgr.applyAgentActivity(
      meta.id,
      activityEvent(STALE_DEMOTION_EVENT, "2026-06-11T10:00:30.000Z", "e2"),
    );
    expect(applied?.activity?.state).toBe("idle");
    expect(applied?.activity?.idleKind).toBe("stale");
    // A guessed stop is not a "result is waiting" signal.
    expect(mgr.get(meta.id)?.unreadSince).toBeUndefined();
  });

  test("a real stop while detached still marks unread (regression)", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({
      runtime: r.runtime,
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T09:59:00.000Z", "e1"));
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:00:00.000Z", "e2"));
    expect(mgr.get(meta.id)?.unreadSince).toBe("2026-06-11T10:00:00.000Z");
  });
});

describe("TerminalSessionManager attachment-during-working gating", () => {
  function activityEvent(
    kind: string,
    at: string,
    eventId: string,
  ): AgentActivityEvent {
    return {
      v: 1,
      eventId,
      agent: "claude",
      event: kind,
      agentSessionId: "agent-1",
      cwd: "/tmp",
      at,
      severity: "info",
    };
  }

  function attachOptions(attachmentId: string) {
    return {
      attachmentId,
      cols: 80,
      rows: 24,
      desiredControl: "controller" as const,
      sink: { send() {}, close() {} },
    };
  }

  test("never-attached working reads as not attended", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T10:00:00.000Z", "e1"));
    expect(mgr.attachedDuringWorking(meta.id)).toBe(false);
  });

  test("attaching while working marks the stretch attended", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T10:00:00.000Z", "e1"));
    await mgr.attach(meta.id, attachOptions("att-1"));
    expect(mgr.attachedDuringWorking(meta.id)).toBe(true);
  });

  test("attached-then-detached working stays attended", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T10:00:00.000Z", "e1"));
    await mgr.attach(meta.id, attachOptions("att-1"));
    await mgr.detach(meta.id, "att-1");
    expect(mgr.attachedDuringWorking(meta.id)).toBe(true);
  });

  test("a fresh working stretch reseeds the attended flag from current attachments", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    // First stretch: attended, then idle.
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T10:00:00.000Z", "e1"));
    await mgr.attach(meta.id, attachOptions("att-1"));
    await mgr.detach(meta.id, "att-1");
    mgr.applyAgentActivity(meta.id, activityEvent("stop", "2026-06-11T10:01:00.000Z", "e2"));
    // Second stretch starts detached → reseeds to not-attended.
    mgr.applyAgentActivity(meta.id, activityEvent("prompt_submit", "2026-06-11T10:02:00.000Z", "e3"));
    expect(mgr.attachedDuringWorking(meta.id)).toBe(false);
  });

  test("unknown session ids read as not attended", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    expect(mgr.attachedDuringWorking("missing")).toBe(false);
  });
});

describe("TerminalSessionManager.rename", () => {
  test("sets, changes, and clears a session title, normalizing whitespace", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    const named = await mgr.rename(meta.id, "  api logs  ");
    expect(named.title).toBe("api logs");
    expect(mgr.get(meta.id)?.title).toBe("api logs");
    const renamed = await mgr.rename(meta.id, "codex review");
    expect(renamed.title).toBe("codex review");
    const cleared = await mgr.rename(meta.id, "");
    expect(cleared.title).toBeUndefined();
    const clearedNull = await mgr.rename(meta.id, null);
    expect(clearedNull.title).toBeUndefined();
  });

  test("rename marks the title user-sourced", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    const named = await mgr.rename(meta.id, "api logs");
    expect(named.titleSource).toBe("user");
    const cleared = await mgr.rename(meta.id, null);
    expect(cleared.titleSource).toBeUndefined();
  });

  test("rejects an unknown session id with a not-found error", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    let code: string | undefined;
    try {
      await mgr.rename("missing", "x");
    } catch (e) {
      code = (e as TerminalSessionManagerError).code;
    }
    expect(code).toBe("not-found");
  });

  test("rejects a control-character title with a validation error", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    let code: string | undefined;
    try {
      await mgr.rename(meta.id, "bad\u0007title");
    } catch (e) {
      code = (e as TerminalSessionManagerError).code;
    }
    expect(code).toBe("validation");
    expect(mgr.get(meta.id)?.title).toBeUndefined();
  });

  test("rejects an over-length title with a validation error", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    await expect(mgr.rename(meta.id, "x".repeat(81))).rejects.toBeInstanceOf(
      TerminalSessionManagerError,
    );
    expect(mgr.get(meta.id)?.title).toBeUndefined();
  });
});

describe("TerminalSessionManager.setAgentTitle", () => {
  test("sets and clears an agent-sourced title", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    await mgr.setAgentTitle(meta.id, "Fix login bug");
    expect(mgr.get(meta.id)?.title).toBe("Fix login bug");
    expect(mgr.get(meta.id)?.titleSource).toBe("agent");
    await mgr.setAgentTitle(meta.id, undefined);
    expect(mgr.get(meta.id)?.title).toBeUndefined();
    expect(mgr.get(meta.id)?.titleSource).toBeUndefined();
  });

  test("unknown session id is a silent no-op", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    await mgr.setAgentTitle("missing", "x");
  });

  test("user rename over an agent title flips provenance to user", async () => {
    const r = createFakeTerminalRuntime();
    const mgr = new TerminalSessionManager({ runtime: r.runtime });
    const meta = await mgr.create({ worktreePath: tmp });
    await mgr.setAgentTitle(meta.id, "Fix login bug");
    const renamed = await mgr.rename(meta.id, "my session");
    expect(renamed.title).toBe("my session");
    expect(renamed.titleSource).toBe("user");
  });
});
