import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { SessionContext } from "@worktreeos/core/session-context";
import { DAEMON_PROTOCOL_VERSION } from "@worktreeos/daemon/daemon-protocol";
import type { DaemonMetadata } from "@worktreeos/daemon/daemon-paths";
import type { UiHealthResponse } from "@worktreeos/daemon/ui-protocol";

const TEST_PROJECT = "test-proj";

function fakeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    worktreeRoot: "/fake/worktree",
    source: { path: "/fake/source", bare: false, detached: false },
    config: {
      cloneVolumes: [],
      hostPorts: { start: 20000, end: 29999 },
      app: { initScript: [] },
      cache: [],
    } as any,
    projectName: TEST_PROJECT,
    sessionName: "fake-session",
    sessionRoot: "/tmp/fake-session",
    state: null,
    ...overrides,
  };
}

let tmpHome: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-daemon-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
  daemon = undefined as unknown as DaemonHandle;
});

describe("daemon server: HTTP control plane", () => {
  test("GET /ui/v1/health returns enriched discovery metadata", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiHealthResponse;
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(DAEMON_PROTOCOL_VERSION);
    expect(body.pid).toBe(process.pid);
    expect(body.daemonId).toBe(daemon.daemonId);
    expect(typeof body.startedAt).toBe("string");
    expect(body.webHost).toBe(daemon.webBindHostname);
    expect(typeof body.webPort).toBe("number");
    expect(body.webScheme).toBe("http");
  });

  test("legacy /v1/* paths return a structured 404 pointing at /ui/v1", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    for (const path of ["/v1/health", "/v1/operations/up", "/v1/events"]) {
      const res = await fetch(`${daemon.webUrl}${path}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("not-found");
      expect(body.message).toContain("/ui/v1");
    }
  });

  test("writes HTTP discovery metadata without socketPath", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    const metadata = (await Bun.file(
      resolve(tmpHome, "daemon.json"),
    ).json()) as DaemonMetadata;
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.protocol).toBe(DAEMON_PROTOCOL_VERSION);
    expect(metadata.daemonId).toBe(daemon.daemonId);
    expect(metadata.webUrl).toBe(daemon.webUrl);
    expect(metadata.webHost).toBe(daemon.webBindHostname);
    expect(typeof metadata.webPort).toBe("number");
    expect(metadata.webScheme).toBe("http");
    expect("socketPath" in metadata).toBe(false);
    expect(typeof metadata.startedAt).toBe("string");
  });

  test("port-busy startup selects the next free port and records it in metadata", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
      }),
    );
    const occupiedPort = Number(new URL(daemon.webUrl).port);
    // A second daemon asked to bind the occupied port must NOT fail; it binds
    // the next free port instead. Separate metadata path so it does not clobber
    // the first daemon's discovery file.
    const secondMetadataPath = resolve(tmpHome, "daemon-second.json");
    const second = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
        web: { port: occupiedPort },
        metadataPath: secondMetadataPath,
        // Skip the restart EADDRINUSE retry window so the fallback is exercised
        // immediately.
        bindRetryMs: 0,
      }),
    );
    try {
      const boundPort = Number(new URL(second.webUrl).port);
      expect(boundPort).not.toBe(occupiedPort);
      expect(boundPort).toBeGreaterThan(occupiedPort);
      // The effective (selected) port is reflected in the daemon metadata.
      const metadata = (await Bun.file(secondMetadataPath).json()) as DaemonMetadata;
      expect(metadata.webPort).toBe(boundPort);
      expect(metadata.webUrl).toContain(String(boundPort));
      // The listener answers on its selected port.
      const res = await fetch(`${second.webUrl}/ui/v1/health`);
      expect(res.status).toBe(200);
    } finally {
      await second.stop();
    }
  });


  test("wildcard bind reports 127.0.0.1 webUrl while keeping the bind host", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => fakeContext(),
        web: { host: "0.0.0.0", port: 0 },
      }),
    );
    expect(daemon.webBindHostname).toBe("0.0.0.0");
    expect(daemon.webUrl).toContain("127.0.0.1");
    const metadata = (await Bun.file(
      resolve(tmpHome, "daemon.json"),
    ).json()) as DaemonMetadata;
    expect(metadata.webHost).toBe("0.0.0.0");
    expect(metadata.webUrl).toContain("127.0.0.1");
  });
});

describe("daemon server: tunnel registry", () => {
  test("exposes a tunnel registry on the daemon handle", async () => {
    const routes = new Map<string, number>();
    let stopped = false;
    daemon = await startDaemon(withDaemonDefaults(tmpHome, {
      resolveSession: async () => fakeContext({ state: null }),
      globalConfig: {
        web: { port: 0, ssl: { enabled: false } },
        tunnel: {
          enabled: true,
          port: 5858,
          domain: "example.com",
          ssl: { enabled: false },
          webUi: { enabled: false },
          serviceTunnels: { enabled: true, whitelistIps: [] },
        },
        healthcheck: {},
        terminalBackend: "default",
      },
      tunnelServerStarter: async (opts) => ({
        domain: opts.domain,
        port: opts.port,
        scheme: "http",
        registerRoute: (r) => {
          routes.set(r.hostname, r.hostPort);
        },
        unregisterRoute: (h) => {
          routes.delete(h);
        },
        hasRoute: (h) => routes.has(h),
        stop: async () => {
          stopped = true;
        },
      }),
    }));
    await daemon.tunnels.open("session-x", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 21001,
    });
    expect(daemon.tunnels.snapshot("session-x")).toEqual([
      {
        service: "api",
        containerPort: 3000,
        hostPort: 21001,
        state: "active",
        url: "http://feature-login-api.example.com:5858",
        hostname: "feature-login-api.example.com",
      },
    ]);
    await daemon.stop();
    daemon = undefined as unknown as DaemonHandle;
    expect(stopped).toBe(true);
  });
});
