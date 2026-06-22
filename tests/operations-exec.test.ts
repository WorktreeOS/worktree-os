import { test, expect, describe } from "bun:test";
import { composeExecArgs, type ComposeContext } from "@worktreeos/compose/compose";
import {
  buildServiceExecCommand,
  ServiceOperationError,
} from "@worktreeos/runtime/operations";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WosConfig } from "@worktreeos/core/config";

function generatedCtx(composeFiles?: string[]): SessionContext {
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
      ...(composeFiles ? { composeFiles } : {}),
    },
  };
}

function composeCtx(composeFiles?: string[]): SessionContext {
  return {
    worktreeRoot: "/repo",
    source: { path: "/repo", bare: false, detached: false },
    config: {
      mode: "compose",
      cloneVolumes: [],
      app: {
        image: null,
        initScript: [],
        connectNpmCache: false,
        connectYarnCache: false,
        connectBunCache: false,
        services: {},
      },
      deps: {},
      hostPorts: { start: 20000, end: 29999 },
      cache: [],
      compose: {
        config: "docker-compose.yaml",
        expose: [{ service: "api", port: 3000 }],
        envFile: [],
        environment: { INLINE_KEY: "INLINE_VAL" },
      },
    } satisfies WosConfig,
    projectName: "compose-demo",
    sessionName: "compose-demo",
    sessionRoot: "/tmp/s",
    state: {
      initialized: true,
      projectName: "compose-demo",
      composeFile: "/sess/compose-base.yaml",
      ...(composeFiles ? { composeFiles } : {}),
    },
  };
}

describe("composeExecArgs", () => {
  test("appends exec, service, and command after compose file flags", () => {
    const ctx: ComposeContext = {
      projectName: "wos-demo",
      composeFile: "/sess/compose.yaml",
    };
    expect(composeExecArgs(ctx, "api", ["bun", "test"])).toEqual([
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

  test("preserves command argv beginning with flags verbatim", () => {
    const ctx: ComposeContext = {
      projectName: "wos-demo",
      composeFile: "/sess/compose.yaml",
    };
    expect(composeExecArgs(ctx, "api", ["--version"])).toEqual([
      "compose",
      "-p",
      "wos-demo",
      "-f",
      "/sess/compose.yaml",
      "exec",
      "api",
      "--version",
    ]);
  });
});

describe("buildServiceExecCommand", () => {
  test("generated mode uses the persisted compose file and docker program", async () => {
    const plan = await buildServiceExecCommand(generatedCtx(), "api", [
      "bun",
      "test",
    ]);
    expect(plan.program).toBe("docker");
    expect(plan.args).toEqual([
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
    expect(plan.env).toBeUndefined();
  });

  test("compose mode includes every compose file in order", async () => {
    const plan = await buildServiceExecCommand(
      composeCtx(["/sess/compose-base.yaml", "/sess/compose-overlay.yaml"]),
      "api",
      ["sh"],
    );
    expect(plan.args).toEqual([
      "compose",
      "-p",
      "compose-demo",
      "-f",
      "/sess/compose-base.yaml",
      "-f",
      "/sess/compose-overlay.yaml",
      "exec",
      "api",
      "sh",
    ]);
  });

  test("compose mode forwards the resolved compose command environment", async () => {
    const plan = await buildServiceExecCommand(composeCtx(), "api", ["sh"]);
    expect(plan.env).toBeDefined();
    expect(plan.env!.INLINE_KEY).toBe("INLINE_VAL");
  });

  test("rejects an empty command", async () => {
    let caught: unknown;
    try {
      await buildServiceExecCommand(generatedCtx(), "api", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceOperationError);
    expect((caught as ServiceOperationError).code).toBe("invalid-command");
  });

  test("rejects an uninitialized deployment", async () => {
    const ctx = generatedCtx();
    ctx.state = null;
    let caught: unknown;
    try {
      await buildServiceExecCommand(ctx, "api", ["sh"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceOperationError);
    expect((caught as ServiceOperationError).code).toBe("no-deployment");
  });

  test("rejects the internal init service", async () => {
    let caught: unknown;
    try {
      await buildServiceExecCommand(generatedCtx(), INIT_SERVICE_NAME, ["sh"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceOperationError);
    expect((caught as ServiceOperationError).code).toBe("internal-service");
  });

  test("rejects a compose-mode service not listed in compose.expose", async () => {
    let caught: unknown;
    try {
      await buildServiceExecCommand(composeCtx(), "worker", ["sh"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceOperationError);
    expect((caught as ServiceOperationError).code).toBe("unexposed-service");
  });

  test("rejects shell-mode deployments as unsupported", async () => {
    const ctx = generatedCtx();
    (ctx.config as WosConfig).mode = "shell";
    let caught: unknown;
    try {
      await buildServiceExecCommand(ctx, "api", ["sh"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceOperationError);
    expect((caught as ServiceOperationError).code).toBe("unsupported-mode");
  });
});
