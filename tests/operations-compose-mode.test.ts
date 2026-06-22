import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DockerResult } from "@worktreeos/compose/compose";
import {
  runServiceStopOperation,
  runServiceRestartOperation,
  runStatusOperation,
  ServiceOperationError,
} from "@worktreeos/runtime/operations";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WosConfig } from "@worktreeos/core/config";

async function makeWorktree(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "wos-ops-compose-"));
}

function composeCtx(worktreeRoot: string): SessionContext {
  return {
    worktreeRoot,
    source: { path: worktreeRoot, bare: false, detached: false },
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
    projectName: "compose-ops-test",
    sessionName: "compose-ops-test",
    sessionRoot: resolve(worktreeRoot, ".wos"),
    state: {
      initialized: true,
      projectName: "compose-ops-test",
      composeFile: resolve(worktreeRoot, "docker-compose.yaml"),
      worktreeRoot,
      sourcePath: worktreeRoot,
    },
  };
}

describe("compose-mode service operations", () => {
  test("status filters services to compose.expose and skips healthchecks", async () => {
    const root = await makeWorktree();
    try {
      const ctx = composeCtx(root);
      const psPayload = [
        { Service: "api", State: "running", Status: "Up", Publishers: [] },
        { Service: "internal-db", State: "running", Status: "Up", Publishers: [] },
      ]
        .map((s) => JSON.stringify(s))
        .join("\n");
      const runner = async (
        _args: string[],
        _opts?: { env?: Record<string, string> },
      ): Promise<DockerResult> => ({ stdout: psPayload, stderr: "", exitCode: 0 });
      const outcome = await runStatusOperation(ctx, { composeRunner: runner });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("expected ok");
      expect(outcome.services.map((s) => s.service)).toEqual(["api"]);
      expect(outcome.appPortHealthchecks).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status command receives merged compose env", async () => {
    const root = await makeWorktree();
    try {
      await writeFile(resolve(root, ".env.compose"), "FROM_FILE=1\n");
      const ctx = composeCtx(root);
      ctx.config.compose!.envFile = [".env.compose"];
      let observedEnv: Record<string, string> | undefined;
      const runner = async (
        _args: string[],
        opts?: { env?: Record<string, string> },
      ): Promise<DockerResult> => {
        observedEnv = opts?.env;
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runStatusOperation(ctx, { composeRunner: runner });
      expect(observedEnv?.FROM_FILE).toBe("1");
      expect(observedEnv?.INLINE_KEY).toBe("INLINE_VAL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("service stop rejects unexposed service", async () => {
    const root = await makeWorktree();
    try {
      const ctx = composeCtx(root);
      const runner = async (): Promise<DockerResult> => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      let caught: unknown;
      try {
        await runServiceStopOperation(ctx, "internal-db", { composeRunner: runner });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ServiceOperationError);
      expect((caught as ServiceOperationError).code).toBe("unexposed-service");
      expect((caught as ServiceOperationError).message).toContain("internal-db");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("service restart succeeds for exposed service", async () => {
    const root = await makeWorktree();
    try {
      const ctx = composeCtx(root);
      const calls: string[][] = [];
      const runner = async (
        args: string[],
        _opts?: { env?: Record<string, string> },
      ): Promise<DockerResult> => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runServiceRestartOperation(ctx, "api", { composeRunner: runner });
      // Expect both rm and up calls with the service.
      const cmds = calls.map((c) => c[5]);
      expect(cmds).toEqual(["rm", "up"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
