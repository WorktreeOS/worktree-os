import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { GlobalConfig } from "@worktreeos/core/global-config";
import type {
  StartTunnelServerOptions,
  TunnelRoute,
  TunnelServer,
} from "@worktreeos/runtime/tunnel";

interface FakeServer extends TunnelServer {
  registered: TunnelRoute[];
  stopped: boolean;
}

function makeFakeServer(
  opts: { domain?: string; scheme?: "http" | "https" } = {},
): FakeServer {
  const routes = new Map<string, number>();
  const registered: TunnelRoute[] = [];
  const server: FakeServer = {
    domain: opts.domain ?? "example.com",
    port: 5858,
    scheme: opts.scheme ?? "http",
    registered,
    stopped: false,
    registerRoute(route) {
      if (routes.has(route.hostname)) {
        throw new Error(`already registered: ${route.hostname}`);
      }
      routes.set(route.hostname, route.hostPort);
      registered.push(route);
    },
    unregisterRoute(hostname) {
      routes.delete(hostname);
    },
    hasRoute(hostname) {
      return routes.has(hostname);
    },
    async stop() {
      server.stopped = true;
      routes.clear();
    },
  };
  return server;
}

function tunnelWebUiConfig(secret = "letmein"): GlobalConfig {
  return {
    web: { port: 0, ssl: { enabled: false } },
    tunnel: {
      enabled: true,
      port: 5858,
      domain: "example.com",
      ssl: { enabled: false },
      webUi: {
        enabled: true,
        hostname: "wos.example.com",
        secret,
        terminalEnabled: false,
        whitelistIps: [],
      },
      serviceTunnels: { enabled: false, whitelistIps: [] },
    },
    healthcheck: {},
    terminalBackend: "default",
  };
}

describe("daemon public web tunnel route", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-public-route-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("registers a daemon-scoped route when tunnel.webUi is enabled", async () => {
    const fake = makeFakeServer();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: tunnelWebUiConfig(),
        tunnelServerStarter: async (_o: StartTunnelServerOptions) => fake,
      }),
    );
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]!.hostname).toBe("wos.example.com");
    expect(fake.registered[0]!.backendProtocol).toBe("http");
    expect(fake.registered[0]!.policy.routeType).toBe("daemon-web-ui");
    expect(fake.registered[0]!.policy.whitelistIps).toEqual([]);
    expect(fake.hasRoute("wos.example.com")).toBe(true);
    expect(daemon.tunnels.hasDaemonRoute("wos.example.com")).toBe(true);
  });

  test("propagates whitelistIps onto the daemon Web UI route", async () => {
    const fake = makeFakeServer();
    const config: GlobalConfig = tunnelWebUiConfig();
    if (config.tunnel.webUi.enabled) {
      config.tunnel.webUi.whitelistIps = ["10.0.0.1"];
    }
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: config,
        tunnelServerStarter: async () => fake,
      }),
    );
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]!.policy.whitelistIps).toEqual(["10.0.0.1"]);
  });

  test("daemon route is not part of any session snapshot", async () => {
    const fake = makeFakeServer();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: tunnelWebUiConfig(),
        tunnelServerStarter: async () => fake,
      }),
    );
    expect(daemon.tunnels.snapshot("any-session")).toEqual([]);
  });

  test("does not register when tunnel.webUi is disabled (default)", async () => {
    const fake = makeFakeServer();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        tunnelServerStarter: async () => fake,
        globalConfig: {
          web: { port: 0, ssl: { enabled: false } },
          tunnel: {
            enabled: true,
            port: 5858,
            domain: "example.com",
            ssl: { enabled: false },
            webUi: { enabled: false },
            serviceTunnels: { enabled: false, whitelistIps: [] },
          },
          healthcheck: {},
          terminalBackend: "default",
        },
      }),
    );
    expect(fake.registered).toHaveLength(0);
  });

  test("does not register when tunnel server is unavailable, warns to stderr", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      stderrChunks.push(s);
      return true;
    }) as any;
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { port: 0 },
          globalConfig: {
            web: { port: 0, ssl: { enabled: false } },
            tunnel: {
              enabled: false,
              port: 5858,
              ssl: { enabled: false },
              webUi: {
                enabled: true,
                hostname: "wos.example.com",
                secret: "x",
                terminalEnabled: false,
                whitelistIps: [],
              },
              serviceTunnels: { enabled: false, whitelistIps: [] },
            },
            healthcheck: {},
            terminalBackend: "default",
          },
        }),
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = stderrChunks.join("");
    expect(combined).toContain("wos.example.com");
    expect(combined).toContain("tunnel server unavailable");
  });

  test("fails soft with a warning when hostname conflicts", async () => {
    const fake = makeFakeServer();
    // Pre-register the conflicting hostname so `registerRoute` would throw.
    fake.registerRoute({
      hostname: "wos.example.com",
      hostPort: 99999,
      policy: { routeType: "service", whitelistIps: [] },
    });

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      stderrChunks.push(s);
      return true;
    }) as any;
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { port: 0 },
          globalConfig: tunnelWebUiConfig(),
          tunnelServerStarter: async () => fake,
        }),
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = stderrChunks.join("");
    expect(combined).toContain("wos.example.com");
    expect(combined.toLowerCase()).toContain("already registered");
    expect(daemon.tunnels.hasDaemonRoute("wos.example.com")).toBe(false);
  });

  test("deployment reset and drop preserve the daemon public route", async () => {
    const fake = makeFakeServer();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: tunnelWebUiConfig(),
        tunnelServerStarter: async () => fake,
      }),
    );
    expect(fake.hasRoute("wos.example.com")).toBe(true);

    await daemon.tunnels.reset("session-x");
    expect(fake.hasRoute("wos.example.com")).toBe(true);

    await daemon.tunnels.drop("session-x");
    expect(fake.hasRoute("wos.example.com")).toBe(true);
  });

  test("daemon shutdown clears the daemon route via server.stop", async () => {
    const fake = makeFakeServer();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: tunnelWebUiConfig(),
        tunnelServerStarter: async () => fake,
      }),
    );
    expect(fake.hasRoute("wos.example.com")).toBe(true);
    await daemon.stop();
    // Re-using `daemon` in afterEach is safe; the second stop is a no-op.
    expect(fake.stopped).toBe(true);
    expect(fake.hasRoute("wos.example.com")).toBe(false);
  });

  test("web.ssl enables HTTPS on the web listener and the tunnel route targets https", async () => {
    const { generateSelfSignedPemForTests } = await import(
      "./helpers/tls-test-material.ts"
    );
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { cert, key } = await generateSelfSignedPemForTests();
    const certPath = join(tmpHome, "web.crt");
    const keyPath = join(tmpHome, "web.key");
    await writeFile(certPath, cert);
    await writeFile(keyPath, key);

    const fake = makeFakeServer();
    const config: GlobalConfig = {
      web: {
        port: 0,
        ssl: { enabled: true, source: "files", cert: certPath, key: keyPath },
      },
      tunnel: {
        enabled: true,
        port: 5858,
        domain: "example.com",
        ssl: { enabled: false },
        webUi: {
          enabled: true,
          hostname: "wos.example.com",
          secret: "letmein",
          terminalEnabled: false,
          whitelistIps: [],
        },
        serviceTunnels: { enabled: false, whitelistIps: [] },
      },
      healthcheck: {},
      terminalBackend: "default",
    };
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: config,
        tunnelServerStarter: async () => fake,
      }),
    );
    expect(daemon.webScheme).toBe("https");
    expect(daemon.webBindHostname).toBe("127.0.0.1");
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]!.backendProtocol).toBe("https");
  });
});
