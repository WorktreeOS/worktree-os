import acme from "acme-client";
import type { LetsEncryptConfig } from "@worktreeos/core/global-config";
import type { ModuleLogger } from "../logger";
import { parseCertificate, coversHostnames, evaluateRenewal } from "./certificate";
import {
  renderChallengeError,
  selectChallengeRunner,
  type ChallengeRunner,
} from "./challenge-runner";
import type { CloudflareRunnerOptions } from "./dns-cloudflare";
import {
  directoryUrl,
  loadAccount,
  loadStoredCertificate,
  saveAccount,
  writeStoredCertificate,
  type AcmeAccountRecord,
  type CertificateMetadata,
  type SslListenerKind,
  type StoredCertificate,
} from "./storage";

export interface IssueResult {
  ok: true;
  certificate: StoredCertificate;
}

export interface IssueFailure {
  ok: false;
  phase:
    | "account"
    | "key"
    | "order"
    | "hook-create"
    | "hook-delete"
    | "cloudflare-create"
    | "cloudflare-delete"
    | "validation"
    | "storage"
    | "issuance"
    | "validate-cert";
  message: string;
}

export type IssueOutcome = IssueResult | IssueFailure;

export interface IssueRequest {
  kind: SslListenerKind;
  letsencrypt: LetsEncryptConfig;
  hostnames: string[];
  env?: NodeJS.ProcessEnv;
}

export interface AcmeManager {
  /** Return a stored certificate when it covers `hostnames` and hasn't expired. */
  loadValidCertificate(
    kind: SslListenerKind,
    hostnames: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<StoredCertificate | undefined>;
  /** Obtain or renew a certificate; writes atomically on success. */
  issue(req: IssueRequest): Promise<IssueOutcome>;
}

export interface CreateAcmeManagerOptions {
  /** Inject an alternate ACME client factory (tests). */
  createClient?: (
    directoryUrl: string,
    accountKey: Buffer | string,
  ) => Promise<AcmeClientLike>;
  /** Inject a custom challenge runner factory (tests). */
  selectChallengeRunner?: (
    challenge: LetsEncryptConfig["challenge"],
    env: NodeJS.ProcessEnv,
  ) => ChallengeRunner;
  /** Test hook for the Cloudflare API client. */
  cloudflare?: CloudflareRunnerOptions;
  /** Daemon `acme` module logger; diagnostics are captured here when present. */
  logger?: ModuleLogger;
}

/**
 * Minimal surface of acme-client.Client we depend on so tests can replace the
 * upstream client without spinning up a Pebble container.
 */
export interface AcmeClientLike {
  auto(opts: {
    csr: Buffer;
    email: string;
    termsOfServiceAgreed: boolean;
    challengePriority: string[];
    challengeCreateFn: AcmeChallengeFn;
    challengeRemoveFn: AcmeChallengeFn;
  }): Promise<string | Buffer>;
  getAccountUrl(): string;
}

export type AcmeChallengeFn = (
  authz: { identifier: { value: string } },
  challenge: { type: string },
  keyAuthorization: string,
) => Promise<void>;

export function createAcmeManager(
  opts: CreateAcmeManagerOptions = {},
): AcmeManager {
  const createClient =
    opts.createClient ??
    (async (url: string, accountKey: Buffer | string) =>
      new acme.Client({ directoryUrl: url, accountKey }));
  const makeRunner =
    opts.selectChallengeRunner ??
    ((challenge: LetsEncryptConfig["challenge"], env: NodeJS.ProcessEnv) =>
      selectChallengeRunner(challenge, { env, cloudflare: opts.cloudflare }));

  return {
    async loadValidCertificate(kind, hostnames, env) {
      const stored = await loadStoredCertificate(kind, env ?? process.env);
      if (!stored) return undefined;
      try {
        const parsed = parseCertificate(stored.certPem);
        const evaluation = evaluateRenewal(parsed);
        // Treat certs inside the renewal window as already-stale on the
        // resolver path so daemon startup triggers a fresh issuance — the
        // scheduler will still take over for periodic checks once the daemon
        // is running.
        if (evaluation.shouldRenew) return undefined;
        if (!coversHostnames(parsed, hostnames)) return undefined;
        return stored;
      } catch {
        return undefined;
      }
    },

    async issue(req): Promise<IssueOutcome> {
      const env = req.env ?? process.env;
      const directory = req.letsencrypt.directory;
      const email = req.letsencrypt.email;
      let account: AcmeAccountRecord | undefined;
      try {
        account = await loadAccount(directory, email, env);
      } catch (e) {
        return { ok: false, phase: "account", message: (e as Error).message };
      }
      let accountKeyPem: string;
      if (account) {
        accountKeyPem = account.privateKeyPem;
      } else {
        try {
          const newKey = await acme.forge.createPrivateKey();
          accountKeyPem = newKey.toString();
        } catch (e) {
          return { ok: false, phase: "key", message: (e as Error).message };
        }
      }

      let client: AcmeClientLike;
      try {
        client = await createClient(directoryUrl(directory), accountKeyPem);
      } catch (e) {
        return { ok: false, phase: "account", message: (e as Error).message };
      }

      let csrBuf: Buffer;
      let certKeyBuf: Buffer;
      try {
        const [k, csr] = await acme.forge.createCsr({
          commonName: req.hostnames[0],
          altNames: req.hostnames,
        });
        certKeyBuf = k as Buffer;
        csrBuf = csr as Buffer;
      } catch (e) {
        return { ok: false, phase: "key", message: (e as Error).message };
      }

      const runner = makeRunner(req.letsencrypt.challenge, env);
      const provider = req.letsencrypt.challenge.provider;
      const baseDomain = computeBaseDomain(req.hostnames);
      let lastCreateError: string | undefined;
      let lastDeleteError: string | undefined;
      const challengeCreateFn: AcmeChallengeFn = async (authz, challenge, key) => {
        if (challenge.type !== "dns-01") {
          throw new Error(`unsupported challenge type ${challenge.type}`);
        }
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const result = await runner.create({
          recordName,
          recordValue: key,
          baseDomain,
          listenerKind: req.kind,
          certificateNames: req.hostnames,
        });
        if (!result.ok) {
          lastCreateError = renderChallengeError("create", provider, result);
          throw new Error(lastCreateError);
        }
        await runner.waitForPropagation();
      };
      const challengeRemoveFn: AcmeChallengeFn = async (authz, challenge, key) => {
        if (challenge.type !== "dns-01") return;
        const recordName = `_acme-challenge.${authz.identifier.value}`;
        const result = await runner.delete({
          recordName,
          recordValue: key,
          baseDomain,
          listenerKind: req.kind,
          certificateNames: req.hostnames,
        });
        if (!result.ok) {
          lastDeleteError = renderChallengeError("delete", provider, result);
        }
      };

      let certPem: string;
      try {
        const raw = await client.auto({
          csr: csrBuf,
          email,
          termsOfServiceAgreed: true,
          challengePriority: ["dns-01"],
          challengeCreateFn,
          challengeRemoveFn,
        });
        certPem = typeof raw === "string" ? raw : raw.toString();
      } catch (e) {
        if (lastCreateError) {
          return {
            ok: false,
            phase: `${provider}-create`,
            message: lastCreateError,
          };
        }
        return { ok: false, phase: "issuance", message: (e as Error).message };
      }

      // Validate the issued material.
      try {
        const parsed = parseCertificate(certPem);
        if (!coversHostnames(parsed, req.hostnames)) {
          return {
            ok: false,
            phase: "validate-cert",
            message: `issued certificate does not cover required hostnames: ${req.hostnames.join(", ")}`,
          };
        }
        const meta: CertificateMetadata = {
          listenerKind: req.kind,
          source: "letsencrypt",
          directory,
          hostnames: parsed.hostnames,
          notBefore: parsed.notBefore.toISOString(),
          notAfter: parsed.notAfter.toISOString(),
          issuedAt: new Date().toISOString(),
        };
        const stored = await writeStoredCertificate(
          req.kind,
          {
            certPem,
            keyPem: certKeyBuf.toString("utf8"),
            fullchainPem: certPem,
            meta,
          },
          env,
        );
        // Persist the account on first successful issuance.
        if (!account) {
          await saveAccount(
            {
              directory,
              email,
              accountUrl: tryGetAccountUrl(client),
              privateKeyPem: accountKeyPem,
              createdAt: new Date().toISOString(),
            },
            env,
          );
        }
        if (lastDeleteError) {
          // Delete failure does not invalidate issuance, but is worth recording.
          if (opts.logger) opts.logger.warn("dns delete failed", { error: String(lastDeleteError) });
          else console.warn(`wos ACME: ${lastDeleteError}`);
        }
        return { ok: true, certificate: stored };
      } catch (e) {
        return { ok: false, phase: "validate-cert", message: (e as Error).message };
      }
    },
  };
}

function tryGetAccountUrl(client: AcmeClientLike): string {
  try {
    return client.getAccountUrl();
  } catch {
    return "";
  }
}

/**
 * Best-effort base domain used in the DNS hook environment contract. For a
 * wildcard cert (`["example.com", "*.example.com"]`) this is the apex
 * `example.com`. For a single-host cert (`["wos.example.com"]`) it stays
 * the host itself — the hook script is responsible for resolving the zone
 * apex via its DNS provider. Documented in README "DNS hook environment".
 */
function computeBaseDomain(hostnames: string[]): string {
  if (hostnames.length === 0) return "";
  const stripped = hostnames.map((h) => h.replace(/^\*\./, ""));
  // Find the shortest hostname — for `["example.com", "*.example.com"]` this
  // yields `example.com`. For single-host inputs it returns the host itself.
  return stripped.reduce((acc, h) => (h.length < acc.length ? h : acc), stripped[0]!);
}

