import { describe, expect, test } from "bun:test";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { TunnelRoute, TunnelServer } from "@worktreeos/runtime/tunnel";

interface MockServer extends TunnelServer {
  registered: TunnelRoute[];
  failRegistrationFor?: string;
  stopped: boolean;
}

function makeMockServer(
  opts: {
    domain?: string;
    failFor?: string;
    scheme?: "http" | "https";
    port?: number;
    publicPort?: number;
  } = {},
): MockServer {
  const routes = new Map<string, number>();
  const registered: TunnelRoute[] = [];
  const server: MockServer = {
    domain: opts.domain ?? "example.com",
    port: opts.port ?? 80,
    ...(opts.publicPort !== undefined ? { publicPort: opts.publicPort } : {}),
    scheme: opts.scheme ?? "http",
    registered,
    failRegistrationFor: opts.failFor,
    stopped: false,
    registerRoute(route) {
      if (server.failRegistrationFor === route.hostname) {
        throw new Error(`registration forced failure: ${route.hostname}`);
      }
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

describe("TunnelRegistry", () => {
  test("open registers active record with generated hostname", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const result = await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(result.snapshot.state).toBe("active");
    expect(registry.snapshot("session-1")).toEqual([
      {
        service: "api",
        containerPort: 3000,
        hostPort: 20042,
        state: "active",
        url: "http://feature-login-api.example.com",
        hostname: "feature-login-api.example.com",
      },
    ]);
    expect(server.registered).toEqual([
      {
        hostname: "feature-login-api.example.com",
        hostPort: 20042,
        backendProtocol: "http",
        policy: { routeType: "service", whitelistIps: [] },
      },
    ]);
  });

  test("URL uses server.publicPort when set, not the listener bind port", async () => {
    const server = makeMockServer({ scheme: "https", port: 5858, publicPort: 443 });
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const result = await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(result.snapshot.state).toBe("active");
    if (result.snapshot.state === "active") {
      expect(result.snapshot.url).toBe("https://feature-login-api.example.com");
    }
  });

  test("URL uses server.port when publicPort is unset", async () => {
    const server = makeMockServer({ scheme: "http", port: 5858 });
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const result = await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(result.snapshot.state).toBe("active");
    if (result.snapshot.state === "active") {
      expect(result.snapshot.url).toBe("http://feature-login-api.example.com:5858");
    }
  });

  test("URL on https with publicPort=8443 includes the port", async () => {
    const server = makeMockServer({ scheme: "https", port: 5858, publicPort: 8443 });
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const result = await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(result.snapshot.state).toBe("active");
    if (result.snapshot.state === "active") {
      expect(result.snapshot.url).toBe(
        "https://feature-login-api.example.com:8443",
      );
    }
  });

  test("failed registration stores failed snapshot without throwing", async () => {
    const server = makeMockServer({ failFor: "feature-login-api.example.com" });
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const result = await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(result.snapshot.state).toBe("failed");
    expect(registry.snapshot("session-1")[0]).toMatchObject({
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      state: "failed",
    });
  });

  test("missing server records failed snapshot", async () => {
    const registry = new TunnelRegistry();
    const result = await registry.open("session-1", {
      worktreeRoot: "/tmp/foo",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(result.snapshot.state).toBe("failed");
    if (result.snapshot.state === "failed") {
      expect(result.snapshot.message).toContain("not running");
    }
  });

  test("hostname conflict increments worktree suffix", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    // session-1 takes feature-login-api.example.com
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    // session-2 has same worktree basename — should get suffix 2
    await registry.open("session-2", {
      worktreeRoot: "/other/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20055,
    });
    const snap = registry.snapshot("session-2");
    expect(snap[0]?.state).toBe("active");
    if (snap[0]?.state === "active") {
      expect(snap[0].hostname).toBe("feature-login2-api.example.com");
    }
    // and a third
    await registry.open("session-3", {
      worktreeRoot: "/yet-another/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20060,
    });
    const snap3 = registry.snapshot("session-3");
    if (snap3[0]?.state === "active") {
      expect(snap3[0].hostname).toBe("feature-login3-api.example.com");
    }
  });

  test("DNS-unsafe characters are sanitized", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/Feature/Login",
      service: "Web_App",
      containerPort: 3000,
      hostPort: 20042,
    });
    const snap = registry.snapshot("session-1")[0];
    if (snap?.state === "active") {
      expect(snap.hostname).toBe("login-web-app.example.com");
    }
  });

  test("hostnameMap exposes active tunnels keyed by service and port", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "web",
      containerPort: 8080,
      hostPort: 20100,
    });
    expect(registry.hostnameMap("session-1")).toEqual({
      api: { "3000": "feature-login-api.example.com" },
      web: { "8080": "feature-login-web.example.com" },
    });
  });

  test("urlMap exposes active tunnel URLs keyed by service and port", async () => {
    const server = makeMockServer({ scheme: "https", port: 8443, publicPort: 443 });
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "web",
      containerPort: 8080,
      hostPort: 20100,
    });
    expect(registry.urlMap("session-1")).toEqual({
      api: { "3000": "https://feature-login-api.example.com" },
      web: { "8080": "https://feature-login-web.example.com" },
    });
  });

  test("reset unregisters active routes and clears failed", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    expect(server.hasRoute("feature-login-api.example.com")).toBe(true);
    await registry.reset("session-1");
    expect(server.hasRoute("feature-login-api.example.com")).toBe(false);
    expect(registry.snapshot("session-1")).toEqual([]);
  });

  test("drop unregisters routes and removes session entry", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    await registry.drop("session-1");
    expect(server.hasRoute("feature-login-api.example.com")).toBe(false);
    expect(registry.snapshot("session-1")).toEqual([]);
    expect(registry.hostnameMap("session-1")).toEqual({});
  });

  test("closeOne unregisters only matching route", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    await registry.open("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 4000,
      hostPort: 20043,
    });
    await registry.closeOne("session-1", "api", 3000);
    expect(server.hasRoute("feature-login-api.example.com")).toBe(false);
    // The second one differs by container port but same hostname allocation
    // would conflict — for distinct ports we generate the same hostname?
    // Yes, because hostname is per service-name. That means the second is the
    // suffix-2 hostname.
    const remaining = registry.snapshot("session-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.containerPort).toBe(4000);
  });

  test("shutdown unregisters routes across all sessions and stops the server", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.open("session-1", {
      worktreeRoot: "/tmp/a",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
    });
    await registry.open("session-2", {
      worktreeRoot: "/tmp/b",
      service: "web",
      containerPort: 8080,
      hostPort: 20100,
    });
    await registry.shutdown();
    expect(server.stopped).toBe(true);
    expect(registry.snapshot("session-1")).toEqual([]);
    expect(registry.snapshot("session-2")).toEqual([]);
    expect(registry.getServer()).toBeUndefined();
  });

  test("restore registers a known hostname without allocating a new one", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const result = await registry.restore("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      hostname: "saved-hostname.example.com",
    });
    expect(result.snapshot.state).toBe("active");
    expect(registry.snapshot("session-1")).toEqual([
      {
        service: "api",
        containerPort: 3000,
        hostPort: 20042,
        state: "active",
        url: "http://saved-hostname.example.com",
        hostname: "saved-hostname.example.com",
      },
    ]);
    expect(server.registered).toEqual([
      {
        hostname: "saved-hostname.example.com",
        hostPort: 20042,
        backendProtocol: "http",
        policy: { routeType: "service", whitelistIps: [] },
      },
    ]);
  });

  test("restore is idempotent for the same tuple", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const req = {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      hostname: "saved-hostname.example.com",
    };
    const r1 = await registry.restore("session-1", req);
    const r2 = await registry.restore("session-1", req);
    expect(r1.snapshot.state).toBe("active");
    expect(r2.snapshot.state).toBe("active");
    expect(r1.snapshot).toEqual(r2.snapshot);
    expect(server.registered).toHaveLength(1);
    expect(registry.snapshot("session-1")).toHaveLength(1);
  });

  test("restore detects hostname conflict from different session", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    // Register hostname in session-1 first.
    await registry.restore("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      hostname: "saved-hostname.example.com",
    });
    // Try to restore same hostname in session-2 with different service/port.
    const result = await registry.restore("session-2", {
      worktreeRoot: "/tmp/other",
      service: "web",
      containerPort: 8080,
      hostPort: 20100,
      hostname: "saved-hostname.example.com",
    });
    expect(result.snapshot.state).toBe("failed");
    if (result.snapshot.state === "failed") {
      expect(result.snapshot.message).toContain("already registered");
    }
    // session-1 still has its active record.
    expect(registry.snapshot("session-1")).toHaveLength(1);
  });

  test("restore handles conflict within same session for different service/port", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    await registry.restore("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      hostname: "shared-hostname.example.com",
    });
    const result = await registry.restore("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 4000,
      hostPort: 20043,
      hostname: "shared-hostname.example.com",
    });
    expect(result.snapshot.state).toBe("failed");
  });

  test("restore with missing server records failed snapshot", async () => {
    const registry = new TunnelRegistry();
    const result = await registry.restore("session-1", {
      worktreeRoot: "/tmp/foo",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      hostname: "some-hostname.example.com",
    });
    expect(result.snapshot.state).toBe("failed");
  });

  test("restore publishes opened event for active route", async () => {
    const server = makeMockServer();
    const registry = new TunnelRegistry();
    registry.setServer(server);
    const events: Array<{ type: string; hostname: string }> = [];
    registry.setEventPublisher({
      publishOpened(_sessionName, snapshot) {
        events.push({ type: "opened", hostname: snapshot.hostname });
      },
      publishFailed() {},
      publishClosed() {},
      publishReset() {},
      publishDropped() {},
    });
    await registry.restore("session-1", {
      worktreeRoot: "/tmp/feature-login",
      service: "api",
      containerPort: 3000,
      hostPort: 20042,
      hostname: "saved-hostname.example.com",
    });
    expect(events).toEqual([
      { type: "opened", hostname: "saved-hostname.example.com" },
    ]);
  });
});

describe("Local tunnel HTTP server proxy", () => {
  test("serves not-found for unknown host header", async () => {
    const { startTunnelServer } = await import("@worktreeos/runtime/tunnel");
    const server = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    const port = server.port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { host: "nobody.example.com" },
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("proxies to registered backend by host header", async () => {
    const { startTunnelServer } = await import("@worktreeos/runtime/tunnel");
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new Response(`hello from backend, host=${req.headers.get("host")}`),
    });
    const backendPort = backend.port!;
    const tunnelServer = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    tunnelServer.registerRoute({
      hostname: "feature-api.example.com",
      hostPort: backendPort,
      policy: { routeType: "service", whitelistIps: [] },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${tunnelServer.port}/`, {
        headers: { host: "feature-api.example.com" },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("hello from backend");
    } finally {
      await tunnelServer.stop();
      backend.stop(true);
    }
  });

  test("forwards x-forwarded-proto based on tunnel listener scheme", async () => {
    const { startTunnelServer } = await import("@worktreeos/runtime/tunnel");
    const seenHeaders: Record<string, string | null> = {};
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seenHeaders["x-forwarded-proto"] = req.headers.get("x-forwarded-proto");
        seenHeaders["x-forwarded-host"] = req.headers.get("x-forwarded-host");
        return new Response("ok");
      },
    });
    const tunnelServer = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    tunnelServer.registerRoute({
      hostname: "feature-api.example.com",
      hostPort: backend.port!,
      policy: { routeType: "service", whitelistIps: [] },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${tunnelServer.port}/`, {
        headers: { host: "feature-api.example.com" },
      });
      expect(res.status).toBe(200);
      expect(seenHeaders["x-forwarded-proto"]).toBe("http");
      expect(seenHeaders["x-forwarded-host"]).toBe("feature-api.example.com");
      expect(tunnelServer.scheme).toBe("http");
    } finally {
      await tunnelServer.stop();
      backend.stop(true);
    }
  });

  test("registry uses scheme from tunnel server for active URLs", async () => {
    const fake = makeMockServer({ scheme: "https", port: 443 });
    const registry = new TunnelRegistry();
    registry.setServer(fake);
    const result = await registry.open("s1", {
      worktreeRoot: "/tmp/feature-api",
      service: "api",
      containerPort: 3000,
      hostPort: 21111,
    });
    expect(result.snapshot.state).toBe("active");
    if (result.snapshot.state === "active") {
      expect(result.snapshot.url).toBe(
        "https://feature-api-api.example.com",
      );
    }
  });

  test("returns 403 when client IP is not in route whitelist", async () => {
    const { startTunnelServer } = await import("@worktreeos/runtime/tunnel");
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("should-not-reach"),
    });
    const tunnelServer = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    tunnelServer.registerRoute({
      hostname: "feature-api.example.com",
      hostPort: backend.port!,
      policy: {
        routeType: "service",
        whitelistIps: ["10.20.30.40"],
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${tunnelServer.port}/`, {
        headers: { host: "feature-api.example.com" },
      });
      expect(res.status).toBe(403);
    } finally {
      await tunnelServer.stop();
      backend.stop(true);
    }
  });

  test("allows client when IP matches whitelist entry", async () => {
    const { startTunnelServer } = await import("@worktreeos/runtime/tunnel");
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("backend-reached"),
    });
    const tunnelServer = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    tunnelServer.registerRoute({
      hostname: "feature-api.example.com",
      hostPort: backend.port!,
      policy: {
        routeType: "service",
        whitelistIps: ["127.0.0.1"],
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${tunnelServer.port}/`, {
        headers: { host: "feature-api.example.com" },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("backend-reached");
    } finally {
      await tunnelServer.stop();
      backend.stop(true);
    }
  });

  test("registry includes explicit port when non-default for scheme", async () => {
    const httpsOn80 = makeMockServer({ scheme: "https", port: 80 });
    const reg1 = new TunnelRegistry();
    reg1.setServer(httpsOn80);
    const r1 = await reg1.open("s1", {
      worktreeRoot: "/tmp/feature-api",
      service: "api",
      containerPort: 3000,
      hostPort: 21111,
    });
    expect(r1.snapshot.state).toBe("active");
    if (r1.snapshot.state === "active") {
      expect(r1.snapshot.url).toBe("https://feature-api-api.example.com:80");
    }

    const httpOn8080 = makeMockServer({ scheme: "http", port: 8080 });
    const reg2 = new TunnelRegistry();
    reg2.setServer(httpOn8080);
    const r2 = await reg2.open("s2", {
      worktreeRoot: "/tmp/feature-web",
      service: "api",
      containerPort: 3000,
      hostPort: 21112,
    });
    expect(r2.snapshot.state).toBe("active");
    if (r2.snapshot.state === "active") {
      expect(r2.snapshot.url).toBe("http://feature-web-api.example.com:8080");
    }
  });
});
