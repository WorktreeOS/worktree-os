import { test, expect, describe } from "bun:test";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { TunnelServer, TunnelRoute } from "@worktreeos/runtime/tunnel";
import { rotateTunnelListener, rotateWebListener } from "@worktreeos/daemon/acme/rotation";

function createFakeServer(domain: string, port: number, scheme: "http" | "https"): TunnelServer & {
  routes: Map<string, number>;
  stopped: boolean;
} {
  const routes = new Map<string, number>();
  const server = {
    port,
    domain,
    scheme,
    routes,
    stopped: false,
    hasRoute(hostname: string) {
      return routes.has(hostname);
    },
    registerRoute(route: TunnelRoute) {
      if (routes.has(route.hostname)) {
        throw new Error(`route ${route.hostname} already registered`);
      }
      routes.set(route.hostname, route.hostPort);
    },
    unregisterRoute(hostname: string) {
      routes.delete(hostname);
    },
    async stop() {
      this.stopped = true;
    },
  } as TunnelServer & { routes: Map<string, number>; stopped: boolean };
  return server;
}

describe("TunnelRegistry replay snapshot", () => {
  test("snapshot captures active app routes and daemon routes with policy", async () => {
    const reg = new TunnelRegistry();
    reg.setServiceRoutePolicy(["10.0.0.1"]);
    const srv = createFakeServer("example.com", 5858, "http");
    reg.setServer(srv);
    await reg.open("session-a", {
      worktreeRoot: "/wt/a",
      service: "web",
      containerPort: 3000,
      hostPort: 4000,
    });
    reg.registerDaemonRoute({
      hostname: "wos.example.com",
      hostPort: 4949,
      routeType: "daemon-web-ui",
      whitelistIps: ["192.168.1.1"],
    });
    const snap = reg.routeReplaySnapshot();
    expect(snap.app.length).toBe(1);
    expect(snap.app[0]?.service).toBe("web");
    expect(snap.app[0]?.whitelistIps).toEqual(["10.0.0.1"]);
    expect(snap.daemon).toEqual([
      {
        hostname: "wos.example.com",
        hostPort: 4949,
        backendProtocol: "http",
        whitelistIps: ["192.168.1.1"],
      },
    ]);
  });

  test("replayRoutes re-registers everything on a new server, preserving policy", async () => {
    const reg = new TunnelRegistry();
    reg.setServiceRoutePolicy(["10.0.0.1"]);
    const oldSrv = createFakeServer("example.com", 5858, "http");
    reg.setServer(oldSrv);
    await reg.open("s", {
      worktreeRoot: "/wt",
      service: "api",
      containerPort: 8080,
      hostPort: 8081,
    });
    reg.registerDaemonRoute({
      hostname: "wos.example.com",
      hostPort: 4949,
      routeType: "daemon-web-ui",
      whitelistIps: ["192.168.1.1"],
    });
    const snap = reg.routeReplaySnapshot();
    const newSrv = createFakeServer("example.com", 443, "https");
    // Track the registered routes' policy material on the new server.
    const registered: TunnelRoute[] = [];
    const newSrvWithCapture: TunnelServer = {
      ...newSrv,
      registerRoute(route) {
        registered.push(route);
        newSrv.registerRoute(route);
      },
    };
    reg.setServer(newSrvWithCapture);
    const result = reg.replayRoutes(snap);
    expect(result.appFailures).toEqual([]);
    expect(result.daemonFailures).toEqual([]);
    expect(newSrv.routes.size).toBe(2);
    expect(newSrv.routes.has("wos.example.com")).toBe(true);
    const appReplay = registered.find((r) => r.policy.routeType === "service");
    expect(appReplay?.policy.whitelistIps).toEqual(["10.0.0.1"]);
    const daemonReplay = registered.find(
      (r) => r.policy.routeType === "daemon-web-ui",
    );
    expect(daemonReplay?.policy.whitelistIps).toEqual(["192.168.1.1"]);
  });
});

describe("rotateWebListener", () => {
  test("stops existing handle and binds replacement", async () => {
    let stopped = false;
    let bindCalls = 0;
    const result = await rotateWebListener({
      current: {
        stop: async () => {
          stopped = true;
        },
      },
      start: async (tls) => {
        bindCalls += 1;
        expect(tls.cert).toBe("NEW-CERT");
        return {
          stop: async () => {},
        };
      },
      material: { cert: "NEW-CERT", key: "NEW-KEY" },
    });
    expect(stopped).toBe(true);
    expect(bindCalls).toBe(1);
    expect(result.ok).toBe(true);
  });

  test("reports bind failure", async () => {
    const result = await rotateWebListener({
      current: { stop: async () => {} },
      start: async () => {
        throw new Error("port in use");
      },
      material: { cert: "C", key: "K" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("port in use");
    }
  });
});

describe("rotateTunnelListener", () => {
  test("stops old, starts replacement, replays routes", async () => {
    const reg = new TunnelRegistry();
    const oldSrv = createFakeServer("example.com", 5858, "http");
    reg.setServer(oldSrv);
    await reg.open("s", {
      worktreeRoot: "/wt",
      service: "api",
      containerPort: 8080,
      hostPort: 8081,
    });
    reg.registerDaemonRoute({
      hostname: "wos.example.com",
      hostPort: 4949,
      routeType: "daemon-web-ui",
    });
    const newSrv = createFakeServer("example.com", 443, "https");
    const result = await rotateTunnelListener({
      registry: reg,
      material: { cert: "C", key: "K" },
      start: async () => newSrv,
    });
    expect(result.ok).toBe(true);
    expect(oldSrv.stopped).toBe(true);
    expect(newSrv.routes.size).toBe(2);
    expect(reg.getServer()).toBe(newSrv);
  });

  test("reports app route replay failures via callback", async () => {
    const reg = new TunnelRegistry();
    const oldSrv = createFakeServer("example.com", 5858, "http");
    reg.setServer(oldSrv);
    await reg.open("s", {
      worktreeRoot: "/wt",
      service: "api",
      containerPort: 8080,
      hostPort: 8081,
    });
    // New server that refuses any registration.
    const failingServer = {
      port: 443,
      domain: "example.com",
      scheme: "https" as const,
      hasRoute: () => false,
      registerRoute: () => {
        throw new Error("registration disabled");
      },
      unregisterRoute: () => {},
      async stop() {},
    } as unknown as TunnelServer;
    const failures: { hostname: string; reason: string }[] = [];
    const result = await rotateTunnelListener({
      registry: reg,
      material: { cert: "C", key: "K" },
      start: async () => failingServer,
      onAppRouteFailure: (h, r) => failures.push({ hostname: h, reason: r }),
    });
    expect(result.ok).toBe(true);
    expect(failures.length).toBe(1);
    expect(failures[0]?.reason).toContain("registration disabled");
  });
});
