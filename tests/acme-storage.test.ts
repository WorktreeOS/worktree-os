import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  acmeRoot,
  acquireListenerLock,
  directoryHash,
  liveFilePaths,
  loadAccount,
  loadStoredCertificate,
  saveAccount,
  writeStoredCertificate,
} from "@worktreeos/daemon/acme/storage";

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-acme-storage-"));
});
afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("acme storage paths", () => {
  test("acmeRoot is <wos-home>/certs/acme", () => {
    expect(acmeRoot(env())).toBe(join(tmpHome, "certs", "acme"));
  });

  test("directoryHash is deterministic", () => {
    const a = directoryHash("production", "me@example.com");
    const b = directoryHash("production", "ME@example.com");
    expect(a).toBe(b);
    expect(directoryHash("staging", "me@example.com")).not.toBe(a);
  });
});

describe("acme account storage", () => {
  test("loadAccount returns undefined when absent", async () => {
    expect(await loadAccount("staging", "me@example.com", env())).toBeUndefined();
  });

  test("saveAccount + loadAccount round-trip", async () => {
    await saveAccount(
      {
        directory: "staging",
        email: "me@example.com",
        accountUrl: "https://acme/acct/1",
        privateKeyPem: "-----BEGIN RSA-----PK-----END RSA-----",
        createdAt: new Date().toISOString(),
      },
      env(),
    );
    const got = await loadAccount("staging", "me@example.com", env());
    expect(got?.email).toBe("me@example.com");
    expect(got?.directory).toBe("staging");
    expect(got?.accountUrl).toBe("https://acme/acct/1");
  });

  test("loadAccount returns undefined on corrupt file", async () => {
    // Save garbage at the expected path.
    const dir = join(acmeRoot(env()), "accounts", directoryHash("staging", "x@x.com"));
    await Bun.$`mkdir -p ${dir}`;
    await writeFile(join(dir, "account.json"), "not-json");
    expect(await loadAccount("staging", "x@x.com", env())).toBeUndefined();
  });
});

describe("acme certificate storage", () => {
  test("loadStoredCertificate returns undefined when files missing", async () => {
    expect(await loadStoredCertificate("web", env())).toBeUndefined();
  });

  test("writeStoredCertificate writes all four files atomically", async () => {
    const meta = {
      listenerKind: "web" as const,
      source: "letsencrypt" as const,
      directory: "staging" as const,
      hostnames: ["example.com"],
      notBefore: "2024-01-01T00:00:00.000Z",
      notAfter: "2025-01-01T00:00:00.000Z",
      issuedAt: "2024-01-01T00:00:00.000Z",
    };
    const stored = await writeStoredCertificate(
      "web",
      {
        certPem: "CERT",
        keyPem: "KEY",
        fullchainPem: "FULL",
        meta,
      },
      env(),
    );
    expect(stored.certPath).toBe(liveFilePaths("web", env()).cert);
    expect(await readFile(stored.certPath, "utf8")).toBe("CERT");
    expect(await readFile(stored.keyPath, "utf8")).toBe("KEY");
    expect(await readFile(liveFilePaths("web", env()).fullchain, "utf8")).toBe("FULL");
    const reloaded = await loadStoredCertificate("web", env());
    expect(reloaded?.certPem).toBe("CERT");
    expect(reloaded?.meta.hostnames).toEqual(["example.com"]);
  });

  test("writeStoredCertificate replaces previous files", async () => {
    const baseMeta = {
      listenerKind: "tunnel" as const,
      source: "letsencrypt" as const,
      directory: "staging" as const,
      hostnames: ["example.com"],
      notBefore: "2024-01-01T00:00:00.000Z",
      notAfter: "2025-01-01T00:00:00.000Z",
      issuedAt: "2024-01-01T00:00:00.000Z",
    };
    await writeStoredCertificate(
      "tunnel",
      { certPem: "OLD", keyPem: "OLD-K", fullchainPem: "OLD-F", meta: baseMeta },
      env(),
    );
    await writeStoredCertificate(
      "tunnel",
      { certPem: "NEW", keyPem: "NEW-K", fullchainPem: "NEW-F", meta: baseMeta },
      env(),
    );
    const reloaded = await loadStoredCertificate("tunnel", env());
    expect(reloaded?.certPem).toBe("NEW");
    expect(reloaded?.keyPem).toBe("NEW-K");
  });
});

describe("acme listener lock", () => {
  test("acquires and releases", async () => {
    const h = await acquireListenerLock("web", { env: env() });
    expect(h).toBeDefined();
    // While held, a second acquire returns undefined.
    const h2 = await acquireListenerLock("web", { env: env() });
    expect(h2).toBeUndefined();
    await h!.release();
    const h3 = await acquireListenerLock("web", { env: env() });
    expect(h3).toBeDefined();
    await h3!.release();
  });

  test("reclaims stale lock", async () => {
    const h = await acquireListenerLock("tunnel", { env: env() });
    expect(h).toBeDefined();
    const lockPath = join(acmeRoot(env()), "locks", "tunnel.lock");
    expect(existsSync(lockPath)).toBe(true);
    // Backdate the lock mtime to simulate a crashed daemon.
    const ancient = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockPath, ancient, ancient);
    const h2 = await acquireListenerLock("tunnel", {
      env: env(),
      staleAfterMs: 1000,
    });
    expect(h2).toBeDefined();
    await h2!.release();
  });
});
