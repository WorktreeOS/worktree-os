import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  bindDaemonTestEnv,
} from "./helpers/daemon-test-harness.ts";
import { createUiApiHandler } from "@worktreeos/daemon/ui-api";
import { OperationRegistry } from "@worktreeos/daemon/operation-registry";
import { DaemonSessionRegistry } from "@worktreeos/daemon/daemon-sessions";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WorktreeUpResponse } from "@worktreeos/daemon/ui-protocol";

function fakeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    worktreeRoot: "/fake/worktree",
    source: { path: "/fake/source", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { image: null, initScript: [], services: {} },
      deps: {},
      cache: [],
    } as any,
    projectName: "live-apply",
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...overrides,
  };
}

let tmpHome: string;
let restoreEnv: () => void;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-live-apply-");
  restoreEnv = bindDaemonTestEnv(tmpHome);
});

afterEach(async () => {
  restoreEnv();
  await teardownDaemonTestHome(tmpHome);
});

describe("settings PUT — live service-tunnel whitelist", () => {
  test("a whitelist change is applied live and does not require restart", async () => {
    const applied: string[][] = [];
    const tunnels = new TunnelRegistry();
    const realSetPolicy = tunnels.setServiceRoutePolicy.bind(tunnels);
    tunnels.setServiceRoutePolicy = (ips) => {
      applied.push([...ips]);
      realSetPolicy(ips);
    };
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels,
      resolveSession: async () => fakeContext(),
      projectsFilePath: resolve(tmpHome, "projects.json"),
    });
    const res = await handler(
      new Request("http://x/ui/v1/settings/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tunnel: {
            serviceTunnels: { enabled: false, whitelistIps: ["10.0.0.1"] },
          },
        }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { restartRequired: boolean };
    expect(body.restartRequired).toBe(false);
    expect(applied).toEqual([["10.0.0.1"]]);
  });

  test("a socket-field change requires restart and does not touch the whitelist policy", async () => {
    const applied: string[][] = [];
    const tunnels = new TunnelRegistry();
    tunnels.setServiceRoutePolicy = (ips) => {
      applied.push([...ips]);
    };
    const handler = createUiApiHandler({
      registry: new OperationRegistry(),
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels,
      resolveSession: async () => fakeContext(),
      projectsFilePath: resolve(tmpHome, "projects.json"),
    });
    const res = await handler(
      new Request("http://x/ui/v1/settings/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ web: { port: 5050 } }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { restartRequired: boolean };
    expect(body.restartRequired).toBe(true);
    expect(applied).toEqual([]);
  });
});

describe("up — live healthcheck defaults", () => {
  test("a persisted healthcheck change is reflected in the next up without restart", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(join(wt, ".wos"), { recursive: true });
    await writeFile(join(wt, ".wos", "deploy.yaml"), "{}\n");

    const observedRetries: number[] = [];
    const registry = new OperationRegistry();
    let upCount = 0;
    const handler = createUiApiHandler({
      registry,
      sessions: new DaemonSessionRegistry({ starter: () => [] }),
      tunnels: new TunnelRegistry(),
      gitRunner: async () => `worktree ${wt}\n\n`,
      projectsFilePath: resolve(tmpHome, "projects.json"),
      resolveSession: async (cwd) =>
        fakeContext({ worktreeRoot: cwd, sessionName: "live-hc" }),
      // No healthcheckDefaultsLoader injected: exercise the default loader that
      // reads <wos-home>/config.json fresh per operation.
      upRunner: async (_ctx, opts) => {
        observedRetries.push(opts.healthcheckDefaults!.retries);
        upCount += 1;
        return {} as any;
      },
    });

    async function runUp() {
      const res = await handler(
        new Request("http://x/ui/v1/worktrees/up", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: wt }),
        }),
      );
      expect(res!.status).toBe(202);
      const body = (await res!.json()) as WorktreeUpResponse;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const rec = registry.get(body.operationId);
        if (rec && rec.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ healthcheck: { retries: 7 } }),
    );
    await runUp();

    await writeFile(
      join(tmpHome, "config.json"),
      JSON.stringify({ healthcheck: { retries: 9 } }),
    );
    await runUp();

    expect(upCount).toBe(2);
    expect(observedRetries).toEqual([7, 9]);
  });
});
