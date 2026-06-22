import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import type { EmbeddedAssetSource } from "@worktreeos/daemon/daemon-web";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";

let tmpHome: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-daemon-pwa-");
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

const sampleManifest = JSON.stringify({
  name: "wos",
  short_name: "wos",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#FBFBFA",
  theme_color: "#FBFBFA",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

const sampleServiceWorker = `self.addEventListener("fetch", () => {});\n`;

describe("daemon web listener: PWA assets (filesystem mode)", () => {
  test("serves /manifest.webmanifest with manifest content type from dist", async () => {
    const assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "index.html"), "<!doctype html>");
    await writeFile(join(assetRoot, "manifest.webmanifest"), sampleManifest);

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
      }),
    );

    const r = await fetch(`${daemon.webUrl}/manifest.webmanifest`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const body = await r.text();
    expect(body).not.toContain("<!doctype");
    expect(JSON.parse(body).start_url).toBe("/");
  });

  test("serves /service-worker.js with JS content type from dist", async () => {
    const assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "index.html"), "<!doctype html>");
    await writeFile(
      join(assetRoot, "service-worker.js"),
      sampleServiceWorker,
    );

    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
      }),
    );

    const r = await fetch(`${daemon.webUrl}/service-worker.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/javascript");
    const body = await r.text();
    expect(body).toBe(sampleServiceWorker);
    expect(body).not.toContain("<!doctype");
  });
});

describe("daemon web listener: PWA assets (embedded mode)", () => {
  function makeEmbedded(): EmbeddedAssetSource {
    return {
      serveIndexHtml: async () =>
        new Response("<!doctype html>EMBEDDED-INDEX", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      serveAsset: async (pathname) => {
        if (pathname === "/manifest.webmanifest") {
          return new Response(sampleManifest, {
            status: 200,
            headers: {
              "content-type": "application/manifest+json; charset=utf-8",
            },
          });
        }
        if (pathname === "/service-worker.js") {
          return new Response(sampleServiceWorker, {
            status: 200,
            headers: {
              "content-type": "application/javascript; charset=utf-8",
            },
          });
        }
        return undefined;
      },
    };
  }

  test("serves embedded manifest without falling through to index.html", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded: makeEmbedded() },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/manifest.webmanifest`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const body = await r.text();
    expect(body).not.toContain("EMBEDDED-INDEX");
    expect(JSON.parse(body).short_name).toBe("wos");
  });

  test("serves embedded service worker without falling through to index.html", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded: makeEmbedded() },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/service-worker.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/javascript");
    const body = await r.text();
    expect(body).toBe(sampleServiceWorker);
    expect(body).not.toContain("EMBEDDED-INDEX");
  });

  test("falls back to SPA index for unknown routes in embedded mode", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, embedded: makeEmbedded() },
      }),
    );
    const r = await fetch(`${daemon.webUrl}/sessions/whatever`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("EMBEDDED-INDEX");
  });
});
