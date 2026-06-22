import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import type { DaemonHandle } from "@worktreeos/daemon/daemon-server";
import type {
  WorktreeDetailResponse,
  WorktreeUpConfigErrorBody,
} from "@worktreeos/daemon/ui-protocol";

let tmpHome: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-pcfg-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

async function buildHandler(opts?: {
  /**
   * Optional worktree-list output keyed by the resolved source. When provided,
   * the daemon resolves a multi-worktree repository so secondary-worktree
   * config selection can be exercised. Defaults to a single source worktree.
   */
  gitRunner?: (cwd: string, args: string[]) => Promise<string>;
}) {
  const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
  const { OperationRegistry } = await import(
    "@worktreeos/daemon/operation-registry"
  );
  const { DaemonSessionRegistry } = await import(
    "@worktreeos/daemon/daemon-sessions"
  );
  const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
  let lastWt = "";
  return {
    setWt: (wt: string) => {
      lastWt = wt;
    },
    handler: createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: opts?.gitRunner ?? (async () => `worktree ${lastWt}\n\n`),
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        ({
          worktreeRoot: cwd,
          source: { path: cwd, bare: false, detached: false },
          config: {
            cloneVolumes: [],
            hostPorts: { start: 20000, end: 29999 },
            app: { image: null, initScript: [], services: {} },
            deps: {},
            cache: [],
          } as any,
          projectName: "p",
          sessionName: "s",
          sessionRoot: "/tmp/s",
          state: null,
        }) as never,
      upRunner: async () => ({} as any),
    }),
  };
}

describe("worktree detail — projectConfig status", () => {
  test("valid config is reported with mode and path", async () => {
    const { handler, setWt } = await buildHandler();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    setWt(wt);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.projectConfig.status).toBe("valid");
    if (body.projectConfig.status === "valid") {
      expect(body.projectConfig.mode).toBe("generated");
      expect(body.projectConfig.path).toBe(join(wt, ".wos", "deploy.yaml"));
    }
  });

  test("missing config exposes expected path and message", async () => {
    const { handler, setWt } = await buildHandler();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    setWt(wt);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.projectConfig.status).toBe("missing");
    if (body.projectConfig.status === "missing") {
      expect(body.projectConfig.path).toBe(join(wt, ".wos", "deploy.yaml"));
      expect(body.projectConfig.message.length).toBeGreaterThan(0);
    }
  });

  test("invalid config exposes validation message", async () => {
    const { handler, setWt } = await buildHandler();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    // Bun.YAML.parse rejects unbalanced strings; this triggers ConfigError.
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "app: [unterminated\n");
    setWt(wt);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.projectConfig.status).toBe("invalid");
    if (body.projectConfig.status === "invalid") {
      expect(body.projectConfig.path).toBe(join(wt, ".wos", "deploy.yaml"));
      expect(body.projectConfig.message.length).toBeGreaterThan(0);
    }
  });

  test("secondary worktree resolves the worktree deploy config in source", async () => {
    const sourceWt = join(tmpHome, "main");
    const secondaryWt = join(tmpHome, "feature");
    await mkdir(sourceWt, { recursive: true });
    await mkdir(secondaryWt, { recursive: true });
    // The worktree deploy config lives only in the source worktree.
    await Bun.write(
      join(sourceWt, ".wos", "deploy.worktree.yaml"),
      "{}\n",
    );
    const { handler } = await buildHandler({
      gitRunner: async () =>
        `worktree ${sourceWt}\n\nworktree ${secondaryWt}\n\n`,
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees?path=${encodeURIComponent(secondaryWt)}`,
      ),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.projectConfig.status).toBe("valid");
    if (body.projectConfig.status === "valid") {
      expect(body.projectConfig.path).toBe(
        join(sourceWt, ".wos", "deploy.worktree.yaml"),
      );
    }
  });

  test("secondary worktree reports missing worktree deploy config path", async () => {
    const sourceWt = join(tmpHome, "main");
    const secondaryWt = join(tmpHome, "feature");
    await mkdir(sourceWt, { recursive: true });
    await mkdir(secondaryWt, { recursive: true });
    // Only the root config exists; the secondary worktree needs its own file.
    await Bun.write(join(sourceWt, ".wos", "deploy.yaml"), "{}\n");
    const { handler } = await buildHandler({
      gitRunner: async () =>
        `worktree ${sourceWt}\n\nworktree ${secondaryWt}\n\n`,
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/worktrees?path=${encodeURIComponent(secondaryWt)}`,
      ),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.projectConfig.status).toBe("missing");
    if (body.projectConfig.status === "missing") {
      expect(body.projectConfig.path).toBe(
        join(sourceWt, ".wos", "deploy.worktree.yaml"),
      );
    }
  });
});

describe("worktree up — config gate", () => {
  test("rejects with config-missing and does not start an operation", async () => {
    const { handler, setWt } = await buildHandler();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    setWt(wt);
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as WorktreeUpConfigErrorBody;
    expect(body.error).toBe("config-missing");
    expect(body.path).toBe(join(wt, ".wos", "deploy.yaml"));
  });

  test("rejects with config-invalid and does not start an operation", async () => {
    const { handler, setWt } = await buildHandler();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "app: [unterminated\n");
    setWt(wt);
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as WorktreeUpConfigErrorBody;
    expect(body.error).toBe("config-invalid");
    expect(body.path).toBe(join(wt, ".wos", "deploy.yaml"));
  });

  test("accepts up when config is valid", async () => {
    const { handler, setWt } = await buildHandler();
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), "{}\n");
    setWt(wt);
    const res = await handler(
      new Request("http://x/ui/v1/worktrees/up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: wt }),
      }),
    );
    expect(res!.status).toBe(202);
  });
});
