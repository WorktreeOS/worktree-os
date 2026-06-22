import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRenewalScheduler } from "@worktreeos/daemon/acme/scheduler";
import { writeStoredCertificate } from "@worktreeos/daemon/acme/storage";
import { CertificateStatusRegistry } from "@worktreeos/daemon/acme/status";
import type { AcmeManager } from "@worktreeos/daemon/acme/manager";
import type { LetsEncryptConfig } from "@worktreeos/core/global-config";
import type { CertificateLifecycleSignal } from "@worktreeos/daemon/acme/status";

function makeCert(cn: string, altNames: string[], days = 90): string {
  const id = randomBytes(6).toString("hex");
  const cfgPath = join(tmpdir(), `sch-${id}.cnf`);
  const keyPath = join(tmpdir(), `sch-${id}.key`);
  const certPath = join(tmpdir(), `sch-${id}.crt`);
  const sanLines = altNames.map((n, i) => `DNS.${i + 1} = ${n}`).join("\n");
  const cfg = [
    "[req]",
    "distinguished_name = req_dn",
    "x509_extensions = v3_req",
    "prompt = no",
    "",
    "[req_dn]",
    `CN = ${cn}`,
    "",
    "[v3_req]",
    "basicConstraints = critical, CA:FALSE",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    sanLines,
  ].join("\n");
  writeFileSync(cfgPath, cfg);
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      String(days),
      "-config",
      cfgPath,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  const pem = readFileSync(certPath, "utf8");
  try { unlinkSync(cfgPath); unlinkSync(keyPath); unlinkSync(certPath); } catch {}
  return pem;
}

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

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-acme-sched-"));
});
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("renewal scheduler", () => {
  test("skips renewal when certificate is fresh", async () => {
    const pem = makeCert("example.com", ["example.com", "*.example.com"], 90);
    await writeStoredCertificate(
      "tunnel",
      {
        certPem: pem,
        keyPem: "K",
        fullchainPem: pem,
        meta: {
          listenerKind: "tunnel",
          source: "letsencrypt",
          directory: "staging",
          hostnames: ["example.com", "*.example.com"],
          notBefore: new Date().toISOString(),
          notAfter: new Date(Date.now() + 90 * 86400000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    let issueCalls = 0;
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        issueCalls += 1;
        throw new Error("should not be called");
      },
    };
    let rotateCalls = 0;
    const scheduler = createRenewalScheduler({
      manager,
      listeners: [
        {
          kind: "tunnel",
          letsencrypt: baseLe,
          hostnames: ["example.com", "*.example.com"],
          rotate: async () => {
            rotateCalls += 1;
          },
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    expect(issueCalls).toBe(0);
    expect(rotateCalls).toBe(0);
  });

  test("publishes renewed+activated on successful renewal and skips issued", async () => {
    const pem = makeCert("example.com", ["example.com"], 20);
    await writeStoredCertificate(
      "web",
      {
        certPem: pem,
        keyPem: "K",
        fullchainPem: pem,
        meta: {
          listenerKind: "web",
          source: "letsencrypt",
          directory: "staging",
          hostnames: ["example.com"],
          notBefore: new Date().toISOString(),
          notAfter: new Date(Date.now() + 20 * 86400000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    const newPem = makeCert("example.com", ["example.com"], 90);
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        return {
          ok: true,
          certificate: {
            certPem: newPem,
            keyPem: "K2",
            fullchainPem: newPem,
            certPath: "/c",
            keyPath: "/k",
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
    const signals: CertificateLifecycleSignal[] = [];
    const scheduler = createRenewalScheduler({
      manager,
      onLifecycle: (s) => signals.push(s),
      listeners: [
        {
          kind: "web",
          letsencrypt: baseLe,
          hostnames: ["example.com"],
          rotate: async () => {},
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("renewed");
    expect(kinds).toContain("activated");
    expect(kinds).not.toContain("issued");
  });

  test("publishes issued when there is no stored certificate (first-issuance retry)", async () => {
    const newPem = makeCert("example.com", ["example.com"], 90);
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        return {
          ok: true,
          certificate: {
            certPem: newPem,
            keyPem: "K",
            fullchainPem: newPem,
            certPath: "/c",
            keyPath: "/k",
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
    const signals: CertificateLifecycleSignal[] = [];
    const scheduler = createRenewalScheduler({
      manager,
      onLifecycle: (s) => signals.push(s),
      listeners: [
        {
          kind: "tunnel",
          letsencrypt: baseLe,
          hostnames: ["example.com"],
          rotate: async () => {},
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("issued");
    expect(kinds).toContain("activated");
    expect(kinds).not.toContain("renewed");
  });

  test("renewal failure publishes failed signal and not renewed", async () => {
    const pem = makeCert("example.com", ["example.com"], 10);
    await writeStoredCertificate(
      "tunnel",
      {
        certPem: pem,
        keyPem: "K",
        fullchainPem: pem,
        meta: {
          listenerKind: "tunnel",
          source: "letsencrypt",
          directory: "staging",
          hostnames: ["example.com"],
          notBefore: new Date().toISOString(),
          notAfter: new Date(Date.now() + 10 * 86400000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        return { ok: false, phase: "hook-create", message: "dns broken" };
      },
    };
    const signals: CertificateLifecycleSignal[] = [];
    const scheduler = createRenewalScheduler({
      manager,
      onLifecycle: (s) => signals.push(s),
      listeners: [
        {
          kind: "tunnel",
          letsencrypt: baseLe,
          hostnames: ["example.com"],
          rotate: async () => {},
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    expect(signals.map((s) => s.kind)).toEqual(["failed"]);
  });

  test("renews when within window and rotates listener", async () => {
    const pem = makeCert("example.com", ["example.com"], 20);
    await writeStoredCertificate(
      "web",
      {
        certPem: pem,
        keyPem: "K",
        fullchainPem: pem,
        meta: {
          listenerKind: "web",
          source: "letsencrypt",
          directory: "staging",
          hostnames: ["example.com"],
          notBefore: new Date().toISOString(),
          notAfter: new Date(Date.now() + 20 * 86400000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    const newPem = makeCert("example.com", ["example.com"], 90);
    let issueCalls = 0;
    let rotated: { cert: string; key: string } | undefined;
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        issueCalls += 1;
        return {
          ok: true,
          certificate: {
            certPem: newPem,
            keyPem: "RENEWED-KEY",
            fullchainPem: newPem,
            certPath: "/c",
            keyPath: "/k",
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
    const scheduler = createRenewalScheduler({
      manager,
      statusRegistry: registry,
      listeners: [
        {
          kind: "web",
          letsencrypt: baseLe,
          hostnames: ["example.com"],
          rotate: async (m) => {
            rotated = m;
          },
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    expect(issueCalls).toBe(1);
    expect(rotated?.cert).toBe(newPem);
    expect(rotated?.key).toBe("RENEWED-KEY");
    expect(registry.get("web")?.state).toBe("active");
  });

  test("renewal failure records error and leaves cert active", async () => {
    const pem = makeCert("example.com", ["example.com"], 20);
    await writeStoredCertificate(
      "tunnel",
      {
        certPem: pem,
        keyPem: "K",
        fullchainPem: pem,
        meta: {
          listenerKind: "tunnel",
          source: "letsencrypt",
          directory: "staging",
          hostnames: ["example.com"],
          notBefore: new Date().toISOString(),
          notAfter: new Date(Date.now() + 20 * 86400000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue() {
        return { ok: false, phase: "issuance", message: "rate limited" };
      },
    };
    const registry = new CertificateStatusRegistry();
    let rotateCalls = 0;
    const scheduler = createRenewalScheduler({
      manager,
      statusRegistry: registry,
      listeners: [
        {
          kind: "tunnel",
          letsencrypt: baseLe,
          hostnames: ["example.com"],
          rotate: async () => {
            rotateCalls += 1;
          },
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    const status = registry.get("tunnel");
    expect(status?.state).toBe("failed");
    expect(status?.lastError?.message).toContain("rate limited");
    expect(rotateCalls).toBe(0);
  });

  test("rotate failure records activation phase", async () => {
    const pem = makeCert("example.com", ["example.com"], 10);
    await writeStoredCertificate(
      "tunnel",
      {
        certPem: pem,
        keyPem: "K",
        fullchainPem: pem,
        meta: {
          listenerKind: "tunnel",
          source: "letsencrypt",
          directory: "staging",
          hostnames: ["example.com"],
          notBefore: new Date().toISOString(),
          notAfter: new Date(Date.now() + 10 * 86400000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    const newPem = makeCert("example.com", ["example.com"], 90);
    const manager: AcmeManager = {
      async loadValidCertificate() {
        return undefined;
      },
      async issue(req) {
        return {
          ok: true,
          certificate: {
            certPem: newPem,
            keyPem: "K",
            fullchainPem: newPem,
            certPath: "/c",
            keyPath: "/k",
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
    const scheduler = createRenewalScheduler({
      manager,
      statusRegistry: registry,
      listeners: [
        {
          kind: "tunnel",
          letsencrypt: baseLe,
          hostnames: ["example.com"],
          rotate: async () => {
            throw new Error("bind failed");
          },
        },
      ],
      env: env(),
    });
    await scheduler.tick();
    const status = registry.get("tunnel");
    expect(status?.state).toBe("failed");
    expect(status?.lastError?.phase).toBe("activation");
    expect(status?.lastError?.message).toContain("bind failed");
  });
});
