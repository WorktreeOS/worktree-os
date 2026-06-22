import { mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { wosHome } from "@worktreeos/core/paths";
import type { LetsEncryptDirectory } from "@worktreeos/core/global-config";

export type SslListenerKind = "web" | "tunnel";

export interface AcmeAccountRecord {
  directory: LetsEncryptDirectory;
  email: string;
  accountUrl: string;
  privateKeyPem: string;
  createdAt: string;
}

export interface CertificateMetadata {
  listenerKind: SslListenerKind;
  source: "letsencrypt";
  directory: LetsEncryptDirectory;
  hostnames: string[];
  notBefore: string;
  notAfter: string;
  issuedAt: string;
}

export interface StoredCertificate {
  certPem: string;
  keyPem: string;
  fullchainPem: string;
  meta: CertificateMetadata;
  certPath: string;
  keyPath: string;
}

export interface AcmeStorageOptions {
  env?: NodeJS.ProcessEnv;
}

export function acmeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), "certs", "acme");
}

export function accountsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(acmeRoot(env), "accounts");
}

export function liveDir(
  kind: SslListenerKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(acmeRoot(env), "live", kind);
}

export function locksDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(acmeRoot(env), "locks");
}

export function ordersDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(acmeRoot(env), "orders");
}

export function directoryUrl(directory: LetsEncryptDirectory): string {
  return directory === "production"
    ? "https://acme-v02.api.letsencrypt.org/directory"
    : "https://acme-staging-v02.api.letsencrypt.org/directory";
}

export function directoryHash(directory: LetsEncryptDirectory, email: string): string {
  return createHash("sha256")
    .update(`${directory}\n${email.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

function accountPath(
  directory: LetsEncryptDirectory,
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(accountsDir(env), directoryHash(directory, email), "account.json");
}

export async function loadAccount(
  directory: LetsEncryptDirectory,
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcmeAccountRecord | undefined> {
  const path = accountPath(directory, email, env);
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AcmeAccountRecord>;
    if (
      typeof parsed.privateKeyPem === "string" &&
      typeof parsed.accountUrl === "string" &&
      typeof parsed.email === "string" &&
      (parsed.directory === "production" || parsed.directory === "staging") &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as AcmeAccountRecord;
    }
  } catch {
    // fallthrough — corrupt or unreadable; treat as missing
  }
  return undefined;
}

export async function saveAccount(
  record: AcmeAccountRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = accountPath(record.directory, record.email, env);
  const dir = resolve(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWrite(path, JSON.stringify(record, null, 2) + "\n", 0o600);
}

interface LiveFilePaths {
  cert: string;
  key: string;
  fullchain: string;
  meta: string;
}

export function liveFilePaths(
  kind: SslListenerKind,
  env: NodeJS.ProcessEnv = process.env,
): LiveFilePaths {
  const dir = liveDir(kind, env);
  return {
    cert: resolve(dir, "cert.pem"),
    key: resolve(dir, "key.pem"),
    fullchain: resolve(dir, "fullchain.pem"),
    meta: resolve(dir, "meta.json"),
  };
}

export async function loadStoredCertificate(
  kind: SslListenerKind,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCertificate | undefined> {
  const paths = liveFilePaths(kind, env);
  if (
    !existsSync(paths.cert) ||
    !existsSync(paths.key) ||
    !existsSync(paths.fullchain) ||
    !existsSync(paths.meta)
  ) {
    return undefined;
  }
  try {
    const [certPem, keyPem, fullchainPem, metaText] = await Promise.all([
      readFile(paths.cert, "utf8"),
      readFile(paths.key, "utf8"),
      readFile(paths.fullchain, "utf8"),
      readFile(paths.meta, "utf8"),
    ]);
    const meta = JSON.parse(metaText) as CertificateMetadata;
    return {
      certPem,
      keyPem,
      fullchainPem,
      meta,
      certPath: paths.cert,
      keyPath: paths.key,
    };
  } catch {
    return undefined;
  }
}

/**
 * Write a freshly issued certificate atomically. All four files land in a
 * sibling staging directory; only after every file is fully written does the
 * staging directory replace the live one via a single rename. A concurrent
 * reader either sees the previous complete bundle or the new complete bundle,
 * never a mix.
 */
export async function writeStoredCertificate(
  kind: SslListenerKind,
  payload: { certPem: string; keyPem: string; fullchainPem: string; meta: CertificateMetadata },
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCertificate> {
  const liveTarget = liveDir(kind, env);
  const parent = resolve(liveTarget, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stagingId = randomBytes(8).toString("hex");
  const staging = resolve(parent, `${kind}.staging-${stagingId}`);
  const previousBackup = resolve(parent, `${kind}.prev-${stagingId}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writeFile(resolve(staging, "cert.pem"), payload.certPem, { mode: 0o600 });
    await writeFile(resolve(staging, "key.pem"), payload.keyPem, { mode: 0o600 });
    await writeFile(resolve(staging, "fullchain.pem"), payload.fullchainPem, {
      mode: 0o600,
    });
    await writeFile(
      resolve(staging, "meta.json"),
      JSON.stringify(payload.meta, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  // Atomic swap. If `live` exists, move it aside first so failure mid-swap
  // leaves either the old or the new bundle on disk — never a partial one.
  let movedOld = false;
  try {
    try {
      await rename(liveTarget, previousBackup);
      movedOld = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await rename(staging, liveTarget);
  } catch (e) {
    // Roll back: try to restore the old bundle, then clean up staging.
    if (movedOld) {
      await rename(previousBackup, liveTarget).catch(() => {});
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  if (movedOld) {
    await rm(previousBackup, { recursive: true, force: true }).catch(() => {});
  }

  const paths = liveFilePaths(kind, env);
  return {
    certPem: payload.certPem,
    keyPem: payload.keyPem,
    fullchainPem: payload.fullchainPem,
    meta: payload.meta,
    certPath: paths.cert,
    keyPath: paths.key,
  };
}

async function atomicWrite(
  path: string,
  body: string,
  mode: number,
): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, body, { mode });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export interface LockHandle {
  release: () => Promise<void>;
}

export interface AcquireLockOptions {
  /**
   * Treat any lock file older than this as stale and reclaim it. Default 10
   * minutes — long enough to cover slow DNS propagation, short enough that a
   * crashed daemon doesn't block the next renewal indefinitely.
   */
  staleAfterMs?: number;
}

/**
 * Acquire a listener-kind lock by creating the lock file with O_EXCL and
 * embedding a random ownership token. Honors stale-lock detection via mtime.
 * `release()` only removes the lock when the on-disk token still matches the
 * token we wrote — so a daemon whose tick exceeded `staleAfterMs` does not
 * delete the lock another daemon has since reclaimed.
 */
export async function acquireListenerLock(
  kind: SslListenerKind,
  opts: AcquireLockOptions & AcmeStorageOptions = {},
): Promise<LockHandle | undefined> {
  const env = opts.env ?? process.env;
  const dir = locksDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, `${kind}.lock`);
  const staleAfterMs = opts.staleAfterMs ?? 10 * 60 * 1000;
  const token = randomBytes(16).toString("hex");
  const body = JSON.stringify({
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  });
  const tryCreate = async (): Promise<LockHandle | undefined> => {
    try {
      const fh = await (await import("node:fs/promises")).open(path, "wx", 0o600);
      await fh.writeFile(body);
      await fh.close();
      return makeLockHandle(path, token);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw e;
    }
  };

  const initial = await tryCreate();
  if (initial) return initial;

  // Lock file exists — check staleness.
  try {
    const st = await stat(path);
    if (Date.now() - st.mtime.getTime() > staleAfterMs) {
      // Best-effort reclaim. The unlink+create race is benign: at most one
      // daemon wins via O_EXCL, others see EEXIST and return undefined.
      await rm(path, { force: true }).catch(() => {});
      return await tryCreate();
    }
  } catch {
    // disappeared between EEXIST and stat — caller can retry next tick.
  }
  return undefined;
}

function makeLockHandle(path: string, token: string): LockHandle {
  return {
    release: async () => {
      try {
        const body = await readFile(path, "utf8");
        const parsed = JSON.parse(body) as { token?: string };
        if (parsed.token !== token) return;
      } catch {
        return;
      }
      await rm(path, { force: true }).catch(() => {});
    },
  };
}
