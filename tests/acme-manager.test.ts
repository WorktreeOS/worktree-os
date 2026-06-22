import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createAcmeManager } from "@worktreeos/daemon/acme/manager";
import type { AcmeClientLike } from "@worktreeos/daemon/acme/manager";
import type { LetsEncryptConfig } from "@worktreeos/core/global-config";
import { loadAccount, loadStoredCertificate } from "@worktreeos/daemon/acme/storage";

function makeCert(cn: string, altNames: string[], days = 90): string {
  const id = randomBytes(6).toString("hex");
  const cfgPath = join(tmpdir(), `mgr-${id}.cnf`);
  const keyPath = join(tmpdir(), `mgr-${id}.key`);
  const certPath = join(tmpdir(), `mgr-${id}.crt`);
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
    "",
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

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-acme-mgr-"));
});
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

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

describe("acme manager.issue", () => {
  test("happy path writes certificate and account", async () => {
    const pem = makeCert("example.com", ["example.com", "*.example.com"]);
    let createCalls = 0;
    let deleteCalls = 0;
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn, challengeRemoveFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "key-auth-1",
        );
        await challengeRemoveFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "key-auth-1",
        );
        return pem;
      },
      getAccountUrl() {
        return "https://acme/acct/42";
      },
    };
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
      selectChallengeRunner: () => ({
        async create() {
          createCalls += 1;
          return { ok: true, detail: "", durationMs: 1 };
        },
        async delete() {
          deleteCalls += 1;
          return { ok: true, detail: "", durationMs: 1 };
        },
        async waitForPropagation() {},
      }),
    });
    const result = await mgr.issue({
      kind: "tunnel",
      letsencrypt: baseLe,
      hostnames: ["example.com", "*.example.com"],
      env: env(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.certificate.certPem).toBe(pem);
    expect(createCalls).toBe(1);
    expect(deleteCalls).toBe(1);
    expect(await loadAccount("staging", "me@example.com", env())).toBeDefined();
    expect((await loadStoredCertificate("tunnel", env()))?.meta.hostnames).toContain(
      "example.com",
    );
  });

  test("hook create failure surfaces phase=hook-create", async () => {
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "key-auth",
        );
        throw new Error("never reached");
      },
      getAccountUrl() {
        return "";
      },
    };
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
      selectChallengeRunner: () => ({
        async create() {
          return { ok: false, detail: "nope", durationMs: 1 };
        },
        async delete() {
          return { ok: true, detail: "", durationMs: 1 };
        },
        async waitForPropagation() {},
      }),
    });
    const result = await mgr.issue({
      kind: "web",
      letsencrypt: baseLe,
      hostnames: ["example.com"],
      env: env(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should have failed");
    expect(result.phase).toBe("hook-create");
    expect(result.message).toContain("DNS create via hook failed");
    expect(result.message).toContain("nope");
  });

  test("issued certificate not covering required hostnames is rejected", async () => {
    const pem = makeCert("other.com", ["other.com"]);
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn, challengeRemoveFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        await challengeRemoveFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        return pem;
      },
      getAccountUrl() {
        return "";
      },
    };
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
      selectChallengeRunner: () => ({
        async create() {
          return { ok: true, detail: "", durationMs: 1 };
        },
        async delete() {
          return { ok: true, detail: "", durationMs: 1 };
        },
        async waitForPropagation() {},
      }),
    });
    const result = await mgr.issue({
      kind: "tunnel",
      letsencrypt: baseLe,
      hostnames: ["example.com"],
      env: env(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.phase).toBe("validate-cert");
    // No certificate should have been written.
    expect(await loadStoredCertificate("tunnel", env())).toBeUndefined();
  });
});

describe("acme manager.issue Cloudflare provider", () => {
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

  test("happy path uses cloudflare runner and writes certificate", async () => {
    const pem = makeCert("example.com", ["example.com"]);
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn, challengeRemoveFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        await challengeRemoveFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        return pem;
      },
      getAccountUrl() {
        return "";
      },
    };
    let cfCreateCalls = 0;
    let cfDeleteCalls = 0;
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
      selectChallengeRunner: (challenge) => {
        // Verify dispatch chose the right provider.
        expect(challenge.provider).toBe("cloudflare");
        return {
          async create() {
            cfCreateCalls += 1;
            return { ok: true, detail: "", durationMs: 5 };
          },
          async delete() {
            cfDeleteCalls += 1;
            return { ok: true, detail: "", durationMs: 5 };
          },
          async waitForPropagation() {},
        };
      },
    });
    const result = await mgr.issue({
      kind: "tunnel",
      letsencrypt: cloudflareLe,
      hostnames: ["example.com"],
      env: { ...env(), CF_API_TOKEN: "secret" } as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(true);
    expect(cfCreateCalls).toBe(1);
    expect(cfDeleteCalls).toBe(1);
  });

  test("cloudflare create failure surfaces phase=cloudflare-create", async () => {
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        throw new Error("never reached");
      },
      getAccountUrl() {
        return "";
      },
    };
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
      selectChallengeRunner: () => ({
        async create() {
          return {
            ok: false,
            detail: "Cloudflare API error: code=6003 invalid token",
            durationMs: 12,
          };
        },
        async delete() {
          return { ok: true, detail: "", durationMs: 1 };
        },
        async waitForPropagation() {},
      }),
    });
    const result = await mgr.issue({
      kind: "web",
      letsencrypt: cloudflareLe,
      hostnames: ["example.com"],
      env: { ...env(), CF_API_TOKEN: "x" } as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.phase).toBe("cloudflare-create");
    expect(result.message).toContain("DNS create via cloudflare failed");
    expect(result.message).toContain("invalid token");
  });

  test("missing token env without injected runner fails create soft", async () => {
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        throw new Error("never reached");
      },
      getAccountUrl() {
        return "";
      },
    };
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
    });
    const result = await mgr.issue({
      kind: "web",
      letsencrypt: cloudflareLe,
      hostnames: ["example.com"],
      env: env(), // CF_API_TOKEN intentionally missing
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.phase).toBe("cloudflare-create");
    expect(result.message).toContain("CF_API_TOKEN");
  });

  test("propagation wait is honored", async () => {
    const pem = makeCert("example.com", ["example.com"]);
    const fakeClient: AcmeClientLike = {
      async auto({ challengeCreateFn, challengeRemoveFn }) {
        await challengeCreateFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        await challengeRemoveFn(
          { identifier: { value: "example.com" } },
          { type: "dns-01" },
          "k",
        );
        return pem;
      },
      getAccountUrl() {
        return "";
      },
    };
    let waited = false;
    const mgr = createAcmeManager({
      createClient: async () => fakeClient,
      selectChallengeRunner: () => ({
        async create() {
          return { ok: true, detail: "", durationMs: 1 };
        },
        async delete() {
          return { ok: true, detail: "", durationMs: 1 };
        },
        async waitForPropagation() {
          waited = true;
        },
      }),
    });
    const r = await mgr.issue({
      kind: "tunnel",
      letsencrypt: {
        ...cloudflareLe,
        challenge: { ...cloudflareLe.challenge, propagationSeconds: 5 },
      },
      hostnames: ["example.com"],
      env: { ...env(), CF_API_TOKEN: "x" } as NodeJS.ProcessEnv,
    });
    expect(r.ok).toBe(true);
    expect(waited).toBe(true);
  });
});

describe("acme manager.loadValidCertificate", () => {
  test("returns undefined when no certificate is stored", async () => {
    const mgr = createAcmeManager();
    expect(
      await mgr.loadValidCertificate("web", ["example.com"], env()),
    ).toBeUndefined();
  });

  test("returns undefined when hostnames do not match", async () => {
    const pem = makeCert("example.com", ["example.com"]);
    const { writeStoredCertificate } = await import("@worktreeos/daemon/acme/storage");
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
          notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          issuedAt: new Date().toISOString(),
        },
      },
      env(),
    );
    const mgr = createAcmeManager();
    expect(
      await mgr.loadValidCertificate("web", ["other.com"], env()),
    ).toBeUndefined();
    const ok = await mgr.loadValidCertificate("web", ["example.com"], env());
    expect(ok).toBeDefined();
  });
});
