import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_TERMINAL_BACKEND,
  DEFAULT_TUNNEL_PORT,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  defaultGlobalConfig,
  effectiveHealthcheckDefaults,
  globalConfigPath,
  loadGlobalConfig,
} from "@worktreeos/core/global-config";
import {
  DEFAULT_HEALTHCHECK_INTERVAL_MS,
  DEFAULT_HEALTHCHECK_REQUEST_TIMEOUT_MS,
  DEFAULT_HEALTHCHECK_RETRIES,
  DEFAULT_HEALTHCHECK_START_PERIOD_MS,
  DEFAULT_HEALTHCHECK_TIMEOUT_MS,
} from "@worktreeos/core/config";

let tmpHome: string;
let warnings: string[];
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;
const warn = (s: string) => {
  warnings.push(s);
};

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-globalcfg-"));
  warnings = [];
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("loadGlobalConfig", () => {
  test("returns defaults when file is absent", async () => {
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg).toEqual(defaultGlobalConfig());
    expect(cfg.web.port).toBe(DEFAULT_WEB_PORT);
    expect(warnings).toEqual([]);
  });

  test("parses valid config and merges over defaults", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 5000 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(5000);
    expect(warnings).toEqual([]);
  });

  test("preserves defaults for omitted keys", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(DEFAULT_WEB_PORT);
    expect(warnings).toEqual([]);
  });

  test("warns and falls back to defaults on invalid JSON", async () => {
    await writeFile(globalConfigPath(env()), "{not-json");
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg).toEqual(defaultGlobalConfig());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(globalConfigPath(env()));
    expect(warnings[0]).toContain("invalid JSON");
  });

  test("warns and falls back when web.port is the wrong type", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: "4949" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(DEFAULT_WEB_PORT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web.port");
    expect(warnings[0]).toContain('"4949"');
  });

  test("warns and falls back when web.port is out of range (too low)", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 0 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(DEFAULT_WEB_PORT);
    expect(warnings).toHaveLength(1);
  });

  test("warns and falls back when web.port is out of range (too high)", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 70000 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(DEFAULT_WEB_PORT);
    expect(warnings).toHaveLength(1);
  });

  test("warns when web.port is a non-integer number", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 4949.5 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.port).toBe(DEFAULT_WEB_PORT);
    expect(warnings).toHaveLength(1);
  });

  test("accepts boundary values 1 and 65535", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({ web: { port: 1 } }));
    const low = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(low.web.port).toBe(1);
    expect(warnings).toEqual([]);

    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 65535 } }),
    );
    const high = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(high.web.port).toBe(65535);
    expect(warnings).toEqual([]);
  });

  test("ignores non-object top-level values", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify([1, 2, 3]));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg).toEqual(defaultGlobalConfig());
  });
});

describe("loadGlobalConfig web.host", () => {
  test("defaults to 127.0.0.1 when omitted", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({ web: { port: 5000 } }));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.host).toBe(DEFAULT_WEB_HOST);
    expect(warnings).toEqual([]);
  });

  test("accepts a configured address", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { host: "192.168.1.18" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.host).toBe("192.168.1.18");
    expect(warnings).toEqual([]);
  });

  test("warns and falls back when web.host is the wrong type", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { host: 123 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.host).toBe(DEFAULT_WEB_HOST);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web.host");
    expect(warnings[0]).toContain(globalConfigPath(env()));
  });

  test("warns and falls back when web.host is an empty string", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { host: "   " } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.host).toBe(DEFAULT_WEB_HOST);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web.host");
  });
});

describe("loadGlobalConfig serviceBind", () => {
  test("is unset when omitted", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.serviceBind).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("accepts a configured address", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ serviceBind: "192.168.1.18" }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.serviceBind).toBe("192.168.1.18");
    expect(warnings).toEqual([]);
  });

  test("warns and falls back to unset when the wrong type", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ serviceBind: 123 }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.serviceBind).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("serviceBind");
    expect(warnings[0]).toContain(globalConfigPath(env()));
  });

  test("warns and falls back to unset on empty string", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ serviceBind: "" }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.serviceBind).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("serviceBind");
  });
});

describe("loadGlobalConfig tunnel", () => {
  test("tunnel omitted defaults to disabled and port 5858", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.enabled).toBe(false);
    expect(cfg.tunnel.port).toBe(DEFAULT_TUNNEL_PORT);
    expect(cfg.tunnel.port).toBe(5858);
    expect(warnings).toEqual([]);
  });

  test("tunnel explicitly disabled does not require domain", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: false } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.enabled).toBe(false);
    expect(cfg.tunnel.port).toBe(DEFAULT_TUNNEL_PORT);
    expect(warnings).toEqual([]);
  });

  test("tunnel enabled with valid domain", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: true, domain: "example.com" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.enabled).toBe(true);
    if (cfg.tunnel.enabled) {
      expect(cfg.tunnel.domain).toBe("example.com");
      expect(cfg.tunnel.port).toBe(DEFAULT_TUNNEL_PORT);
    }
    expect(warnings).toEqual([]);
  });

  test("tunnel enabled without domain falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: true } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tunnel.domain");
  });

  test("tunnel enabled with invalid domain falls back to disabled", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: true, domain: "" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tunnel.domain");
  });

  test("tunnel uses configured valid port", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: true, domain: "example.com", port: 8080 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.port).toBe(8080);
    expect(warnings).toEqual([]);
  });

  test("invalid tunnel.port falls back to 5858 with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: true, domain: "example.com", port: 70000 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.port).toBe(DEFAULT_TUNNEL_PORT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tunnel.port");
  });

  test("tunnel.publicPort omitted leaves publicPort undefined", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: true, domain: "example.com" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.publicPort).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("tunnel.publicPort accepts a valid integer", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: { enabled: true, domain: "example.com", port: 5858, publicPort: 443 },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.port).toBe(5858);
    expect(cfg.tunnel.publicPort).toBe(443);
    expect(warnings).toEqual([]);
  });

  test("invalid tunnel.publicPort falls back to undefined with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: { enabled: true, domain: "example.com", publicPort: 70000 },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.publicPort).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tunnel.publicPort");
  });

  test("non-boolean tunnel.enabled falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { enabled: "yes", domain: "example.com" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tunnel.enabled");
  });
});

describe("loadGlobalConfig healthcheck overrides", () => {
  test("missing healthcheck section yields hardcoded defaults", async () => {
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.healthcheck).toEqual({});
    expect(effectiveHealthcheckDefaults(cfg)).toEqual({
      timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
      startPeriodMs: DEFAULT_HEALTHCHECK_START_PERIOD_MS,
      intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
      retries: DEFAULT_HEALTHCHECK_RETRIES,
      requestTimeoutMs: DEFAULT_HEALTHCHECK_REQUEST_TIMEOUT_MS,
    });
    expect(warnings).toEqual([]);
  });

  test("string durations are accepted and overrides merge over defaults", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        healthcheck: {
          timeout: "5m",
          start_period: "30s",
          interval: 2500,
          retries: 50,
          request_timeout: "20s",
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.healthcheck).toEqual({
      timeoutMs: 5 * 60 * 1000,
      startPeriodMs: 30_000,
      intervalMs: 2500,
      retries: 50,
      requestTimeoutMs: 20_000,
    });
    expect(effectiveHealthcheckDefaults(cfg)).toEqual({
      timeoutMs: 5 * 60 * 1000,
      startPeriodMs: 30_000,
      intervalMs: 2500,
      retries: 50,
      requestTimeoutMs: 20_000,
    });
    expect(warnings).toEqual([]);
  });

  test("partial overrides only replace specified fields", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ healthcheck: { timeout: "2m" } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.healthcheck).toEqual({ timeoutMs: 120_000 });
    expect(effectiveHealthcheckDefaults(cfg)).toEqual({
      timeoutMs: 120_000,
      startPeriodMs: DEFAULT_HEALTHCHECK_START_PERIOD_MS,
      intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
      retries: DEFAULT_HEALTHCHECK_RETRIES,
      requestTimeoutMs: DEFAULT_HEALTHCHECK_REQUEST_TIMEOUT_MS,
    });
  });

  test("invalid duration is dropped with warning, others survive", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        healthcheck: { timeout: "oops", interval: "5s" },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.healthcheck).toEqual({ intervalMs: 5_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("healthcheck.timeout");
  });

  test("invalid retries is dropped with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ healthcheck: { retries: 0 } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.healthcheck.retries).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("healthcheck.retries");
  });

  test("non-object healthcheck value is ignored with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ healthcheck: "verbose" }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.healthcheck).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("healthcheck");
  });
});

describe("loadGlobalConfig tunnel.webUi", () => {
  test("omitted tunnel.webUi defaults to disabled", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("tunnel.webUi enabled with label subdomain resolves under tunnel.domain", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: { enabled: true, subdomain: "sample", secret: "shh" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(true);
    if (cfg.tunnel.webUi.enabled) {
      expect(cfg.tunnel.webUi.hostname).toBe("sample.example.com");
      expect(cfg.tunnel.webUi.secret).toBe("shh");
      expect(cfg.tunnel.webUi.terminalEnabled).toBe(false);
      expect(cfg.tunnel.webUi.whitelistIps).toEqual([]);
    }
    expect(warnings).toEqual([]);
  });

  test("tunnel.webUi enabled accepts full hostname under tunnel.domain", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: { enabled: true, subdomain: "sample.example.com", secret: "shh" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(true);
    if (cfg.tunnel.webUi.enabled) {
      expect(cfg.tunnel.webUi.hostname).toBe("sample.example.com");
    }
    expect(warnings).toEqual([]);
  });

  test("tunnel.webUi hostname outside tunnel.domain falls back to disabled", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: { enabled: true, subdomain: "sample.other.test", secret: "shh" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("tunnel.webUi.subdomain"))).toBe(true);
  });

  test("tunnel.webUi enabled without secret falls back to disabled", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: { enabled: true, subdomain: "sample" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("tunnel.webUi.secret"))).toBe(true);
  });

  test("tunnel.webUi enabled without tunnel.enabled falls back to disabled", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: { webUi: { enabled: true, subdomain: "sample", secret: "shh" } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(false);
  });

  test("tunnel.webUi terminalEnabled true is preserved", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: {
            enabled: true,
            subdomain: "sample",
            secret: "shh",
            terminalEnabled: true,
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(true);
    if (cfg.tunnel.webUi.enabled) {
      expect(cfg.tunnel.webUi.terminalEnabled).toBe(true);
    }
  });

  test("tunnel.webUi whitelistIps valid list is preserved", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: {
            enabled: true,
            subdomain: "sample",
            secret: "shh",
            whitelistIps: ["10.0.0.1", "192.168.1.5"],
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(true);
    if (cfg.tunnel.webUi.enabled) {
      expect(cfg.tunnel.webUi.whitelistIps).toEqual(["10.0.0.1", "192.168.1.5"]);
    }
  });

  test("tunnel.webUi whitelistIps invalid falls back to disabled", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: {
            enabled: true,
            subdomain: "sample",
            secret: "shh",
            whitelistIps: ["not-an-ip"],
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("tunnel.webUi.whitelistIps"))).toBe(true);
  });
});

describe("loadGlobalConfig tunnel.serviceTunnels", () => {
  test("omitted tunnel.serviceTunnels defaults to disabled", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.serviceTunnels.enabled).toBe(false);
    expect(cfg.tunnel.serviceTunnels.whitelistIps).toEqual([]);
  });

  test("tunnel.serviceTunnels enabled is preserved", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          serviceTunnels: { enabled: true },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.serviceTunnels.enabled).toBe(true);
    expect(cfg.tunnel.serviceTunnels.whitelistIps).toEqual([]);
  });

  test("tunnel.serviceTunnels.whitelistIps valid list is preserved", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          serviceTunnels: { enabled: true, whitelistIps: ["10.0.0.1"] },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.serviceTunnels.enabled).toBe(true);
    expect(cfg.tunnel.serviceTunnels.whitelistIps).toEqual(["10.0.0.1"]);
  });

  test("tunnel.serviceTunnels.whitelistIps invalid disables publication", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          serviceTunnels: { enabled: true, whitelistIps: "10.0.0.1" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.serviceTunnels.enabled).toBe(false);
    expect(cfg.tunnel.serviceTunnels.whitelistIps).toEqual([]);
    expect(warnings.some((w) => w.includes("tunnel.serviceTunnels.whitelistIps"))).toBe(true);
  });
});

describe("loadGlobalConfig web.public removed", () => {
  test("web.public input is ignored without raising errors", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: {
          public: {
            enabled: true,
            hostname: "wos.example.com",
            secret: "shh",
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.webUi.enabled).toBe(false);
    // Loader ignores unknown sections silently — saveGlobalConfig is the
    // surface that rejects web.public for new submissions.
  });
});

describe("loadGlobalConfig web.ssl", () => {
  test("omitted web.ssl defaults to disabled", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("web.ssl.enabled=false yields disabled SSL without requiring paths", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: false } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("web.ssl.enabled=true without paths means generated self-signed", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: true } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(true);
    if (cfg.web.ssl.enabled) {
      expect(cfg.web.ssl.source).toBe("self-signed");
    }
    expect(warnings).toEqual([]);
  });

  test("web.ssl.enabled=true with cert+key uses path-based mode", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: { ssl: { enabled: true, cert: "/etc/ssl/web.crt", key: "/etc/ssl/web.key" } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(true);
    if (cfg.web.ssl.enabled && cfg.web.ssl.source === "files") {
      expect(cfg.web.ssl.cert).toBe("/etc/ssl/web.crt");
      expect(cfg.web.ssl.key).toBe("/etc/ssl/web.key");
    } else {
      throw new Error("expected files source");
    }
    expect(warnings).toEqual([]);
  });

  test("web.ssl.enabled=true with only cert falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: true, cert: "/etc/ssl/web.crt" } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web.ssl.key");
  });

  test("web.ssl with invalid type falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: "yes" } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web.ssl.enabled");
  });
});

describe("loadGlobalConfig tunnel.ssl", () => {
  test("omitted tunnel.ssl defaults to disabled", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("tunnel.ssl.enabled=false yields disabled SSL", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ tunnel: { ssl: { enabled: false } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("tunnel.ssl.enabled=true without paths means generated self-signed", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: { enabled: true, domain: "example.com", ssl: { enabled: true } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(true);
    if (cfg.tunnel.ssl.enabled) {
      expect(cfg.tunnel.ssl.source).toBe("self-signed");
    }
    expect(warnings).toEqual([]);
  });

  test("tunnel.ssl.enabled=true with cert+key uses path-based mode", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: { enabled: true, cert: "/etc/ssl/t.crt", key: "/etc/ssl/t.key" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(true);
    if (cfg.tunnel.ssl.enabled && cfg.tunnel.ssl.source === "files") {
      expect(cfg.tunnel.ssl.cert).toBe("/etc/ssl/t.crt");
      expect(cfg.tunnel.ssl.key).toBe("/etc/ssl/t.key");
    } else {
      throw new Error("expected files source");
    }
    expect(warnings).toEqual([]);
  });

  test("tunnel.ssl.enabled=true with only key falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: { enabled: true, key: "/etc/ssl/t.key" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tunnel.ssl.cert");
  });

  test("tunnel.ssl with invalid cert type falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: { enabled: true, cert: 123, key: "/etc/ssl/t.key" },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.includes("tunnel.ssl.cert"))).toBe(true);
  });
});

describe("loadGlobalConfig terminalBackend", () => {
  test("omitted terminalBackend defaults to \"default\"", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({}));
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.terminalBackend).toBe(DEFAULT_TERMINAL_BACKEND);
    expect(cfg.terminalBackend).toBe("default");
    expect(warnings).toEqual([]);
  });

  test("terminalBackend=\"default\" is preserved", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ terminalBackend: "default" }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.terminalBackend).toBe("default");
    expect(warnings).toEqual([]);
  });

  test("terminalBackend=\"tmux\" is preserved", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ terminalBackend: "tmux" }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.terminalBackend).toBe("tmux");
    expect(warnings).toEqual([]);
  });

  test("invalid terminalBackend falls back to default with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ terminalBackend: "screen" }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.terminalBackend).toBe("default");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("terminalBackend");
  });
});

describe("loadGlobalConfig SSL source", () => {
  test("omitted source with cert+key resolves to files", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: { ssl: { enabled: true, cert: "/c.pem", key: "/k.pem" } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(true);
    if (cfg.web.ssl.enabled) expect(cfg.web.ssl.source).toBe("files");
    expect(warnings).toEqual([]);
  });

  test("omitted source without cert+key resolves to self-signed", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: true } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(true);
    if (cfg.web.ssl.enabled) expect(cfg.web.ssl.source).toBe("self-signed");
    expect(warnings).toEqual([]);
  });

  test("explicit source=files honors cert+key", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: { ssl: { enabled: true, source: "files", cert: "/c.pem", key: "/k.pem" } },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(true);
    if (cfg.web.ssl.enabled && cfg.web.ssl.source === "files") {
      expect(cfg.web.ssl.cert).toBe("/c.pem");
    }
  });

  test("invalid source falls back to disabled with warning", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: true, source: "wat" } } }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("web.ssl.source"))).toBe(true);
  });
});

describe("loadGlobalConfig Let's Encrypt", () => {
  const validHook = {
    type: "dns-01" as const,
    provider: "hook" as const,
    createCommand: "/bin/true",
    deleteCommand: "/bin/true",
  };

  test("web.ssl letsencrypt requires public hostname", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: {
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: validHook,
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("public Web UI hostname"))).toBe(true);
  });

  test("web.ssl letsencrypt is valid with tunnel.webUi hostname", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          webUi: { enabled: true, subdomain: "wos", secret: "shh" },
        },
        web: {
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              directory: "production",
              challenge: { ...validHook, propagationSeconds: 30 },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.web.ssl.enabled).toBe(true);
    if (cfg.web.ssl.enabled && cfg.web.ssl.source === "letsencrypt") {
      expect(cfg.web.ssl.letsencrypt.email).toBe("me@example.com");
      expect(cfg.web.ssl.letsencrypt.directory).toBe("production");
      expect(cfg.web.ssl.letsencrypt.challenge.propagationSeconds).toBe(30);
    } else {
      throw new Error("expected letsencrypt source");
    }
    expect(warnings).toEqual([]);
  });

  test("tunnel.ssl letsencrypt requires enabled tunnel + public domain", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: false,
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: validHook,
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("public DNS domain"))).toBe(true);
  });

  test("tunnel.ssl letsencrypt is valid with enabled tunnel and public domain", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: validHook,
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(true);
    if (cfg.tunnel.ssl.enabled && cfg.tunnel.ssl.source === "letsencrypt") {
      expect(cfg.tunnel.ssl.letsencrypt.email).toBe("me@example.com");
      expect(cfg.tunnel.ssl.letsencrypt.directory).toBe("staging");
    }
  });

  test("letsencrypt rejects missing acceptTerms", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: false,
              challenge: validHook,
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("acceptTerms"))).toBe(true);
  });

  test("letsencrypt rejects missing email", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              acceptTerms: true,
              challenge: validHook,
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("email"))).toBe(true);
  });

  test("letsencrypt rejects missing challenge", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: { email: "me@example.com", acceptTerms: true },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("challenge"))).toBe(true);
  });

  test("letsencrypt rejects non-dns-01 challenge type", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: { ...validHook, type: "http-01" },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("challenge.type"))).toBe(true);
  });

  test("letsencrypt rejects missing hook commands", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "hook",
                deleteCommand: "/bin/true",
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("createCommand"))).toBe(true);
  });

  test("letsencrypt rejects negative propagationSeconds", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: { ...validHook, propagationSeconds: -5 },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("propagationSeconds"))).toBe(true);
  });

  test("letsencrypt rejects invalid directory", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              directory: "live",
              challenge: validHook,
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("directory"))).toBe(true);
  });
});

describe("loadGlobalConfig Let's Encrypt Cloudflare provider", () => {
  test("accepts cloudflare challenge with apiTokenEnv", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
                apiTokenEnv: "CF_API_TOKEN",
                propagationSeconds: 30,
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(true);
    if (cfg.tunnel.ssl.enabled && cfg.tunnel.ssl.source === "letsencrypt") {
      const ch = cfg.tunnel.ssl.letsencrypt.challenge;
      expect(ch.provider).toBe("cloudflare");
      if (ch.provider === "cloudflare") {
        expect(ch.apiTokenEnv).toBe("CF_API_TOKEN");
        expect(ch.apiToken).toBeUndefined();
        expect(ch.propagationSeconds).toBe(30);
      }
    } else {
      throw new Error("expected letsencrypt source");
    }
    expect(warnings).toEqual([]);
  });

  test("accepts cloudflare challenge with direct apiToken", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
                apiToken: "raw-token",
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(true);
    if (cfg.tunnel.ssl.enabled && cfg.tunnel.ssl.source === "letsencrypt") {
      const ch = cfg.tunnel.ssl.letsencrypt.challenge;
      if (ch.provider === "cloudflare") {
        expect(ch.apiToken).toBe("raw-token");
        expect(ch.apiTokenEnv).toBeUndefined();
      }
    }
  });

  test("cloudflare token env wins over direct token", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
                apiTokenEnv: "CF_API_TOKEN",
                apiToken: "raw-token",
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(true);
    if (cfg.tunnel.ssl.enabled && cfg.tunnel.ssl.source === "letsencrypt") {
      const ch = cfg.tunnel.ssl.letsencrypt.challenge;
      if (ch.provider === "cloudflare") {
        expect(ch.apiTokenEnv).toBe("CF_API_TOKEN");
        expect(ch.apiToken).toBeUndefined();
      }
    }
  });

  test("accepts cloudflare challenge with explicit zoneId", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
                apiTokenEnv: "CF_API_TOKEN",
                zoneId: "zone-abc",
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    if (cfg.tunnel.ssl.enabled && cfg.tunnel.ssl.source === "letsencrypt") {
      const ch = cfg.tunnel.ssl.letsencrypt.challenge;
      if (ch.provider === "cloudflare") {
        expect(ch.zoneId).toBe("zone-abc");
      }
    }
  });

  test("cloudflare rejects missing token source", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("apiTokenEnv"))).toBe(true);
  });

  test("cloudflare rejects invalid zoneId type", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "cloudflare",
                apiTokenEnv: "CF_API_TOKEN",
                zoneId: 42,
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("zoneId"))).toBe(true);
  });

  test("rejects unknown provider", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: {
                type: "dns-01",
                provider: "route53",
              },
            },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.tunnel.ssl.enabled).toBe(false);
    expect(warnings.some((w) => w.includes("provider"))).toBe(true);
  });
});

describe("globalConfigPath", () => {
  test("is <wos-home>/config.json", () => {
    expect(globalConfigPath({ WOS_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/x/config.json",
    );
  });
});
