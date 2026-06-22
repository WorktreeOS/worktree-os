import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WosState } from "@worktreeos/core/state";
import { sessionNameForWorktree } from "@worktreeos/core/paths";
import {
  WOS_LABEL_DEPLOYMENT_ID,
  WOS_LABEL_HOME_HASH,
  WOS_LABEL_MANAGED,
  WOS_LABEL_MODE,
  WOS_LABEL_PROJECT,
  WOS_LABEL_SCHEMA,
  WOS_LABEL_SERVICE,
  WOS_LABEL_SESSION,
  WOS_LABEL_TUNNEL_PORTS,
  stableWosHomeHash,
  tunnelHostnameLabelKey,
  tunnelHostPortLabelKey,
} from "@worktreeos/core/tunnel-metadata";

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-tunnel-restore-"));
  savedHome = process.env.WOS_HOME;
  process.env.WOS_HOME = tmpHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = savedHome;
  await rm(tmpHome, { recursive: true, force: true });
});

function makeValidLabels(overrides?: Partial<Record<string, string>>): Record<string, string> {
  return {
    [WOS_LABEL_MANAGED]: "true",
    [WOS_LABEL_SCHEMA]: "1",
    [WOS_LABEL_HOME_HASH]: stableWosHomeHash(),
    [WOS_LABEL_SESSION]: "fake-session",
    [WOS_LABEL_PROJECT]: "proj",
    [WOS_LABEL_MODE]: "generated",
    [WOS_LABEL_SERVICE]: "api",
    [WOS_LABEL_DEPLOYMENT_ID]: "deploy-1",
    [WOS_LABEL_TUNNEL_PORTS]: "3000",
    [tunnelHostnameLabelKey(3000)]: "feature-api.example.com",
    [tunnelHostPortLabelKey(3000)]: "21432",
    ...overrides,
  };
}

function buildComposeYaml(labels: Record<string, string>): string {
  const labelLines = Object.entries(labels)
    .map(([k, v]) => `      ${k}: "${v}"`)
    .join("\n");
  return `services:\n  api:\n    image: node:22\n    ports:\n      - "21432:3000"\n    labels:\n${labelLines}\n`;
}

async function setupSession(
  sessionName: string,
  state: WosState,
  composeYaml: string,
): Promise<string> {
  const sessionDir = join(tmpHome, "sessions", sessionName);
  await mkdir(sessionDir, { recursive: true });
  // Write state.json
  await writeFile(join(sessionDir, "state.json"), JSON.stringify(state, null, 2));
  // Write compose file (state.composeFile should point here)
  const composePath = join(sessionDir, "compose.yaml");
  await writeFile(composePath, composeYaml);
  return composePath;
}

describe("tunnel restoration", () => {
  test("restore is skipped when no tunnel server is running", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );

    const tunnels = new TunnelRegistry();
    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);

    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-1",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
    })));

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      warn: () => {},
    });

    expect(result.restored).toBe(0);
  });

  test("skips when deployment id labels do not match state", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );

    const tunnels = new TunnelRegistry();
    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);

    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-NEW",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
      [WOS_LABEL_DEPLOYMENT_ID]: "deploy-OLD",
    })));

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      dockerRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
      warn: () => {},
    });

    expect(result.restored).toBe(0);
  });

  test("skips when home hash labels do not match current home", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );

    const tunnels = new TunnelRegistry();
    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);

    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-1",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
      [WOS_LABEL_HOME_HASH]: "different-hash",
    })));

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      dockerRunner: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }),
      warn: () => {},
    });

    expect(result.restored).toBe(0);
  });

  test("restores tunnel route when labels, state, and docker ports match", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );

    const tunnels = new TunnelRegistry();

    const registered: Array<{ hostname: string; hostPort: number; backendProtocol?: string }> = [];
    tunnels.setServer({
      domain: "example.com",
      port: 80,
      scheme: "http",
      registerRoute(route) { registered.push(route); },
      unregisterRoute() {},
      hasRoute() { return false; },
      async stop() {},
    });

    const composePsOutput = JSON.stringify([
      {
        Service: "api",
        State: "running",
        Publishers: [
          { TargetPort: 3000, PublishedPort: 21432, Protocol: "tcp" },
        ],
      },
    ]);

    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);

    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-1",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
    })));

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      dockerRunner: async () => ({ stdout: composePsOutput, stderr: "", exitCode: 0 }),
      warn: () => {},
    });

    expect(result.restored).toBe(1);
    expect(registered).toEqual([
      {
        hostname: "feature-api.example.com",
        hostPort: 21432,
        backendProtocol: "http",
        policy: { routeType: "service", whitelistIps: [] },
      },
    ]);

    const snapshots = tunnels.snapshot(sessionName);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.state).toBe("active");
    expect(snapshots[0]!.hostname).toBe("feature-api.example.com");
  });

  test("restores tunnel route validated against the Docker state cache", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const { DockerStateStore } = await import(
      "@worktreeos/daemon/docker/docker-state-store"
    );

    const tunnels = new TunnelRegistry();
    const registered: Array<{ hostname: string; hostPort: number }> = [];
    tunnels.setServer({
      domain: "example.com",
      port: 80,
      scheme: "http",
      registerRoute(route) { registered.push(route); },
      unregisterRoute() {},
      hasRoute() { return false; },
      async stop() {},
    });

    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);
    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-1",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
    })));

    // Fake Docker client reporting a running `api` container publishing
    // 3000 -> 21432, labeled for this session/home. `syncNow()` (called by
    // tunnel restoration) populates the cache from this client.
    const fakeClient = {
      listContainers: async () => [
        {
          Id: "c1",
          Names: ["/proj-api"],
          Image: "node:22",
          ImageID: "",
          Labels: makeValidLabels({ [WOS_LABEL_SESSION]: sessionName }),
          State: "running",
          Status: "Up",
          Ports: [{ PrivatePort: 3000, PublicPort: 21432, Type: "tcp" }],
        },
      ],
      inspectContainer: async () => {
        throw Object.assign(new Error("nf"), { status: 404 });
      },
      openEvents: () => ({
        abort() {},
        events: (async function* () {
          await new Promise<void>(() => {});
        })(),
      }),
      streamLogs: async () => ({}),
      startContainer: async () => {},
      stopContainer: async () => {},
      restartContainer: async () => {},
    };
    const store = new DockerStateStore({
      client: fakeClient as never,
      reconcileIntervalMs: 0,
    });

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      dockerState: store,
      warn: () => {},
    });

    expect(result.restored).toBe(1);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.hostname).toBe("feature-api.example.com");
    expect(registered[0]!.hostPort).toBe(21432);
    await store.stop();
  });

  test("skips when the Docker cache does not report the published port", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );
    const { DockerStateStore } = await import(
      "@worktreeos/daemon/docker/docker-state-store"
    );

    const tunnels = new TunnelRegistry();
    const registered: Array<{ hostname: string }> = [];
    tunnels.setServer({
      domain: "example.com",
      port: 80,
      scheme: "http",
      registerRoute(route) { registered.push(route); },
      unregisterRoute() {},
      hasRoute() { return false; },
      async stop() {},
    });

    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);
    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-1",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
    })));

    // Container is running but publishes a DIFFERENT host port.
    const fakeClient = {
      listContainers: async () => [
        {
          Id: "c1",
          Names: ["/proj-api"],
          Image: "node:22",
          ImageID: "",
          Labels: makeValidLabels({ [WOS_LABEL_SESSION]: sessionName }),
          State: "running",
          Status: "Up",
          Ports: [{ PrivatePort: 3000, PublicPort: 99999, Type: "tcp" }],
        },
      ],
      inspectContainer: async () => {
        throw Object.assign(new Error("nf"), { status: 404 });
      },
      openEvents: () => ({
        abort() {},
        events: (async function* () {
          await new Promise<void>(() => {});
        })(),
      }),
      streamLogs: async () => ({}),
      startContainer: async () => {},
      stopContainer: async () => {},
      restartContainer: async () => {},
    };
    const store = new DockerStateStore({
      client: fakeClient as never,
      reconcileIntervalMs: 0,
    });

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      dockerState: store,
      warn: () => {},
    });

    expect(result.restored).toBe(0);
    expect(registered).toHaveLength(0);
    await store.stop();
  });

  test("skips when docker does not report published port", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );

    const tunnels = new TunnelRegistry();

    const registered: Array<{ hostname: string; hostPort: number; backendProtocol?: string }> = [];
    tunnels.setServer({
      domain: "example.com",
      port: 80,
      scheme: "http",
      registerRoute(route) { registered.push(route); },
      unregisterRoute() {},
      hasRoute() { return false; },
      async stop() {},
    });

    // Docker reports the service but with a DIFFERENT host port
    const composePsOutput = JSON.stringify([
      {
        Service: "api",
        State: "running",
        Publishers: [
          { TargetPort: 3000, PublishedPort: 99999, Protocol: "tcp" },
        ],
      },
    ]);

    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);

    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      deploymentId: "deploy-1",
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
    })));

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      dockerRunner: async () => ({ stdout: composePsOutput, stderr: "", exitCode: 0 }),
      warn: () => {},
    });

    expect(result.restored).toBe(0);
    expect(registered).toHaveLength(0);
  });

  test("no state deployment id skips restoration", async () => {
    const { restoreTunnelsFromSessions } = await import(
      "@worktreeos/daemon/tunnel-restoration"
    );
    const { TunnelRegistry } = await import(
      "@worktreeos/runtime/tunnel-registry"
    );

    const tunnels = new TunnelRegistry();
    const worktreeRoot = "/tmp/worktree";
    const sessionName = sessionNameForWorktree(worktreeRoot);

    const composePath = join(tmpHome, "sessions", sessionName, "compose.yaml");
    const state: WosState = {
      initialized: true,
      projectName: "proj",
      composeFile: composePath,
      portAssignments: { api: { "3000": 21432 } },
      worktreeRoot,
      // No deploymentId
    };
    await setupSession(sessionName, state, buildComposeYaml(makeValidLabels({
      [WOS_LABEL_SESSION]: sessionName,
    })));

    const result = await restoreTunnelsFromSessions(tunnels, {
      sessionsDir: join(tmpHome, "sessions"),
      warn: () => {},
    });

    expect(result.restored).toBe(0);
  });
});
