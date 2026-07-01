import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import type { DaemonMetadata } from "@worktreeos/daemon/daemon-paths";
import type { EmbeddedAssetSource } from "@worktreeos/daemon/daemon-web";
import type { GlobalConfig } from "@worktreeos/core/global-config";

const PUBLIC_HOST = "wos.example.com";

function publicEnabledConfig(): GlobalConfig {
  return {
    web: { port: 0, host: "127.0.0.1", ssl: { enabled: false } },
    tunnel: {
      enabled: true,
      port: 5858,
      domain: "example.com",
      ssl: { enabled: false },
      webUi: {
        enabled: true,
        hostname: PUBLIC_HOST,
        secret: "letmein",
        terminalEnabled: false,
        whitelistIps: [],
      },
      serviceTunnels: { enabled: false, whitelistIps: [] },
    },
    healthcheck: {},
    terminalBackend: "default",
  };
}

let tmpHome: string;
let daemon: DaemonHandle;
let metadataPath: string;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-daemon-web-");
  metadataPath = resolve(tmpHome, "daemon.json");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

async function startWithAssets(opts: { assetRoot?: string } = {}) {
  daemon = await startDaemon(
    withDaemonDefaults(tmpHome, {
      resolveSession: async () => ({}) as any,
      web: { port: 0, ...(opts.assetRoot ? { assetRoot: opts.assetRoot } : {}) },
    }),
  );
}

describe("daemon web listener", () => {
  test("binds to a loopback address with an OS-assigned port", async () => {
    await startWithAssets();
    expect(daemon.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("daemon metadata records the web URL", async () => {
    await startWithAssets();
    const raw = await readFile(metadataPath, "utf8");
    const meta = JSON.parse(raw) as DaemonMetadata;
    expect(meta.webUrl).toBe(daemon.webUrl);
    expect(meta.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("serves built static assets with appropriate content type", async () => {
    const assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "index.html"), "<!doctype html><h1>x</h1>");
    await writeFile(join(assetRoot, "main.js"), "console.log(1);");
    await startWithAssets({ assetRoot });

    const html = await fetch(`${daemon.webUrl}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("<h1>x</h1>");

    const js = await fetch(`${daemon.webUrl}/main.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("application/javascript");
    expect(await js.text()).toBe("console.log(1);");
  });

  test("falls back to index.html for non-file SPA routes", async () => {
    const assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "index.html"), "<!doctype html>SPA");
    await startWithAssets({ assetRoot });

    const r = await fetch(`${daemon.webUrl}/sessions/anything`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("SPA");
  });

  test("returns an actionable response when the web build is missing", async () => {
    const assetRoot = join(tmpHome, "nonexistent-dist");
    await startWithAssets({ assetRoot });

    const r = await fetch(`${daemon.webUrl}/`);
    expect(r.status).toBe(503);
    expect((await r.text()).toLowerCase()).toContain("bun run build:web");
  });

  test("embedded mode serves the embedded index HTML at the web root", async () => {
    const embedded: EmbeddedAssetSource = {
      serveIndexHtml: async () =>
        new Response("<!doctype html><h1>EMBEDDED</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("EMBEDDED");
  });

  test("embedded mode SPA fallback returns the embedded index HTML for unknown routes", async () => {
    const embedded: EmbeddedAssetSource = {
      serveIndexHtml: async () =>
        new Response("<!doctype html>EMBEDDED SPA", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/sessions/whatever`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("EMBEDDED SPA");
  });

  test("embedded mode does not fall through `/ui/v1/*` to the SPA HTML", async () => {
    const embedded: EmbeddedAssetSource = {
      serveIndexHtml: async () =>
        new Response("<!doctype html>EMBEDDED", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/ui/v1/this-path-does-not-exist`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("not-found");
  });

  test("embedded mode skips the filesystem asset root entirely", async () => {
    const assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "index.html"), "<!doctype html>FILESYSTEM");
    const embedded: EmbeddedAssetSource = {
      serveIndexHtml: async () =>
        new Response("<!doctype html>EMBEDDED-WINS", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot, embedded },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/`);
    expect(await r.text()).toContain("EMBEDDED-WINS");
  });

  test("explicitly disabled embedded mode keeps the missing-build fallback for source checkout", async () => {
    const assetRoot = join(tmpHome, "absent-dist");
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot, embedded: null },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/`);
    expect(r.status).toBe(503);
    expect((await r.text()).toLowerCase()).toContain("bun run build:web");
  });

  test("embedded bundle route rejected by Bun.serve degrades to the SPA index without failing daemon startup", async () => {
    const embedded: EmbeddedAssetSource = {
      // A non-HTMLBundle value makes Bun.serve throw when building the `routes`
      // map — the compiled-binary failure mode the listener fallback guards.
      bundle: "not-an-html-bundle",
      serveIndexHtml: async () =>
        new Response("<!doctype html>EMBEDDED-DEGRADED", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded },
      }),
    );
    // The control plane still binds despite the rejected bundle route.
    const health = await fetch(`${daemon.webUrl}/ui/v1/health`);
    expect(health.status).toBe(200);
    // The SPA index is still served via the embedded fetch handler.
    const root = await fetch(`${daemon.webUrl}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("EMBEDDED-DEGRADED");
  });

  test("default web listener binds to loopback when public web is disabled", async () => {
    await startWithAssets();
    expect(daemon.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("web listener stays loopback even when tunnel Web UI is enabled", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicEnabledConfig(),
      }),
    );
    // Public exposure now lives on the tunnel listener; the management Web UI
    // listener is always bound to loopback HTTP.
    expect(daemon.webBindHostname).toBe("127.0.0.1");
    expect(daemon.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("explicit host override is respected when tunnel Web UI is enabled", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, host: "127.0.0.1" },
        globalConfig: publicEnabledConfig(),
      }),
    );
    expect(daemon.webBindHostname).toBe("127.0.0.1");
    expect(daemon.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("legacy /v1/* routes are not exposed on the web listener", async () => {
    await startWithAssets();
    const r = await fetch(`${daemon.webUrl}/v1/health`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("not-found");
  });

  test("port already in use → daemon binds the next free port and records it", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      daemon = await startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { port: blocker.port },
          // Skip the restart EADDRINUSE retry window so the free-port fallback
          // is exercised immediately.
          bindRetryMs: 0,
        }),
      );
      const boundPort = Number(new URL(daemon.webUrl).port);
      expect(boundPort).not.toBe(blocker.port);
      const meta = JSON.parse(await readFile(metadataPath, "utf8")) as DaemonMetadata;
      expect(meta.webPort).toBe(boundPort);
      const res = await fetch(`${daemon.webUrl}/ui/v1/health`);
      expect(res.status).toBe(200);
    } finally {
      blocker.stop(true);
    }
  });
});

describe("daemon web listener HTTPS", () => {
  async function generateTestTlsMaterial(): Promise<{ cert: string; key: string }> {
    const { generateSelfSignedPemForTests } = await import(
      "./helpers/tls-test-material.ts"
    );
    return generateSelfSignedPemForTests();
  }

  function httpsEnabledConfig(certPath: string, keyPath: string): GlobalConfig {
    return {
      web: {
        port: 0,
        ssl: { enabled: true, source: "files", cert: certPath, key: keyPath },
      },
      tunnel: {
        enabled: false,
        port: 5858,
        ssl: { enabled: false },
        webUi: { enabled: false },
        serviceTunnels: { enabled: false, whitelistIps: [] },
      },
      healthcheck: {},
      terminalBackend: "default",
    };
  }

  test("web.ssl.enabled with configured cert files serves HTTPS and reports https:// metadata", async () => {
    const { cert, key } = await generateTestTlsMaterial();
    const certPath = join(tmpHome, "web.crt");
    const keyPath = join(tmpHome, "web.key");
    await writeFile(certPath, cert);
    await writeFile(keyPath, key);

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: httpsEnabledConfig(certPath, keyPath),
      }),
    );

    expect(daemon.webScheme).toBe("https");
    expect(daemon.webUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const meta = JSON.parse(await readFile(metadataPath, "utf8")) as DaemonMetadata;
    expect(meta.webUrl).toBe(daemon.webUrl);
    expect(meta.webScheme).toBe("https");
  });

  test("web.ssl certificate resolution failure fails daemon startup", async () => {
    await expect(
      startDaemon(
        withDaemonDefaults(tmpHome, {
          resolveSession: async () => ({}) as any,
          web: { port: 0 },
          globalConfig: httpsEnabledConfig("/missing/cert.pem", "/missing/key.pem"),
        }),
      ),
    ).rejects.toThrow(/SSL/i);
  });
});

describe("daemon web listener: terminal-layer WebSocket attach", () => {
  async function startWithFakeRuntime() {
    const { createFakeTerminalRuntime } = await import(
      "@worktreeos/daemon/terminal-layer/testing"
    );
    const r = createFakeTerminalRuntime();
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        terminalRuntime: r.runtime,
      }),
    );
    return r;
  }

  test("hello → hello-ack, input forwarded, exit delivered", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const r = await startWithFakeRuntime();
    const create = await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath: wt }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { session: { id: string } };
    const id = created.session.id;
    const fake = r.spawned[0]!;

    const wsUrl =
      daemon.webUrl!.replace(/^http/, "ws") +
      `/ui/v1/terminal-layer/sessions/${id}/attach`;
    const messages: any[] = [];
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 2000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      ws.addEventListener("error", reject);
    });
    ws.addEventListener("message", (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)));
      } catch {
        /* ignore */
      }
    });

    ws.send(
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "test",
        cols: 80,
        rows: 24,
        desiredControl: "controller",
      }),
    );
    // Wait for hello-ack to arrive — actor.attach is async (microtask queue
    // plus WS frame round-trip).
    for (let i = 0; i < 20 && !messages.some((m) => m.type === "hello-ack"); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(messages.some((m) => m.type === "hello-ack")).toBe(true);

    fake.emit("hello\n");
    ws.send(JSON.stringify({ type: "input", v: 1, data: "ls\n" }));
    ws.send(JSON.stringify({ type: "resize", v: 1, cols: 100, rows: 30 }));
    for (let i = 0; i < 20 && fake.writes.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const writesAsText = fake.writes.map((b) => new TextDecoder().decode(b));
    expect(writesAsText).toEqual(["ls\n"]);
    expect(fake.resizes).toEqual([{ cols: 100, rows: 30 }]);
    for (let i = 0; i < 20 && !messages.some((m) => m.type === "output"); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      messages.some((m) => m.type === "output" && m.data === "hello\n"),
    ).toBe(true);

    fake.exit({ exitCode: 0 });
    await new Promise<void>((res) => {
      if (ws.readyState === WebSocket.CLOSED) return res();
      ws.addEventListener("close", () => res());
      setTimeout(() => res(), 1500);
    });
    expect(messages.some((m) => m.type === "exit")).toBe(true);
  });

  test("WebSocket close detaches but does not kill the terminal", async () => {
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    const r = await startWithFakeRuntime();
    const create = (await (
      await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath: wt }),
      })
    ).json()) as { session: { id: string } };
    const id = create.session.id;
    const fake = r.spawned[0]!;
    const wsUrl =
      daemon.webUrl!.replace(/^http/, "ws") +
      `/ui/v1/terminal-layer/sessions/${id}/attach`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolveOpen) => {
      ws.addEventListener("open", () => resolveOpen());
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "test",
        cols: 80,
        rows: 24,
        desiredControl: "controller",
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise<void>((res) => {
      if (ws.readyState === WebSocket.CLOSED) return res();
      ws.addEventListener("close", () => res());
      setTimeout(() => res(), 300);
    });
    expect(fake.kills).toEqual([]);
    const meta = await fetch(
      `${daemon.webUrl}/ui/v1/terminal-layer/sessions/${id}`,
    );
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { session: { status: string } };
    expect(body.session.status).toBe("running");
  });

  test("attach for unknown terminal closes the WebSocket with not-found", async () => {
    await startWithFakeRuntime();
    const res = await fetch(
      `${daemon.webUrl}/ui/v1/terminal-layer/sessions/missing/attach`,
    );
    expect(res.status).toBe(404);
  });

  test("control transfer between two attachments updates ownership for both", async () => {
    // Bumped timeout: this test owns 2 live WebSockets and the shutdown hook
    // needs longer than Bun's default 5s when both sockets are torn down.
    const wt = join(tmpHome, "wt");
    await mkdir(wt, { recursive: true });
    await startWithFakeRuntime();
    const create = (await (
      await fetch(`${daemon.webUrl}/ui/v1/terminal-layer/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath: wt }),
      })
    ).json()) as { session: { id: string } };
    const id = create.session.id;
    const wsUrl =
      daemon.webUrl!.replace(/^http/, "ws") +
      `/ui/v1/terminal-layer/sessions/${id}/attach`;

    async function openAndHello(desiredControl: "controller" | "viewer") {
      const ws = new WebSocket(wsUrl);
      const frames: any[] = [];
      await new Promise<void>((res) => ws.addEventListener("open", () => res()));
      ws.addEventListener("message", (ev) => {
        try {
          frames.push(JSON.parse(String(ev.data)));
        } catch {
          /* ignore */
        }
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          v: 1,
          clientId: desiredControl,
          cols: 80,
          rows: 24,
          desiredControl,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      return { ws, frames };
    }

    const a = await openAndHello("controller");
    const b = await openAndHello("viewer");
    // Initial state: a is controller, b is viewer.
    const ackB = b.frames.find((f) => f.type === "hello-ack");
    expect(ackB.control.controllerAttachmentId).not.toBe(ackB.attachmentId);

    // b requests control → should become controller.
    b.ws.send(
      JSON.stringify({ type: "control", v: 1, action: "request" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const ctrlB = b.frames.filter((f) => f.type === "control").pop();
    const ctrlA = a.frames.filter((f) => f.type === "control").pop();
    expect(ctrlB?.isController).toBe(true);
    expect(ctrlA?.isController).toBe(false);

    await Promise.all([
      new Promise<void>((res) => {
        a.ws.addEventListener("close", () => res());
        a.ws.close();
        setTimeout(() => res(), 1000);
      }),
      new Promise<void>((res) => {
        b.ws.addEventListener("close", () => res());
        b.ws.close();
        setTimeout(() => res(), 1000);
      }),
    ]);
    // Give the daemon's detach handlers a moment to settle so the afterEach
    // shutdown doesn't have lingering WebSocket state to drain.
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);
});
