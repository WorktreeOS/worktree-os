import { describe, expect, test } from "bun:test";

import {
  detectLaunchMode,
  ensurePersistentCli,
  type EnsurePersistentCliDeps,
  type LaunchMode,
} from "@worktreeos/daemon/launch-mode";

const CACHE_SCRIPT =
  "/Users/u/.bun/install/cache/@worktreeos/cli@0.0.3@@@1/wos.js";

describe("detectLaunchMode", () => {
  test("a compiled standalone binary", () => {
    expect(detectLaunchMode({ compiled: true })).toBe("compiled-binary");
  });

  test("a bunx-ephemeral run (argv under Bun's install cache)", () => {
    expect(detectLaunchMode({ compiled: false, argv1: CACHE_SCRIPT })).toBe(
      "bunx-ephemeral",
    );
  });

  test("a global install (argv under Bun's global node_modules)", () => {
    expect(
      detectLaunchMode({
        compiled: false,
        argv1:
          "/Users/u/.bun/install/global/node_modules/@worktreeos/cli/wos.js",
      }),
    ).toBe("global-install");
  });

  test("a global install (argv is the ~/.bun/bin shim)", () => {
    expect(
      detectLaunchMode({ compiled: false, argv1: "/Users/u/.bun/bin/wos" }),
    ).toBe("global-install");
  });

  test("a source checkout", () => {
    expect(
      detectLaunchMode({ compiled: false, argv1: "/repo/apps/cli/index.ts" }),
    ).toBe("dev-source");
  });
});

describe("ensurePersistentCli", () => {
  function makeDeps(
    overrides: Partial<EnsurePersistentCliDeps> = {},
  ): { calls: string[]; logs: string[]; deps: EnsurePersistentCliDeps } {
    const calls: string[] = [];
    const logs: string[] = [];
    return {
      calls,
      logs,
      deps: {
        mode: "bunx-ephemeral",
        version: "0.0.3",
        runningScript: CACHE_SCRIPT,
        whichWos: () => null,
        install: async (spec) => {
          calls.push(spec);
          return { ok: true };
        },
        log: (m) => logs.push(m),
        ...overrides,
      },
    };
  }

  test("a bunx run with no resolvable wos installs the pinned version", async () => {
    const { calls, deps } = makeDeps();
    expect(await ensurePersistentCli(deps)).toBe("installed");
    expect(calls).toEqual(["@worktreeos/cli@0.0.3"]);
  });

  test("a bunx run where wos only resolves to the ephemeral copy still installs", async () => {
    const { calls, deps } = makeDeps({ whichWos: () => CACHE_SCRIPT });
    expect(await ensurePersistentCli(deps)).toBe("installed");
    expect(calls).toEqual(["@worktreeos/cli@0.0.3"]);
  });

  test("global / compiled / dev modes never install", async () => {
    for (const mode of [
      "global-install",
      "compiled-binary",
      "dev-source",
    ] as LaunchMode[]) {
      const { calls, deps } = makeDeps({ mode });
      expect(await ensurePersistentCli(deps)).toBe("skipped");
      expect(calls).toEqual([]);
    }
  });

  test("an already-persistent wos on PATH is a no-op", async () => {
    const { calls, deps } = makeDeps({
      whichWos: () => "/Users/u/.bun/bin/wos",
    });
    expect(await ensurePersistentCli(deps)).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("falls back to an unpinned spec when the version is unknown", async () => {
    const { calls, deps } = makeDeps({ version: null });
    expect(await ensurePersistentCli(deps)).toBe("installed");
    expect(calls).toEqual(["@worktreeos/cli"]);
  });

  test("an install failure does not throw and logs the actionable hint", async () => {
    const { logs, deps } = makeDeps({
      install: async () => ({ ok: false, message: "registry down" }),
    });
    expect(await ensurePersistentCli(deps)).toBe("failed");
    expect(logs.join("\n")).toContain("bun install -g @worktreeos/cli");
  });

  test("an install that throws is swallowed, not propagated", async () => {
    const { deps } = makeDeps({
      install: async () => {
        throw new Error("boom");
      },
    });
    expect(await ensurePersistentCli(deps)).toBe("failed");
  });
});
