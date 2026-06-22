import { test, expect, describe } from "bun:test";
import {
  parseExecArgs,
  runExec,
  buildAttachWsUrl,
  resolveDaemonWebUrl,
  type ExecOptions,
} from "../apps/cli/commands/exec";
import type { GitRunner } from "@worktreeos/core/git";
import type { DaemonBootstrap } from "@worktreeos/daemon/daemon-bootstrap";
import type { UiClient } from "@worktreeos/daemon/ui-client";
import type { WorktreeExecResponse } from "@worktreeos/daemon/ui-protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const okGit: GitRunner = async (args) => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/fake\n";
  if (args[0] === "rev-parse" && args[1] === "--git-dir") return "/fake/.git\n";
  if (args[0] === "worktree" && args[1] === "list") return "worktree /fake\n";
  throw new Error(`unexpected git ${args.join(" ")}`);
};

function okBootstrap(): DaemonBootstrap {
  return {
    ensureRunning: async () => ({
      baseUrl: "http://127.0.0.1:1",
      health: { ok: true, version: "1" },
    }),
  } as unknown as DaemonBootstrap;
}

interface FakeUi {
  client: UiClient;
  execCalls: unknown[];
  healthCalls: number;
}

function fakeUiClient(
  overrides: {
    health?: () => Promise<{ ok: boolean; version: string }>;
    submitExec?: (req: unknown) => Promise<WorktreeExecResponse>;
  } = {},
): FakeUi {
  const execCalls: unknown[] = [];
  let healthCalls = 0;
  const client = {
    health: async () => {
      healthCalls += 1;
      return overrides.health
        ? await overrides.health()
        : { ok: true, version: "1" };
    },
    submitExec: async (req: unknown) => {
      execCalls.push(req);
      return overrides.submitExec
        ? await overrides.submitExec(req)
        : ({
            terminalId: "term-1",
            attachPath: "/ui/v1/terminal-layer/sessions/term-1/attach",
            session: {},
          } as WorktreeExecResponse);
    },
  } as unknown as UiClient;
  return {
    client,
    execCalls,
    get healthCalls() {
      return healthCalls;
    },
  };
}

function baseOpts(over: Partial<ExecOptions> = {}): {
  opts: ExecOptions;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    opts: {
      gitRunner: okGit,
      bootstrap: okBootstrap(),
      stdoutWrite: (t) => out.push(t),
      stderrWrite: (t) => err.push(t),
      resolveWebUrl: async () => "http://127.0.0.1:4949",
      cols: 80,
      rows: 24,
      ...over,
    },
  };
}

describe("parseExecArgs", () => {
  test("parses service and command after a -- separator", () => {
    expect(parseExecArgs(["api", "--", "bun", "test"])).toEqual({
      service: "api",
      command: ["bun", "test"],
    });
  });

  test("preserves a command beginning with a flag", () => {
    expect(parseExecArgs(["api", "--", "--version"])).toEqual({
      service: "api",
      command: ["--version"],
    });
  });

  test("works without an explicit -- separator", () => {
    expect(parseExecArgs(["api", "bun", "test"])).toEqual({
      service: "api",
      command: ["bun", "test"],
    });
  });

  test("requires a service", () => {
    expect(parseExecArgs([])).toEqual({ error: "a service is required" });
    expect(parseExecArgs(["--", "bun"])).toEqual({
      error: "a service is required",
    });
  });

  test("requires a command", () => {
    expect(parseExecArgs(["api"])).toEqual({ error: "a command is required" });
    expect(parseExecArgs(["api", "--"])).toEqual({
      error: "a command is required",
    });
  });
});

describe("buildAttachWsUrl", () => {
  test("converts http to ws and appends the attach path", () => {
    expect(
      buildAttachWsUrl(
        "http://127.0.0.1:4949",
        "/ui/v1/terminal-layer/sessions/term-1/attach",
      ),
    ).toBe("ws://127.0.0.1:4949/ui/v1/terminal-layer/sessions/term-1/attach");
  });

  test("converts https to wss", () => {
    expect(buildAttachWsUrl("https://127.0.0.1:4949/", "/x")).toBe(
      "wss://127.0.0.1:4949/x",
    );
  });
});

describe("runExec dispatch", () => {
  test("fails argument parsing without contacting the daemon", async () => {
    let ensureCalled = false;
    const { opts, err } = baseOpts({
      client: {
        ensureRunning: async () => {
          ensureCalled = true;
          return { ok: true };
        },
      } as unknown as DaemonClient,
    });
    const code = await runExec([], opts);
    expect(code).toBe(2);
    expect(ensureCalled).toBe(false);
    expect(err.join("")).toContain("wos exec <service>");
  });

  test("creates the exec session and attaches, returning the exit code", async () => {
    const ui = fakeUiClient();
    let attachUrl = "";
    const { opts } = baseOpts({
      uiClientFactory: () => ui.client,
      attach: async ({ url }) => {
        attachUrl = url;
        return 7;
      },
    });
    const code = await runExec(["api", "--", "bun", "test"], opts);
    expect(code).toBe(7);
    expect(ui.execCalls).toEqual([
      {
        path: "/fake",
        service: "api",
        command: ["bun", "test"],
        cols: 80,
        rows: 24,
      },
    ]);
    expect(attachUrl).toBe(
      "ws://127.0.0.1:4949/ui/v1/terminal-layer/sessions/term-1/attach",
    );
  });

  test("fails with an actionable error when no web URL is available", async () => {
    const ui = fakeUiClient();
    let attachCalled = false;
    const { opts, err } = baseOpts({
      resolveWebUrl: async () => null,
      uiClientFactory: () => ui.client,
      attach: async () => {
        attachCalled = true;
        return 0;
      },
    });
    const code = await runExec(["api", "--", "sh"], opts);
    expect(code).toBe(1);
    expect(err.join("")).toContain("daemon web listener");
    expect(attachCalled).toBe(false);
    expect(ui.execCalls.length).toBe(0);
  });

  test("fails when the web listener reports an incompatible UI API version", async () => {
    const ui = fakeUiClient({
      health: async () => ({ ok: true, version: "999" }),
    });
    const { opts, err } = baseOpts({ uiClientFactory: () => ui.client });
    const code = await runExec(["api", "--", "sh"], opts);
    expect(code).toBe(1);
    expect(err.join("")).toContain("incompatible UI API");
    expect(ui.execCalls.length).toBe(0);
  });

  test("fails when the web listener health check throws", async () => {
    const ui = fakeUiClient({
      health: async () => {
        throw new Error("connection refused");
      },
    });
    const { opts, err } = baseOpts({ uiClientFactory: () => ui.client });
    const code = await runExec(["api", "--", "sh"], opts);
    expect(code).toBe(1);
    expect(err.join("")).toContain("health check failed");
    expect(ui.execCalls.length).toBe(0);
  });
});

describe("resolveDaemonWebUrl", () => {
  test("returns null when metadata is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wos-exec-meta-"));
    try {
      expect(
        await resolveDaemonWebUrl({ metadataPath: join(dir, "missing.json") }),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns the webUrl from daemon metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wos-exec-meta-"));
    try {
      const p = join(dir, "daemon.json");
      await writeFile(
        p,
        JSON.stringify({
          pid: 1,
          socketPath: "/x",
          startedAt: "t",
          protocol: "1",
          webUrl: "http://127.0.0.1:5000",
        }),
      );
      expect(await resolveDaemonWebUrl({ metadataPath: p })).toBe(
        "http://127.0.0.1:5000",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when metadata has no webUrl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wos-exec-meta-"));
    try {
      const p = join(dir, "daemon.json");
      await writeFile(
        p,
        JSON.stringify({ pid: 1, socketPath: "/x", startedAt: "t", protocol: "1" }),
      );
      expect(await resolveDaemonWebUrl({ metadataPath: p })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
