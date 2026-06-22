import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveListenerSsl } from "@worktreeos/daemon/acme/listener-resolve";
import { CertificateStatusRegistry } from "@worktreeos/daemon/acme/status";
import {
  buildTunnelLetsEncryptHostnames,
  buildWebLetsEncryptHostnames,
} from "@worktreeos/daemon/ssl-resolver";
import type { LetsEncryptConfig } from "@worktreeos/core/global-config";
import type { AcmeManager } from "@worktreeos/daemon/acme/manager";

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;

const baseLe: LetsEncryptConfig = {
  email: "me@example.com",
  acceptTerms: true,
  directory: "staging",
  challenge: {
    type: "dns-01",
    provider: "hook",
    createCommand: "true",
    deleteCommand: "true",
    propagationSeconds: 0,
  },
};

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-listener-ssl-"));
});
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("hostname builders", () => {
  test("web LE hostnames include explicit public hostname", () => {
    expect(
      buildWebLetsEncryptHostnames({ publicHostname: "wos.example.com" }),
    ).toEqual(["wos.example.com"]);
  });
  test("web LE hostnames empty without public hostname", () => {
    expect(buildWebLetsEncryptHostnames({})).toEqual([]);
  });
  test("tunnel LE hostnames include domain and wildcard", () => {
    expect(buildTunnelLetsEncryptHostnames({ tunnelDomain: "example.com" })).toEqual([
      "example.com",
      "*.example.com",
    ]);
  });
});

describe("resolveListenerSsl files source", () => {
  test("reads configured cert+key", async () => {
    const certPath = join(tmpHome, "c.pem");
    const keyPath = join(tmpHome, "k.pem");
    await writeFile(certPath, "CERT");
    await writeFile(keyPath, "KEY");
    const result = await resolveListenerSsl({
      kind: "web",
      ssl: { enabled: true, source: "files", cert: certPath, key: keyPath },
      ctx: { publicHostname: "wos.example.com" },
      env: env(),
    });
    expect(result.failed).toBe(false);
    expect(result.tls?.cert).toBe("CERT");
    expect(result.tls?.key).toBe("KEY");
  });

  test("fails soft when configured cert is missing", async () => {
    const registry = new CertificateStatusRegistry();
    const result = await resolveListenerSsl({
      kind: "web",
      ssl: {
        enabled: true,
        source: "files",
        cert: "/no/such/cert.pem",
        key: "/no/such/key.pem",
      },
      ctx: {},
      statusRegistry: registry,
      env: env(),
    });
    expect(result.failed).toBe(true);
    expect(result.errorMessage).toContain("web.ssl.cert");
    expect(registry.get("web")?.state).toBe("failed");
  });
});

describe("resolveListenerSsl letsencrypt source", () => {
  test("uses ACME manager and records active status", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        return {
          ok: true,
          certificate: {
            certPem: "CERT-PEM",
            keyPem: "KEY-PEM",
            fullchainPem: "FULL",
            certPath: "/tmp/c",
            keyPath: "/tmp/k",
            meta: {
              listenerKind: req.kind,
              source: "letsencrypt",
              directory: "staging",
              hostnames: req.hostnames,
              notBefore: new Date().toISOString(),
              notAfter: new Date(Date.now() + 90 * 86400000).toISOString(),
              issuedAt: new Date().toISOString(),
            },
          },
        };
      },
    };
    const registry = new CertificateStatusRegistry();
    const result = await resolveListenerSsl({
      kind: "tunnel",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: { tunnelDomain: "example.com" },
      acmeManager: fakeManager,
      statusRegistry: registry,
      env: env(),
    });
    expect(result.failed).toBe(false);
    expect(result.tls?.cert).toBe("CERT-PEM");
    expect(result.hostnames).toEqual(["example.com", "*.example.com"]);
    const status = registry.get("tunnel");
    expect(status?.source).toBe("letsencrypt");
    expect(status?.state).toBe("active");
  });

  test("reuses stored certificate when valid", async () => {
    let issueCalls = 0;
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return {
          certPem: "STORED",
          keyPem: "STORED-K",
          fullchainPem: "STORED-F",
          certPath: "/c",
          keyPath: "/k",
          meta: {
            listenerKind: "web",
            source: "letsencrypt",
            directory: "staging",
            hostnames: ["wos.example.com"],
            notBefore: new Date().toISOString(),
            notAfter: new Date(Date.now() + 60 * 86400000).toISOString(),
            issuedAt: new Date().toISOString(),
          },
        };
      },
      async issue() {
        issueCalls += 1;
        throw new Error("should not be called");
      },
    };
    const result = await resolveListenerSsl({
      kind: "web",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: { publicHostname: "wos.example.com" },
      acmeManager: fakeManager,
      env: env(),
    });
    expect(result.failed).toBe(false);
    expect(result.tls?.cert).toBe("STORED");
    expect(issueCalls).toBe(0);
  });

  test("missing hostnames cause failure", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        throw new Error("should not be called");
      },
    };
    const registry = new CertificateStatusRegistry();
    const result = await resolveListenerSsl({
      kind: "web",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: {},
      acmeManager: fakeManager,
      statusRegistry: registry,
      env: env(),
    });
    expect(result.failed).toBe(true);
    expect(registry.get("web")?.state).toBe("failed");
  });

  test("issuance failure records error and fails soft", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        return { ok: false, phase: "hook-create", message: "DNS broken" };
      },
    };
    const registry = new CertificateStatusRegistry();
    const result = await resolveListenerSsl({
      kind: "tunnel",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: { tunnelDomain: "example.com" },
      acmeManager: fakeManager,
      statusRegistry: registry,
      env: env(),
    });
    expect(result.failed).toBe(true);
    expect(result.errorMessage).toContain("DNS broken");
    expect(registry.get("tunnel")?.state).toBe("failed");
  });
});

describe("resolveListenerSsl lifecycle signals", () => {
  test("issued+activated fire when LE issues a new certificate", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        return {
          ok: true,
          certificate: {
            certPem: "C",
            keyPem: "K",
            fullchainPem: "F",
            certPath: "/c",
            keyPath: "/k",
            meta: {
              listenerKind: req.kind,
              source: "letsencrypt",
              directory: "staging",
              hostnames: req.hostnames,
              notBefore: new Date().toISOString(),
              notAfter: new Date(Date.now() + 86400000).toISOString(),
              issuedAt: new Date().toISOString(),
            },
          },
        };
      },
    };
    const signals: { kind: string }[] = [];
    await resolveListenerSsl({
      kind: "tunnel",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: { tunnelDomain: "example.com" },
      acmeManager: fakeManager,
      onLifecycle: (s) => signals.push(s),
      env: env(),
    });
    expect(signals.map((s) => s.kind)).toEqual(["issued", "activated"]);
  });

  test("only activated fires when stored certificate is reused", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return {
          certPem: "STORED",
          keyPem: "K",
          fullchainPem: "STORED",
          certPath: "/c",
          keyPath: "/k",
          meta: {
            listenerKind: "web",
            source: "letsencrypt",
            directory: "staging",
            hostnames: ["wos.example.com"],
            notBefore: new Date().toISOString(),
            notAfter: new Date(Date.now() + 60 * 86400000).toISOString(),
            issuedAt: new Date().toISOString(),
          },
        };
      },
      async issue() {
        throw new Error("should not be called");
      },
    };
    const signals: { kind: string }[] = [];
    await resolveListenerSsl({
      kind: "web",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: { publicHostname: "wos.example.com" },
      acmeManager: fakeManager,
      onLifecycle: (s) => signals.push(s),
      env: env(),
    });
    expect(signals.map((s) => s.kind)).toEqual(["activated"]);
  });

  test("failed fires when LE issuance fails", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        return { ok: false, phase: "hook-create", message: "DNS down" };
      },
    };
    const signals: { kind: string }[] = [];
    await resolveListenerSsl({
      kind: "tunnel",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: baseLe },
      ctx: { tunnelDomain: "example.com" },
      acmeManager: fakeManager,
      onLifecycle: (s) => signals.push(s),
      env: env(),
    });
    expect(signals.map((s) => s.kind)).toEqual(["failed"]);
  });
});

describe("resolveListenerSsl challenge provider", () => {
  const cloudflareLe: LetsEncryptConfig = {
    email: "me@example.com",
    acceptTerms: true,
    directory: "staging",
    challenge: {
      type: "dns-01",
      provider: "cloudflare",
      apiTokenEnv: "CF_API_TOKEN",
      propagationSeconds: 0,
    },
  };

  test("records challengeProvider=cloudflare on active status", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        return {
          ok: true,
          certificate: {
            certPem: "C",
            keyPem: "K",
            fullchainPem: "F",
            certPath: "/c",
            keyPath: "/k",
            meta: {
              listenerKind: req.kind,
              source: "letsencrypt",
              directory: "staging",
              hostnames: req.hostnames,
              notBefore: new Date().toISOString(),
              notAfter: new Date(Date.now() + 86_400_000).toISOString(),
              issuedAt: new Date().toISOString(),
            },
          },
        };
      },
    };
    const registry = new CertificateStatusRegistry();
    await resolveListenerSsl({
      kind: "tunnel",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: cloudflareLe },
      ctx: { tunnelDomain: "example.com" },
      acmeManager: fakeManager,
      statusRegistry: registry,
      env: env(),
    });
    expect(registry.get("tunnel")?.challengeProvider).toBe("cloudflare");
    expect(registry.get("tunnel")?.state).toBe("active");
  });

  test("records challengeProvider=cloudflare on failure status", async () => {
    const fakeManager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        return {
          ok: false,
          phase: "cloudflare-create",
          message: "DNS create via cloudflare failed (15ms): invalid token",
        };
      },
    };
    const registry = new CertificateStatusRegistry();
    await resolveListenerSsl({
      kind: "tunnel",
      ssl: { enabled: true, source: "letsencrypt", letsencrypt: cloudflareLe },
      ctx: { tunnelDomain: "example.com" },
      acmeManager: fakeManager,
      statusRegistry: registry,
      env: env(),
    });
    const status = registry.get("tunnel");
    expect(status?.state).toBe("failed");
    expect(status?.challengeProvider).toBe("cloudflare");
    expect(status?.lastError?.message).toContain("invalid token");
  });
});

describe("resolveListenerSsl disabled", () => {
  test("returns no TLS when ssl.enabled is false", async () => {
    const registry = new CertificateStatusRegistry();
    const result = await resolveListenerSsl({
      kind: "web",
      ssl: { enabled: false },
      ctx: {},
      statusRegistry: registry,
      env: env(),
    });
    expect(result.failed).toBe(false);
    expect(result.tls).toBeUndefined();
    expect(registry.get("web")?.state).toBe("disabled");
  });
});
