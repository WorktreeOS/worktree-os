import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import { validateConfig } from "@worktreeos/core/config";
import { writeState, type WosState } from "@worktreeos/core/state";
import { sessionStatePath } from "@worktreeos/core/paths";
import type { SessionContext } from "@worktreeos/core/session-context";
import type { WorktreeDetailResponse } from "@worktreeos/daemon/ui-protocol";

const SHELL_YAML = `mode: shell
host_ports:
  range:
    start: 21000
    end: 21999
targets:
  frontend:
    - web
arguments:
  - API_URL
app:
  services:
    api:
      script:
        - run api
      ports:
        - port: 3000
          healthcheck: false
    web:
      script:
        - run web
      dependencies:
        - api
`;

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-shell-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, null);
});

function shellState(worktreeRoot: string): WosState {
  return {
    initialized: true,
    projectName: "shell-p",
    composeFile: "",
    backend: "shell",
    mode: "shell",
    worktreeRoot,
    sourcePath: worktreeRoot,
    portAssignments: { api: { "3000": 21000 } },
    shell: {
      services: {
        api: {
          pid: process.pid,
          processGroupId: process.pid,
          command: ["sh", "-lc", "(run api)"],
          cwd: worktreeRoot,
          environmentKeys: ["PATH"],
          logFiles: { stdout: "/tmp/api.out", stderr: "/tmp/api.err" },
          startedAt: "2026-05-29T00:00:00.000Z",
          ports: { "3000": 21000 },
        },
      },
    },
  };
}

async function buildHandler(
  worktreeRoot: string,
  state: WosState | null,
  registryOverride?: import("@worktreeos/daemon/operation-registry").OperationRegistry,
) {
  const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
  const { OperationRegistry } = await import(
    "@worktreeos/daemon/operation-registry"
  );
  const { DaemonSessionRegistry } = await import(
    "@worktreeos/daemon/daemon-sessions"
  );
  const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
  const config = validateConfig(
    (await import("bun")).YAML.parse(SHELL_YAML),
  );
  const ctx: SessionContext = {
    worktreeRoot,
    source: { path: worktreeRoot, bare: false, detached: false },
    config,
    projectName: "shell-p",
    sessionName: "shell-session",
    sessionRoot: "/tmp/shell-session",
    state,
  };
  return createUiApiHandler({
    registry: registryOverride ?? new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    gitRunner: async () => `worktree ${worktreeRoot}\n\n`,
    projectsFilePath: resolve(tmpHome, "projects.json"),
    resolveSession: async () => ctx,
  });
}

describe("UI API: shell-mode worktree detail", () => {
  test("reports shell mode and shell deployment options", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), SHELL_YAML);
    const handler = await buildHandler(wt, null);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.projectConfig.status).toBe("valid");
    if (body.projectConfig.status === "valid") {
      expect(body.projectConfig.mode).toBe("shell");
    }
    // Start options / service selection / runtime arguments are exposed like
    // generated-compose mode.
    expect(body.deploymentOptions?.appServices).toEqual(["api", "web"]);
    expect(body.deploymentOptions?.targets).toEqual({ frontend: ["web"] });
    expect(body.deploymentOptions?.arguments).toEqual(["API_URL"]);
    expect(body.deploymentOptions?.deps).toEqual([]);
    // Configured container ports surface on the deployment options and feed the
    // not-started launch preview.
    expect(body.deploymentOptions?.ports).toEqual([3000]);
    expect(body.launchPreview).toBeDefined();
    expect(body.launchPreview!.serviceCount).toBe(2);
    expect(body.launchPreview!.ports).toEqual([3000]);
    // Never-run worktree: no persisted duration and no latest operation.
    expect(body.launchPreview!.lastRunDurationMs).toBeUndefined();
  });

  test("launch preview uses persisted last-run duration for a not-started worktree", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), SHELL_YAML);
    // A previously-run worktree that is now down: state persists with a
    // recorded deploy duration but is no longer initialized.
    const downState: WosState = {
      initialized: false,
      projectName: "shell-p",
      composeFile: "",
      backend: "shell",
      mode: "shell",
      worktreeRoot: wt,
      sourcePath: wt,
      lastUpDurationMs: 42_000,
    };
    await writeState(sessionStatePath(wt), downState);
    const handler = await buildHandler(wt, null);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.launchPreview).toBeDefined();
    expect(body.launchPreview!.serviceCount).toBe(2);
    expect(body.launchPreview!.ports).toEqual([3000]);
    expect(body.launchPreview!.lastRunDurationMs).toBe(42_000);
  });

  test("launch preview derives last-run duration from latest operation when state lacks it", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), SHELL_YAML);
    const { OperationRegistry } = await import(
      "@worktreeos/daemon/operation-registry"
    );
    const { sessionNameForWorktree } = await import("@worktreeos/core/paths");
    // Seed a completed up operation with a 15s duration via an advancing clock.
    const times = ["2026-05-29T00:00:00.000Z", "2026-05-29T00:00:15.000Z"];
    let tick = 0;
    const registry = new OperationRegistry({
      now: () => new Date(times[Math.min(tick++, times.length - 1)]!),
    });
    const begun = registry.begin(sessionNameForWorktree(wt), "up");
    if (begun.ok) registry.finish(begun.record, "succeeded");
    const handler = await buildHandler(wt, null, registry);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect(body.launchPreview).toBeDefined();
    expect(body.launchPreview!.lastRunDurationMs).toBe(15_000);
  });

  test("reports running shell service rows and summary", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), SHELL_YAML);
    await writeState(sessionStatePath(wt), shellState(wt));
    const handler = await buildHandler(wt, shellState(wt));
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    expect((body.services ?? []).map((s) => s.service)).toEqual(["api"]);
    expect(body.services?.[0]!.state).toBe("running");
    expect(body.services?.[0]!.ports?.[0]?.hostPort).toBe(21000);
    expect(body.serviceSummary?.running).toBe(1);
    expect(body.serviceSummary?.total).toBe(1);
  });
});

const COMPOSE_YAML = `mode: compose
host_ports:
  range:
    start: 21000
    end: 21999
compose:
  config: docker-compose.yml
  expose:
    - web:3000
    - api:8080
`;

async function buildComposeHandler(worktreeRoot: string) {
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
    gitRunner: async () => `worktree ${worktreeRoot}\n\n`,
    projectsFilePath: resolve(tmpHome, "projects.json"),
    resolveSession: async () => {
      throw new Error("not initialized");
    },
  });
}

describe("UI API: compose-mode launch preview", () => {
  test("launch preview exposes compose-mode exposed ports for a not-started worktree", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await Bun.write(join(wt, ".wos", "deploy.yaml"), COMPOSE_YAML);
    const handler = await buildComposeHandler(wt);
    const res = await handler(
      new Request(`http://x/ui/v1/worktrees?path=${encodeURIComponent(wt)}`),
    );
    const body = (await res!.json()) as WorktreeDetailResponse;
    // Compose mode has no generated deployment options.
    expect(body.deploymentOptions).toBeUndefined();
    expect(body.launchPreview).toBeDefined();
    expect(body.launchPreview!.serviceCount).toBe(2);
    expect(body.launchPreview!.ports).toEqual([3000, 8080]);
    expect(body.launchPreview!.lastRunDurationMs).toBeUndefined();
  });
});
