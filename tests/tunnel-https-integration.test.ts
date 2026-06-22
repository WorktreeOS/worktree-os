import { test, expect } from "bun:test";
import { startTunnelServer } from "@worktreeos/runtime/tunnel";
import { generateSelfSignedPemForTests } from "./helpers/tls-test-material.ts";

test("HTTPS tunnel on non-default port includes port in URL", async () => {
  const { cert, key } = await generateSelfSignedPemForTests();
  const backend = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
  });
  const tunnel = await startTunnelServer({
    port: 0,
    domain: "example.com",
    hostname: "127.0.0.1",
    tls: { cert, key },
  });
  // Wait until the listener has an OS-assigned port that is not 443; build a
  // route via the registry to assert the URL includes the explicit port.
  const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
  const registry = new TunnelRegistry();
  registry.setServer(tunnel);
  const outcome = await registry.open("session-1", {
    worktreeRoot: "/tmp/api",
    service: "api",
    containerPort: 3000,
    hostPort: backend.port!,
  });
  try {
    expect(outcome.snapshot.state).toBe("active");
    if (outcome.snapshot.state === "active") {
      expect(outcome.snapshot.url).toMatch(
        new RegExp(`^https://api-api\\.example\\.com:${tunnel.port}$`),
      );
    }
  } finally {
    await tunnel.stop();
    backend.stop(true);
  }
});

test("HTTPS tunnel proxies request to HTTP backend", async () => {
  const { cert, key } = await generateSelfSignedPemForTests();
  const backend = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new Response(`hello, host=${req.headers.get("host")}, xfp=${req.headers.get("x-forwarded-proto")}`),
  });
  const tunnel = await startTunnelServer({
    port: 0,
    domain: "example.com",
    hostname: "127.0.0.1",
    tls: { cert, key },
  });
  tunnel.registerRoute({
    hostname: "feature-api.example.com",
    hostPort: backend.port!,
    backendProtocol: "http",
    policy: { routeType: "service", whitelistIps: [] },
  });
  try {
    expect(tunnel.scheme).toBe("https");
    const res = await fetch(`https://127.0.0.1:${tunnel.port}/`, {
      headers: { host: "feature-api.example.com" },
      tls: { rejectUnauthorized: false } as any,
    } as any);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello");
    expect(body).toContain("xfp=https");
  } finally {
    await tunnel.stop();
    backend.stop(true);
  }
});

test("HTTPS tunnel proxies to HTTPS backend with self-signed cert", async () => {
  const tunnelCerts = await generateSelfSignedPemForTests();
  const backendCerts = await generateSelfSignedPemForTests();
  const backend = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: backendCerts.cert, key: backendCerts.key },
    fetch: () => new Response("hello-https-backend"),
  });
  const tunnel = await startTunnelServer({
    port: 0,
    domain: "example.com",
    hostname: "127.0.0.1",
    tls: { cert: tunnelCerts.cert, key: tunnelCerts.key },
  });
  tunnel.registerRoute({
    hostname: "feature-api.example.com",
    hostPort: backend.port!,
    backendProtocol: "https",
    policy: { routeType: "service", whitelistIps: [] },
  });
  try {
    const res = await fetch(`https://127.0.0.1:${tunnel.port}/`, {
      headers: { host: "feature-api.example.com" },
      tls: { rejectUnauthorized: false } as any,
    } as any);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("hello-https-backend");
  } finally {
    await tunnel.stop();
    backend.stop(true);
  }
});

test("HTTPS tunnel proxies WS upgrade to HTTPS backend (wss:// self-signed)", async () => {
  const tunnelCerts = await generateSelfSignedPemForTests();
  const backendCerts = await generateSelfSignedPemForTests();
  let upstreamUpgrades = 0;
  const backend = Bun.serve<{ kind: "be" }>({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: backendCerts.cert, key: backendCerts.key },
    fetch(req, srv) {
      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        upstreamUpgrades += 1;
        const ok = srv.upgrade(req, { data: { kind: "be" } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("backend");
    },
    websocket: {
      open(ws) {
        ws.send("hello-from-https-backend");
      },
      message() {},
      close() {},
    },
  });
  const tunnel = await startTunnelServer({
    port: 0,
    domain: "example.com",
    hostname: "127.0.0.1",
    tls: { cert: tunnelCerts.cert, key: tunnelCerts.key },
  });
  tunnel.registerRoute({
    hostname: "feature-api.example.com",
    hostPort: backend.port!,
    backendProtocol: "https",
    policy: { routeType: "service", whitelistIps: [] },
  });
  try {
    const wsUrl = `wss://127.0.0.1:${tunnel.port}/`;
    const messages: string[] = [];
    const WS = globalThis.WebSocket as unknown as new (
      url: string,
      opts: { headers?: Record<string, string>; tls?: { rejectUnauthorized: boolean } },
    ) => WebSocket;
    const ws = new WS(wsUrl, {
      headers: { host: "feature-api.example.com" },
      tls: { rejectUnauthorized: false },
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("ws open timeout")), 3000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        rejectOpen(new Error(`ws error: ${String(e)}`));
      });
    });
    ws.addEventListener("message", (ev) => messages.push(String(ev.data)));
    for (let i = 0; i < 20 && messages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(messages).toContain("hello-from-https-backend");
    expect(upstreamUpgrades).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await tunnel.stop();
    backend.stop(true);
  }
});

test("HTTPS tunnel proxies WS upgrade to HTTP backend (ws://)", async () => {
  const { cert, key } = await generateSelfSignedPemForTests();
  let upstreamUpgrades = 0;
  const backend = Bun.serve<{ kind: "be" }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        upstreamUpgrades += 1;
        const ok = srv.upgrade(req, { data: { kind: "be" } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("backend", { status: 200 });
    },
    websocket: {
      open(ws) {
        ws.send("hello-from-backend");
      },
      message() {},
      close() {},
    },
  });
  const tunnel = await startTunnelServer({
    port: 0,
    domain: "example.com",
    hostname: "127.0.0.1",
    tls: { cert, key },
  });
  tunnel.registerRoute({
    hostname: "feature-api.example.com",
    hostPort: backend.port!,
    backendProtocol: "http",
    policy: { routeType: "service", whitelistIps: [] },
  });
  try {
    const wsUrl = `wss://127.0.0.1:${tunnel.port}/`;
    const messages: string[] = [];
    const WS = globalThis.WebSocket as unknown as new (
      url: string,
      opts: { headers?: Record<string, string>; tls?: { rejectUnauthorized: boolean } },
    ) => WebSocket;
    const ws = new WS(wsUrl, {
      headers: { host: "feature-api.example.com" },
      tls: { rejectUnauthorized: false },
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("ws open timeout")), 3000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        rejectOpen(new Error(`ws error: ${String(e)}`));
      });
    });
    ws.addEventListener("message", (ev) => messages.push(String(ev.data)));
    for (let i = 0; i < 20 && messages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(messages).toContain("hello-from-backend");
    expect(upstreamUpgrades).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await tunnel.stop();
    backend.stop(true);
  }
});
