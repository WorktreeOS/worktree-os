import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import {
  AUTH_COOKIE_NAME,
  buildSetCookieHeader,
  isLoopbackAddress,
  isPublicTunnelRequest,
  signAuthCookie,
  verifyAuthCookie,
} from "@worktreeos/daemon/public-auth";
import type { GlobalConfig } from "@worktreeos/core/global-config";

describe("signAuthCookie / verifyAuthCookie", () => {
  test("verifies a freshly signed cookie", () => {
    const now = 1_700_000_000_000;
    const token = signAuthCookie("topsecret", now);
    expect(verifyAuthCookie("topsecret", token, { nowMs: now })).toBe(true);
  });

  test("rejects an empty secret or empty token", () => {
    const now = 1_700_000_000_000;
    const token = signAuthCookie("topsecret", now);
    expect(verifyAuthCookie("", token, { nowMs: now })).toBe(false);
    expect(verifyAuthCookie("topsecret", "", { nowMs: now })).toBe(false);
    expect(verifyAuthCookie("topsecret", undefined, { nowMs: now })).toBe(false);
  });

  test("rejects tampered signature", () => {
    const now = 1_700_000_000_000;
    const token = signAuthCookie("topsecret", now);
    const lastDot = token.lastIndexOf(".");
    const tampered =
      token.slice(0, lastDot + 1) +
      token
        .slice(lastDot + 1)
        .split("")
        .reverse()
        .join("");
    expect(verifyAuthCookie("topsecret", tampered, { nowMs: now })).toBe(false);
  });

  test("rejects malformed token", () => {
    expect(verifyAuthCookie("topsecret", "not-a-token", { nowMs: 1 })).toBe(false);
    expect(verifyAuthCookie("topsecret", "v1.notnumber.aa", { nowMs: 1 })).toBe(
      false,
    );
  });

  test("rejects after maxAgeMs elapses", () => {
    const now = 1_700_000_000_000;
    const token = signAuthCookie("topsecret", now);
    expect(
      verifyAuthCookie("topsecret", token, {
        nowMs: now + 1000,
        maxAgeMs: 500,
      }),
    ).toBe(false);
    expect(
      verifyAuthCookie("topsecret", token, {
        nowMs: now + 100,
        maxAgeMs: 500,
      }),
    ).toBe(true);
  });

  test("secret rotation invalidates previously signed cookie", () => {
    const now = 1_700_000_000_000;
    const token = signAuthCookie("oldsecret", now);
    expect(verifyAuthCookie("newsecret", token, { nowMs: now })).toBe(false);
  });
});

describe("isLoopbackAddress", () => {
  test("returns false for unknown/empty addresses (caller decides defaults)", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress("  ")).toBe(false);
  });

  test("recognizes IPv4 and IPv6 loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects non-loopback addresses", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("203.0.113.5")).toBe(false);
    expect(isLoopbackAddress("2001:db8::1")).toBe(false);
  });
});

describe("isPublicTunnelRequest", () => {
  test("returns false when tunnel Web UI is disabled", () => {
    const req = new Request("http://wos.example.com/ui/v1/health", {
      headers: { host: "wos.example.com" },
    });
    expect(isPublicTunnelRequest(req, false, "wos.example.com")).toBe(false);
  });

  test("returns true when Host header matches the configured public hostname", () => {
    const req = new Request("http://wos.example.com/ui/v1/health", {
      headers: { host: "wos.example.com" },
    });
    expect(isPublicTunnelRequest(req, true, "wos.example.com")).toBe(true);
  });

  test("returns true when X-Forwarded-Host matches even if Host does not", () => {
    const req = new Request("http://127.0.0.1/ui/v1/health", {
      headers: {
        host: "127.0.0.1:4949",
        "x-forwarded-host": "wos.example.com",
      },
    });
    expect(isPublicTunnelRequest(req, true, "wos.example.com")).toBe(true);
  });

  test("returns false when hostname does not match — direct main-port public access is no longer supported", () => {
    const req = new Request("http://127.0.0.1/ui/v1/health", {
      headers: { host: "127.0.0.1:4949" },
    });
    expect(isPublicTunnelRequest(req, true, "wos.example.com")).toBe(false);
  });

  test("returns false when public hostname is undefined", () => {
    const req = new Request("http://wos.example.com/ui/v1/health", {
      headers: { host: "wos.example.com" },
    });
    expect(isPublicTunnelRequest(req, true, undefined)).toBe(false);
  });
});

describe("buildSetCookieHeader", () => {
  test("emits HttpOnly SameSite=Lax with custom max-age", () => {
    const header = buildSetCookieHeader("abc", { maxAgeSeconds: 60 });
    expect(header).toContain(`${AUTH_COOKIE_NAME}=abc`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=60");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Secure");
  });

  test("includes Secure when requested", () => {
    expect(buildSetCookieHeader("abc", { secure: true })).toContain("Secure");
  });
});

describe("daemon UI API auth endpoints", () => {
  let tmpHome: string;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-public-auth-");
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  function publicConfig(): GlobalConfig {
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

  test("login succeeds with correct secret and sets HttpOnly cookie", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "letmein" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie.toLowerCase()).not.toContain("secure");
  });

  test("login over HTTP tunnel keeps non-secure cookie", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    // Simulate an HTTP tunnel reaching the daemon: tunnel listener was HTTP.
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "wos.example.com",
      },
      body: JSON.stringify({ secret: "letmein" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).not.toContain("secure");
  });

  test("login through HTTPS tunnel sets Secure cookie", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    // Simulate an HTTPS tunnel reaching the daemon: tunnel listener was HTTPS.
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "wos.example.com",
      },
      body: JSON.stringify({ secret: "letmein" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=`);
    expect(setCookie).toContain("Secure");
  });

  test("login with bad secret returns 401 and does not set cookie", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "nope" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("login when public web disabled returns 401 without disclosing", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "anything" }),
    });
    expect(res.status).toBe(401);
  });

  test("session reports authenticated state for a valid cookie", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const login = await fetch(`${daemon.webUrl}/ui/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "letmein" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookieValue = setCookie.split(";")[0]!;
    const session = await fetch(`${daemon.webUrl}/ui/v1/auth/session`, {
      headers: { cookie: cookieValue },
    });
    expect(session.status).toBe(200);
    const body = (await session.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });

  test("logout returns a clear-cookie header", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0 },
        globalConfig: publicConfig(),
      }),
    );
    const res = await fetch(`${daemon.webUrl}/ui/v1/auth/logout`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
  });
});
