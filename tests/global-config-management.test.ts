import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildManagementSnapshot,
  defaultGlobalConfig,
  globalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  validateGlobalConfigSave,
} from "@worktreeos/core/global-config";

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-globalcfg-mgmt-"));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("buildManagementSnapshot", () => {
  test("reports absent file with effective defaults", async () => {
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.path).toBe(globalConfigPath(env()));
    expect(snap.exists).toBe(false);
    expect(snap.raw).toBeNull();
    expect(snap.effective.web.port).toBe(4949);
    expect(snap.effective.tunnel.webUi.enabled).toBe(false);
    expect(snap.effective.tunnel.serviceTunnels.enabled).toBe(false);
    expect(snap.effective.tunnel.enabled).toBe(false);
    expect(snap.effective.tunnel.port).toBe(5858);
  });

  test("returns raw supported settings and effective parsed config for existing file", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: { port: 5000 },
        tunnel: {
          enabled: true,
          port: 5858,
          domain: "example.com",
          ssl: { enabled: false },
          webUi: {
            enabled: true,
            subdomain: "wos",
            secret: "shh",
            terminalEnabled: false,
          },
          serviceTunnels: { enabled: true },
        },
        healthcheck: { timeout: "2m" },
        unknown_key: { ignored: true },
      }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.exists).toBe(true);
    expect(snap.raw).toEqual({
      web: { port: 5000 },
      tunnel: {
        enabled: true,
        port: 5858,
        domain: "example.com",
        ssl: { enabled: false },
        webUi: {
          enabled: true,
          subdomain: "wos",
          secret: "shh",
          terminalEnabled: false,
        },
        serviceTunnels: { enabled: true },
      },
      healthcheck: { timeout: "2m" },
    });
    expect(snap.effective.web.port).toBe(5000);
    expect(snap.effective.tunnel.webUi.enabled).toBe(true);
    if (snap.effective.tunnel.webUi.enabled) {
      expect(snap.effective.tunnel.webUi.hostname).toBe("wos.example.com");
    }
    expect(snap.effective.tunnel.serviceTunnels.enabled).toBe(true);
    expect(snap.effective.tunnel.enabled).toBe(true);
    if (snap.effective.tunnel.enabled) {
      expect(snap.effective.tunnel.domain).toBe("example.com");
    }
    expect(snap.effective.healthcheck.timeoutMs).toBe(120_000);
  });
});

describe("validateGlobalConfigSave", () => {
  test("valid disabled tunnel.webUi does not require subdomain/secret", () => {
    const result = validateGlobalConfigSave({
      tunnel: { webUi: { enabled: false } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persistable.tunnel?.webUi?.enabled).toBe(false);
    }
  });

  test("enabled tunnel.webUi requires subdomain and secret and an enabled tunnel", () => {
    const result = validateGlobalConfigSave({
      tunnel: { webUi: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain("tunnel.webUi.subdomain");
      expect(fields).toContain("tunnel.webUi.secret");
      expect(fields).toContain("tunnel.enabled");
    }
  });

  test("enabled tunnel.webUi rejects hostname outside tunnel.domain", () => {
    const result = validateGlobalConfigSave({
      tunnel: {
        enabled: true,
        domain: "example.com",
        webUi: {
          enabled: true,
          subdomain: "sample.other.test",
          secret: "shh",
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.field === "tunnel.webUi.subdomain"),
      ).toBe(true);
    }
  });

  test("enabled tunnel.webUi accepts label subdomain under tunnel.domain", () => {
    const result = validateGlobalConfigSave({
      tunnel: {
        enabled: true,
        domain: "example.com",
        webUi: { enabled: true, subdomain: "wos", secret: "shh" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("enabled tunnel.webUi rejects invalid whitelistIps", () => {
    const result = validateGlobalConfigSave({
      tunnel: {
        enabled: true,
        domain: "example.com",
        webUi: {
          enabled: true,
          subdomain: "wos",
          secret: "shh",
          whitelistIps: ["not-an-ip"],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.field === "tunnel.webUi.whitelistIps"),
      ).toBe(true);
    }
  });

  test("rejects web.public input with helpful error", () => {
    const result = validateGlobalConfigSave({
      web: { public: { enabled: true, hostname: "wos.example.com", secret: "shh" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "web.public")).toBe(true);
    }
  });

  test("enabled tunnel requires non-empty domain", () => {
    const r = validateGlobalConfigSave({ tunnel: { enabled: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.field).toBe("tunnel.domain");
    }
  });

  test("disabled tunnel saves without domain", () => {
    const r = validateGlobalConfigSave({ tunnel: { enabled: false } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.tunnel?.enabled).toBe(false);
  });

  test("tunnel.publicPort accepts a valid integer", () => {
    const r = validateGlobalConfigSave({
      tunnel: { enabled: false, publicPort: 443 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.tunnel?.publicPort).toBe(443);
  });

  test("tunnel.publicPort rejects out-of-range value", () => {
    const r = validateGlobalConfigSave({
      tunnel: { enabled: false, publicPort: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("tunnel.publicPort");
  });

  test("tunnel.publicPort rejects non-integer value", () => {
    const r = validateGlobalConfigSave({
      tunnel: { enabled: false, publicPort: "443" as unknown as number },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("tunnel.publicPort");
  });

  test("rejects out-of-range web.port", () => {
    const r = validateGlobalConfigSave({ web: { port: 70000 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("web.port");
  });

  test("rejects invalid healthcheck duration", () => {
    const r = validateGlobalConfigSave({ healthcheck: { timeout: "oops" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("healthcheck.timeout");
  });

  test("accepts valid healthcheck durations and retries", () => {
    const r = validateGlobalConfigSave({
      healthcheck: { timeout: "5m", interval: 2500, retries: 50 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.healthcheck).toEqual({
        timeout: "5m",
        interval: 2500,
        retries: 50,
      });
    }
  });

  test("rejects retries=0", () => {
    const r = validateGlobalConfigSave({ healthcheck: { retries: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("healthcheck.retries");
  });

  test("valid disabled web.ssl persists without paths", () => {
    const r = validateGlobalConfigSave({ web: { ssl: { enabled: false } } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.web?.ssl?.enabled).toBe(false);
    }
  });

  test("valid enabled web.ssl with paths persists both", () => {
    const r = validateGlobalConfigSave({
      web: { ssl: { enabled: true, cert: "/c.pem", key: "/k.pem" } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.web?.ssl).toEqual({
        enabled: true,
        cert: "/c.pem",
        key: "/k.pem",
      });
    }
  });

  test("valid enabled web.ssl without paths persists for generated mode", () => {
    const r = validateGlobalConfigSave({ web: { ssl: { enabled: true } } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.web?.ssl).toEqual({ enabled: true });
    }
  });

  test("enabled web.ssl with only cert is rejected", () => {
    const r = validateGlobalConfigSave({
      web: { ssl: { enabled: true, cert: "/c.pem" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "web.ssl.key")).toBe(true);
    }
  });

  test("rejects non-boolean tunnel.ssl.enabled", () => {
    const r = validateGlobalConfigSave({
      tunnel: { enabled: false, ssl: { enabled: "yes" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "tunnel.ssl.enabled")).toBe(true);
    }
  });

  test("rejects non-string tunnel.ssl.cert", () => {
    const r = validateGlobalConfigSave({
      tunnel: { enabled: false, ssl: { enabled: true, cert: 123, key: "/k.pem" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "tunnel.ssl.cert")).toBe(true);
    }
  });

  test("rejects invalid tunnel.serviceTunnels.whitelistIps", () => {
    const r = validateGlobalConfigSave({
      tunnel: {
        enabled: true,
        domain: "example.com",
        serviceTunnels: { enabled: true, whitelistIps: ["bogus"] },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) => e.field === "tunnel.serviceTunnels.whitelistIps"),
      ).toBe(true);
    }
  });
});

describe("saveGlobalConfig", () => {
  test("creates config file with formatted JSON when absent", async () => {
    const r = await saveGlobalConfig(
      {
        web: { port: 5050 },
        tunnel: { enabled: false },
      },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.exists).toBe(true);
      expect(r.snapshot.effective.web.port).toBe(5050);
    }
    const text = await readFile(globalConfigPath(env()), "utf8");
    // Formatted JSON => contains newlines and 2-space indent.
    expect(text).toContain("\n  \"web\":");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("invalid saves do not overwrite existing config", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 4949 } }),
    );
    const before = await readFile(globalConfigPath(env()), "utf8");
    const r = await saveGlobalConfig(
      { web: { port: 0 } },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(false);
    const after = await readFile(globalConfigPath(env()), "utf8");
    expect(after).toBe(before);
  });

  test("save then load round-trips supported settings", async () => {
    await saveGlobalConfig(
      {
        web: { port: 6000 },
        tunnel: {
          enabled: true,
          port: 5858,
          domain: "example.com",
          ssl: { enabled: false },
          webUi: {
            enabled: true,
            subdomain: "wos",
            secret: "sek",
            terminalEnabled: true,
          },
          serviceTunnels: { enabled: true },
        },
        healthcheck: { timeout: "3m", retries: 30 },
      },
      { env: env(), stderrWrite: () => {} },
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.effective.web.port).toBe(6000);
    expect(snap.effective.tunnel.webUi.enabled).toBe(true);
    if (snap.effective.tunnel.webUi.enabled) {
      expect(snap.effective.tunnel.webUi.hostname).toBe("wos.example.com");
      expect(snap.effective.tunnel.webUi.terminalEnabled).toBe(true);
    }
    expect(snap.effective.tunnel.enabled).toBe(true);
    if (snap.effective.tunnel.enabled) {
      expect(snap.effective.tunnel.domain).toBe("example.com");
    }
    expect(snap.effective.tunnel.serviceTunnels.enabled).toBe(true);
    expect(snap.effective.healthcheck.timeoutMs).toBe(180_000);
    expect(snap.effective.healthcheck.retries).toBe(30);
  });

  test("disabled tunnel.webUi persists without dependent fields", async () => {
    await saveGlobalConfig(
      { tunnel: { webUi: { enabled: false } } },
      { env: env(), stderrWrite: () => {} },
    );
    const text = await readFile(globalConfigPath(env()), "utf8");
    const obj = JSON.parse(text) as Record<string, unknown>;
    const webUi = (obj.tunnel as { webUi?: Record<string, unknown> } | undefined)
      ?.webUi;
    expect(webUi).toEqual({ enabled: false });
  });
});

describe("validateGlobalConfigSave terminalBackend", () => {
  test("accepts \"default\"", () => {
    const r = validateGlobalConfigSave({ terminalBackend: "default" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.terminalBackend).toBe("default");
  });

  test("accepts \"tmux\"", () => {
    const r = validateGlobalConfigSave({ terminalBackend: "tmux" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.terminalBackend).toBe("tmux");
  });

  test("rejects invalid terminalBackend value", () => {
    const r = validateGlobalConfigSave({ terminalBackend: "screen" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "terminalBackend")).toBe(true);
    }
  });

  test("omitted terminalBackend leaves persistable unset", () => {
    const r = validateGlobalConfigSave({ web: { port: 4949 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.terminalBackend).toBeUndefined();
  });
});

describe("buildManagementSnapshot terminalBackend", () => {
  test("absent file reports effective \"default\"", async () => {
    const snap = await buildManagementSnapshot({
      env: env(),
      stderrWrite: () => {},
    });
    expect(snap.effective.terminalBackend).toBe("default");
    expect(snap.raw).toBeNull();
  });

  test("raw and effective both reflect saved tmux value", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ terminalBackend: "tmux" }),
    );
    const snap = await buildManagementSnapshot({
      env: env(),
      stderrWrite: () => {},
    });
    expect(snap.effective.terminalBackend).toBe("tmux");
    expect(snap.raw?.terminalBackend).toBe("tmux");
  });
});

describe("editorCommand setting", () => {
  test("validate accepts a string command", () => {
    const r = validateGlobalConfigSave({
      editorCommand: 'code "$WOS_WORKTREE_PATH"',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.editorCommand).toBe('code "$WOS_WORKTREE_PATH"');
    }
  });

  test("validate rejects a non-string command", () => {
    const r = validateGlobalConfigSave({ editorCommand: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "editorCommand")).toBe(true);
    }
  });

  test("validate treats empty string as clear (unset)", () => {
    const r = validateGlobalConfigSave({ editorCommand: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.editorCommand).toBeUndefined();
  });

  test("save then load round-trips editorCommand", async () => {
    await saveGlobalConfig(
      { editorCommand: 'cursor "$WOS_WORKTREE_PATH"' },
      { env: env(), stderrWrite: () => {} },
    );
    const snap = await buildManagementSnapshot({
      env: env(),
      stderrWrite: () => {},
    });
    expect(snap.effective.editorCommand).toBe('cursor "$WOS_WORKTREE_PATH"');
    expect(snap.raw?.editorCommand).toBe('cursor "$WOS_WORKTREE_PATH"');
  });

  test("absent file reports no editor command", async () => {
    const snap = await buildManagementSnapshot({
      env: env(),
      stderrWrite: () => {},
    });
    expect(snap.effective.editorCommand).toBeUndefined();
  });
});

describe("validateGlobalConfigSave letsencrypt", () => {
  const validHook = {
    type: "dns-01" as const,
    provider: "hook" as const,
    createCommand: "/bin/true",
    deleteCommand: "/bin/true",
  };

  test("valid tunnel.ssl letsencrypt persists", () => {
    const r = validateGlobalConfigSave({
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
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.tunnel?.ssl?.source).toBe("letsencrypt");
      expect(r.persistable.tunnel?.ssl?.letsencrypt?.email).toBe("me@example.com");
    }
  });

  test("valid web.ssl letsencrypt persists with tunnel.webUi hostname", () => {
    const r = validateGlobalConfigSave({
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
            challenge: { ...validHook, propagationSeconds: 60 },
          },
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.web?.ssl?.letsencrypt?.directory).toBe("production");
      expect(r.persistable.web?.ssl?.letsencrypt?.challenge?.propagationSeconds).toBe(60);
    }
  });

  test("web.ssl letsencrypt without public hostname is rejected", () => {
    const r = validateGlobalConfigSave({
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
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "tunnel.webUi.subdomain")).toBe(true);
    }
  });

  test("tunnel.ssl letsencrypt without enabled tunnel is rejected", () => {
    const r = validateGlobalConfigSave({
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
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "tunnel.domain")).toBe(true);
    }
  });

  test("rejects letsencrypt without acceptTerms", () => {
    const r = validateGlobalConfigSave({
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
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "tunnel.ssl.letsencrypt.acceptTerms")).toBe(true);
    }
  });

  test("rejects letsencrypt with missing createCommand", () => {
    const r = validateGlobalConfigSave({
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
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some(
          (e) => e.field === "tunnel.ssl.letsencrypt.challenge.createCommand",
        ),
      ).toBe(true);
    }
  });

  test("rejects invalid SSL source value", () => {
    const r = validateGlobalConfigSave({
      web: { ssl: { enabled: true, source: "wat" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "web.ssl.source")).toBe(true);
    }
  });

  describe("cloudflare provider", () => {
    test("valid cloudflare challenge with apiTokenEnv persists", () => {
      const r = validateGlobalConfigSave({
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
                zoneId: "zone-abc",
              },
            },
          },
        },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const ch = r.persistable.tunnel?.ssl?.letsencrypt?.challenge as
          | { provider?: string; apiTokenEnv?: string; zoneId?: string }
          | undefined;
        expect(ch?.provider).toBe("cloudflare");
        expect(ch?.apiTokenEnv).toBe("CF_API_TOKEN");
        expect(ch?.zoneId).toBe("zone-abc");
      }
    });

    test("rejects cloudflare challenge without token source", () => {
      const r = validateGlobalConfigSave({
        tunnel: {
          enabled: true,
          domain: "example.com",
          ssl: {
            enabled: true,
            source: "letsencrypt",
            letsencrypt: {
              email: "me@example.com",
              acceptTerms: true,
              challenge: { type: "dns-01", provider: "cloudflare" },
            },
          },
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(
          r.errors.some(
            (e) =>
              e.field === "tunnel.ssl.letsencrypt.challenge.apiTokenEnv",
          ),
        ).toBe(true);
      }
    });

    test("rejects cloudflare challenge with empty zoneId", () => {
      const r = validateGlobalConfigSave({
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
                zoneId: "",
              },
            },
          },
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(
          r.errors.some(
            (e) => e.field === "tunnel.ssl.letsencrypt.challenge.zoneId",
          ),
        ).toBe(true);
      }
    });
  });
});

describe("buildManagementSnapshot effective SSL source", () => {
  test("reports disabled when SSL is off", async () => {
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.effectiveSsl.web.source).toBe("disabled");
    expect(snap.effectiveSsl.tunnel.source).toBe("disabled");
  });

  test("reports files when cert+key configured", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: { ssl: { enabled: true, cert: "/c.pem", key: "/k.pem" } },
      }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.effectiveSsl.web.source).toBe("files");
  });

  test("reports self-signed when enabled without paths", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { ssl: { enabled: true } } }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.effectiveSsl.web.source).toBe("self-signed");
  });
});

describe("saveGlobalConfig terminalBackend", () => {
  test("persists tmux backend and round-trips through snapshot", async () => {
    const r = await saveGlobalConfig(
      { terminalBackend: "tmux" },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.effective.terminalBackend).toBe("tmux");
    expect(r.snapshot.raw?.terminalBackend).toBe("tmux");
    const text = await readFile(globalConfigPath(env()), "utf8");
    expect(text).toContain("\"terminalBackend\": \"tmux\"");
  });

  test("invalid terminalBackend does not write the file", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 4949 } }),
    );
    const before = await readFile(globalConfigPath(env()), "utf8");
    const r = await saveGlobalConfig(
      { terminalBackend: "screen" },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(false);
    const after = await readFile(globalConfigPath(env()), "utf8");
    expect(after).toBe(before);
  });
});

describe("web.host and serviceBind settings management", () => {
  test("snapshot raw round-trips web.host and serviceBind", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 5000, host: "192.168.1.18" }, serviceBind: "10.0.0.5" }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.raw?.web?.host).toBe("192.168.1.18");
    expect(snap.raw?.serviceBind).toBe("10.0.0.5");
    expect(snap.effective.web.host).toBe("192.168.1.18");
    expect(snap.effective.serviceBind).toBe("10.0.0.5");
  });

  test("validate persists web.host and serviceBind", () => {
    const r = validateGlobalConfigSave({
      web: { host: "192.168.1.18" },
      serviceBind: "10.0.0.5",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persistable.web?.host).toBe("192.168.1.18");
      expect(r.persistable.serviceBind).toBe("10.0.0.5");
    }
  });

  test("empty web.host clears the override (falls back to default)", () => {
    const r = validateGlobalConfigSave({ web: { host: "" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.web?.host).toBeUndefined();
  });

  test("empty serviceBind clears the override", () => {
    const r = validateGlobalConfigSave({ serviceBind: "  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persistable.serviceBind).toBeUndefined();
  });

  test("rejects non-string web.host", () => {
    const r = validateGlobalConfigSave({ web: { host: 123 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("web.host");
  });

  test("rejects non-string serviceBind", () => {
    const r = validateGlobalConfigSave({ serviceBind: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("serviceBind");
  });

  test("saving unrelated keys preserves web.host and serviceBind on the round-trip", async () => {
    // Hand-set the file with both keys, then save a draft that re-includes
    // them (mirroring the UI, which hydrates from the snapshot and sends them
    // back) and confirm they survive.
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ web: { port: 4949, host: "192.168.1.18" }, serviceBind: "10.0.0.5" }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    const r = await saveGlobalConfig(
      {
        web: { port: 5050, host: snap.raw?.web?.host },
        serviceBind: snap.raw?.serviceBind,
        terminalBackend: "tmux",
      },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.effective.web.host).toBe("192.168.1.18");
      expect(r.snapshot.effective.serviceBind).toBe("10.0.0.5");
      expect(r.snapshot.effective.web.port).toBe(5050);
    }
  });
});

describe("aiProviders", () => {
  test("default config has an empty aiProviders list", () => {
    expect(defaultGlobalConfig().aiProviders).toEqual([]);
  });

  test("missing aiProviders resolves to an empty effective list", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({ web: { port: 4949 } }));
    const config = await loadGlobalConfig({ env: env(), stderrWrite: () => {} });
    expect(config.aiProviders).toEqual([]);
  });

  test("loads supported provider types with optional metadata in order", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        aiProviders: [
          {
            type: "openai",
            name: "Work",
            apiKey: "sk-1",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-4.1", "gpt-4.1-mini"],
          },
          { type: "anthropic", apiKey: "sk-2" },
          { type: "openrouter", apiKey: "sk-3" },
          { type: "openai-like", apiKey: "sk-4", baseUrl: "https://gw.local" },
          { type: "anthropic-like", apiKey: "sk-5" },
        ],
      }),
    );
    const config = await loadGlobalConfig({ env: env(), stderrWrite: () => {} });
    expect(config.aiProviders).toEqual([
      {
        type: "openai",
        name: "Work",
        apiKey: "sk-1",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1", "gpt-4.1-mini"],
      },
      { type: "anthropic", apiKey: "sk-2" },
      { type: "openrouter", apiKey: "sk-3" },
      { type: "openai-like", apiKey: "sk-4", baseUrl: "https://gw.local" },
      { type: "anthropic-like", apiKey: "sk-5" },
    ]);
  });

  test("skips invalid provider entries and warns while keeping the valid ones", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        aiProviders: [
          { type: "openai", apiKey: "sk-good" },
          { type: "nope", apiKey: "sk-bad-type" },
          { type: "anthropic" },
          { type: "openrouter", apiKey: "sk-also-good" },
        ],
      }),
    );
    let warned = "";
    const config = await loadGlobalConfig({
      env: env(),
      stderrWrite: (t) => {
        warned += t;
      },
    });
    expect(config.aiProviders).toEqual([
      { type: "openai", apiKey: "sk-good" },
      { type: "openrouter", apiKey: "sk-also-good" },
    ]);
    expect(warned).toContain("aiProviders[1].type");
    expect(warned).toContain("aiProviders[2].apiKey");
  });

  test("management snapshot exposes raw and effective aiProviders", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        aiProviders: [
          { type: "openai", apiKey: "sk-1", models: ["gpt-4.1"] },
        ],
      }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: () => {} });
    expect(snap.raw?.aiProviders).toEqual([
      { type: "openai", apiKey: "sk-1", models: ["gpt-4.1"] },
    ]);
    expect(snap.effective.aiProviders).toEqual([
      { type: "openai", apiKey: "sk-1", models: ["gpt-4.1"] },
    ]);
  });

  test("persists valid providers and resolves them as effective config", async () => {
    const r = await saveGlobalConfig(
      {
        aiProviders: [
          { type: "openai", apiKey: "sk-1", name: "Work", models: ["gpt-4.1"] },
        ],
      },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(true);
    const reloaded = await loadGlobalConfig({ env: env(), stderrWrite: () => {} });
    expect(reloaded.aiProviders).toEqual([
      { type: "openai", apiKey: "sk-1", name: "Work", models: ["gpt-4.1"] },
    ]);
  });

  test("an empty aiProviders list persists as an omitted, empty effective list", async () => {
    const r = await saveGlobalConfig(
      { web: { port: 4949 }, aiProviders: [] },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.effective.aiProviders).toEqual([]);
      expect(r.snapshot.raw?.aiProviders).toBeUndefined();
    }
    const persisted = JSON.parse(await readFile(globalConfigPath(env()), "utf8"));
    expect("aiProviders" in persisted).toBe(false);
  });

  test("rejects a non-array aiProviders value", () => {
    const r = validateGlobalConfigSave({ aiProviders: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("aiProviders");
  });

  test("rejects an unsupported provider type with a field-specific error", () => {
    const r = validateGlobalConfigSave({
      aiProviders: [{ type: "gemini", apiKey: "sk-1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain("aiProviders.0.type");
  });

  test("rejects a missing API key with a field-specific error", () => {
    const r = validateGlobalConfigSave({
      aiProviders: [{ type: "openai", apiKey: "" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain("aiProviders.0.apiKey");
  });

  test("rejects invalid optional fields naming the offending provider field", () => {
    const name = validateGlobalConfigSave({
      aiProviders: [{ type: "openai", apiKey: "sk", name: "" }],
    });
    expect(name.ok).toBe(false);
    if (!name.ok) expect(name.errors.map((e) => e.field)).toContain("aiProviders.0.name");

    const baseUrl = validateGlobalConfigSave({
      aiProviders: [{ type: "openai", apiKey: "sk", baseUrl: 5 }],
    });
    expect(baseUrl.ok).toBe(false);
    if (!baseUrl.ok)
      expect(baseUrl.errors.map((e) => e.field)).toContain("aiProviders.0.baseUrl");

    const models = validateGlobalConfigSave({
      aiProviders: [{ type: "openai", apiKey: "sk", models: ["ok", ""] }],
    });
    expect(models.ok).toBe(false);
    if (!models.ok)
      expect(models.errors.map((e) => e.field)).toContain("aiProviders.0.models.1");
  });

  test("invalid providers do not overwrite the existing config file", async () => {
    await writeFile(globalConfigPath(env()), JSON.stringify({ web: { port: 4949 } }));
    const before = await readFile(globalConfigPath(env()), "utf8");
    const r = await saveGlobalConfig(
      { aiProviders: [{ type: "openai", apiKey: "" }] },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(false);
    const after = await readFile(globalConfigPath(env()), "utf8");
    expect(after).toBe(before);
  });

  test("preserves model identifier order on save round-trip", async () => {
    const r = await saveGlobalConfig(
      {
        aiProviders: [
          { type: "openai", apiKey: "sk", models: ["z-model", "a-model", "m-model"] },
        ],
      },
      { env: env(), stderrWrite: () => {} },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.effective.aiProviders[0]?.models).toEqual([
        "z-model",
        "a-model",
        "m-model",
      ]);
    }
  });
});
