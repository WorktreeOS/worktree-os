import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import type { DaemonHandle } from "@worktreeos/daemon/daemon-server";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WosConfig } from "@worktreeos/core/config";
import type { WorktreeExecResponse } from "@worktreeos/daemon/ui-protocol";
import type { CreateTerminalOptions } from "@worktreeos/daemon/terminal-layer/manager";
import { resolve } from "node:path";

let tmpHome: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-exec-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

interface FakeManager {
  create: (opts: Record<string, unknown>) => Promise<unknown>;
  isAvailable: () => boolean;
  runtimeName: () => string;
  get: () => null;
  createCalls: Record<string, unknown>[];
}

function fakeTerminalLayer(): FakeManager {
  const createCalls: Record<string, unknown>[] = [];
  return {
    createCalls,
    isAvailable: () => true,
    runtimeName: () => "fake-runtime",
    get: () => null,
    async create(opts: Record<string, unknown>) {
      createCalls.push(opts);
      return {
        id: "term-1",
        worktreePath: opts.worktreePath,
        status: "running",
        shell: opts.shell,
        cwd: opts.worktreePath,
        cols: (opts.cols as number) ?? 80,
        rows: (opts.rows as number) ?? 24,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };
}

function generatedCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    worktreeRoot: "/repo",
    source: { path: "/repo", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as unknown as WosConfig,
    projectName: "wos-demo",
    sessionName: "wos-demo",
    sessionRoot: "/tmp/s",
    state: {
      initialized: true,
      projectName: "wos-demo",
      composeFile: "/sess/compose.yaml",
    },
    ...overrides,
  };
}

interface BuildOpts {
  terminalLayer?: unknown;
  resolveSession?: (cwd: string) => Promise<SessionContext>;
  tunnelWebUi?: import("@worktreeos/core/global-config").GlobalTunnelWebUiConfig;
}

async function buildHandler(opts: BuildOpts = {}) {
  const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
  const { OperationRegistry } = await import(
    "@worktreeos/daemon/operation-registry"
  );
  const { DaemonSessionRegistry } = await import(
    "@worktreeos/daemon/daemon-sessions"
  );
  const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    projectsFilePath: resolve(tmpHome, "projects.json"),
    resolveSession:
      opts.resolveSession ?? (async () => generatedCtx()),
    terminalLayer: opts.terminalLayer as never,
    tunnelWebUi: opts.tunnelWebUi,
  });
}

function execRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://x/ui/v1/worktrees/exec", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("UI API: worktree exec", () => {
  test("creates a Docker Compose exec terminal session", async () => {
    const manager = fakeTerminalLayer();
    const handler = await buildHandler({ terminalLayer: manager });
    const res = await handler(
      execRequest({ path: "/repo", service: "api", command: ["bun", "test"] }),
    );
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as WorktreeExecResponse;
    expect(body.terminalId).toBe("term-1");
    expect(body.attachPath).toBe(
      "/ui/v1/terminal-layer/sessions/term-1/attach",
    );
    expect(manager.createCalls.length).toBe(1);
    const call = manager.createCalls[0]! as unknown as CreateTerminalOptions;
    expect(call.shell).toBe("docker");
    expect(call.args).toEqual([
      "compose",
      "-p",
      "wos-demo",
      "-f",
      "/sess/compose.yaml",
      "exec",
      "api",
      "bun",
      "test",
    ]);
  });

  test("returns 503 when terminal-layer is not enabled", async () => {
    const handler = await buildHandler({ terminalLayer: undefined });
    const res = await handler(
      execRequest({ path: "/repo", service: "api", command: ["sh"] }),
    );
    expect(res!.status).toBe(503);
  });

  test("rejects a missing path", async () => {
    const handler = await buildHandler({ terminalLayer: fakeTerminalLayer() });
    const res = await handler(
      execRequest({ service: "api", command: ["sh"] }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects a missing service", async () => {
    const handler = await buildHandler({ terminalLayer: fakeTerminalLayer() });
    const res = await handler(
      execRequest({ path: "/repo", command: ["sh"] }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects a missing command", async () => {
    const handler = await buildHandler({ terminalLayer: fakeTerminalLayer() });
    const res = await handler(
      execRequest({ path: "/repo", service: "api", command: [] }),
    );
    expect(res!.status).toBe(400);
  });

  test("rejects an uninitialized worktree", async () => {
    const handler = await buildHandler({
      terminalLayer: fakeTerminalLayer(),
      resolveSession: async () => generatedCtx({ state: null }),
    });
    const res = await handler(
      execRequest({ path: "/repo", service: "api", command: ["sh"] }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { message: string };
    expect(body.message).toContain("no wos deployment");
  });

  test("rejects shell-mode worktrees with an unsupported-mode error", async () => {
    const manager = fakeTerminalLayer();
    const handler = await buildHandler({
      terminalLayer: manager,
      resolveSession: async () =>
        generatedCtx({
          config: {
            mode: "shell",
            cloneVolumes: [],
            hostPorts: { start: 20000, end: 29999 },
            app: { image: null, initScript: [], services: {} },
            deps: {},
            cache: [],
          } as unknown as WosConfig,
        }),
    });
    const res = await handler(
      execRequest({ path: "/repo", service: "api", command: ["sh"] }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { message: string };
    expect(body.message).toContain("shell-mode");
    expect(manager.createCalls.length).toBe(0);
  });

  test("rejects the internal init service", async () => {
    const manager = fakeTerminalLayer();
    const handler = await buildHandler({ terminalLayer: manager });
    const res = await handler(
      execRequest({ path: "/repo", service: "wos-init", command: ["sh"] }),
    );
    expect(res!.status).toBe(400);
    expect(manager.createCalls.length).toBe(0);
  });

  test("denies public/tunnel clients even when authenticated", async () => {
    const PUBLIC_HOST = "wos.example.com";
    const manager = fakeTerminalLayer();
    const handler = await buildHandler({
      terminalLayer: manager,
      tunnelWebUi: {
        enabled: true,
        hostname: PUBLIC_HOST,
        secret: "letmein",
        terminalEnabled: false,
        whitelistIps: [],
      },
    });
    const { signAuthCookie, AUTH_COOKIE_NAME } = await import(
      "@worktreeos/daemon/public-auth"
    );
    const cookie = `${AUTH_COOKIE_NAME}=${signAuthCookie("letmein", Date.now())}`;
    const res = await handler(
      execRequest(
        { path: "/repo", service: "api", command: ["sh"] },
        { host: PUBLIC_HOST, cookie },
      ),
    );
    expect(res!.status).toBe(403);
    expect(manager.createCalls.length).toBe(0);
  });
});
