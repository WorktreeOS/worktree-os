import type {
  GlobalSslConfig,
  LetsEncryptConfig,
} from "@worktreeos/core/global-config";
import {
  buildTunnelLetsEncryptHostnames,
  buildTunnelSanInputs,
  buildWebLetsEncryptHostnames,
  buildWebSanInputs,
  resolveSslMaterial,
  type LetsEncryptResolveInput,
  type ResolvedTlsMaterial,
  type SslListenerKind,
} from "../ssl-resolver";
import {
  CertificateStatusRegistry,
  type CertificateLifecycleListener,
  type CertificateState,
  type CertificateStatus,
} from "./status";
import type { AcmeManager } from "./manager";
import { parseCertificate } from "./certificate";

export interface ListenerSslContext {
  publicHostname?: string;
  tunnelDomain?: string;
}

export interface ResolveListenerSslOptions {
  kind: SslListenerKind;
  ssl: GlobalSslConfig;
  ctx: ListenerSslContext;
  acmeManager?: AcmeManager;
  statusRegistry?: CertificateStatusRegistry;
  /** Publish certificate lifecycle events for the unified event bus. */
  onLifecycle?: CertificateLifecycleListener;
  /**
   * Wall-clock ceiling for Let's Encrypt first issuance during daemon startup.
   * When exceeded the resolver fails-soft (HTTP fallback) and the renewal
   * scheduler retries later instead of leaving the daemon socket blocked on a
   * slow DNS hook. Defaults to 120 s.
   */
  letsEncryptIssueTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ListenerSslResult {
  /** TLS material when SSL is successfully resolved. */
  tls?: { cert: string; key: string };
  /** Hostnames the resolved certificate must cover. */
  hostnames: string[];
  /** Whether resolution failed (caller should treat as plaintext fall-back). */
  failed: boolean;
  /** Reason resolution failed, when applicable. */
  errorMessage?: string;
}

/**
 * Resolve TLS material for a Web UI or tunnel listener, dispatching by SSL
 * source. Fail-soft: returns `failed: true` and records certificate status
 * instead of throwing when the listener should fall back to plaintext.
 */
export async function resolveListenerSsl(
  opts: ResolveListenerSslOptions,
): Promise<ListenerSslResult> {
  const { kind, ssl, ctx, acmeManager, statusRegistry, onLifecycle } = opts;
  if (!ssl.enabled) {
    statusRegistry?.update(kind, {
      source: "disabled",
      state: "disabled",
      hostnames: [],
      active: false,
    });
    return { hostnames: [], failed: false };
  }

  const hostnames = buildRequiredHostnames(kind, ctx);
  const sanDns =
    kind === "web"
      ? buildWebSanInputs({ publicHostname: ctx.publicHostname }).sanDns
      : buildTunnelSanInputs({ tunnelDomain: ctx.tunnelDomain ?? "" }).sanDns;
  const sanIp =
    kind === "web"
      ? buildWebSanInputs({ publicHostname: ctx.publicHostname }).sanIp
      : buildTunnelSanInputs({ tunnelDomain: ctx.tunnelDomain ?? "" }).sanIp;

  try {
    const issueTimeoutMs = opts.letsEncryptIssueTimeoutMs ?? 120_000;
    const material = await resolveSslMaterial({
      ssl,
      kind,
      sanDns,
      sanIp,
      requiredHostnames: hostnames,
      env: opts.env,
      resolveLetsEncrypt: acmeManager
        ? (input) =>
            withTimeout(
              letsencryptResolver(acmeManager, input, statusRegistry, onLifecycle),
              issueTimeoutMs,
              `${input.kind}.ssl.source=letsencrypt issuance timed out after ${issueTimeoutMs}ms`,
            )
        : undefined,
    });
    recordSuccess(statusRegistry, kind, ssl, hostnames, material);
    onLifecycle?.({
      kind: "activated",
      listenerKind: kind,
      source: ssl.source,
      activatedAt: new Date().toISOString(),
    });
    return {
      tls: { cert: material.cert, key: material.key },
      hostnames,
      failed: false,
    };
  } catch (e) {
    const message = (e as Error).message;
    statusRegistry?.update(kind, {
      source: ssl.source,
      challengeProvider: challengeProviderFor(ssl),
      state: "failed",
      hostnames,
      active: false,
      lastError: {
        phase: "resolve",
        message,
        at: new Date().toISOString(),
      },
    });
    onLifecycle?.({
      kind: "failed",
      listenerKind: kind,
      source: ssl.source,
      phase: "resolve",
      message,
    });
    return { hostnames, failed: true, errorMessage: message };
  }
}

function challengeProviderFor(
  ssl: GlobalSslConfig,
): "hook" | "cloudflare" | undefined {
  if (!ssl.enabled) return undefined;
  if (ssl.source !== "letsencrypt") return undefined;
  return ssl.letsencrypt.challenge.provider;
}

function buildRequiredHostnames(
  kind: SslListenerKind,
  ctx: ListenerSslContext,
): string[] {
  if (kind === "web") {
    return buildWebLetsEncryptHostnames({ publicHostname: ctx.publicHostname });
  }
  return buildTunnelLetsEncryptHostnames({
    tunnelDomain: ctx.tunnelDomain ?? "",
  });
}

async function letsencryptResolver(
  manager: AcmeManager,
  input: LetsEncryptResolveInput,
  registry?: CertificateStatusRegistry,
  onLifecycle?: CertificateLifecycleListener,
): Promise<ResolvedTlsMaterial> {
  if (input.requiredHostnames.length === 0) {
    throw new Error(
      `${input.kind}.ssl.source=letsencrypt requires at least one hostname`,
    );
  }
  // Prefer a stored, valid certificate.
  const existing = await manager.loadValidCertificate(
    input.kind,
    input.requiredHostnames,
    input.env,
  );
  if (existing) {
    return materialFromStored(existing);
  }
  registry?.update(input.kind, {
    source: "letsencrypt",
    challengeProvider: input.letsencrypt.challenge.provider,
    state: "issuing",
    hostnames: input.requiredHostnames,
    active: false,
    lastAttemptAt: new Date().toISOString(),
  });
  const issued = await manager.issue({
    kind: input.kind,
    letsencrypt: input.letsencrypt,
    hostnames: input.requiredHostnames,
    env: input.env,
  });
  if (!issued.ok) {
    throw new Error(`${issued.phase}: ${issued.message}`);
  }
  // Successful first issuance — publish the spec-mandated `issued` event
  // after the order resolves, not when it started.
  onLifecycle?.({
    kind: "issued",
    listenerKind: input.kind,
    source: "letsencrypt",
    hostnames: issued.certificate.meta.hostnames,
    notAfter: issued.certificate.meta.notAfter,
  });
  return materialFromStored(issued.certificate);
}

function materialFromStored(stored: {
  certPem: string;
  keyPem: string;
  certPath: string;
  keyPath: string;
}): ResolvedTlsMaterial {
  return {
    cert: stored.certPem,
    key: stored.keyPem,
    certPath: stored.certPath,
    keyPath: stored.keyPath,
    generated: true,
  };
}

function recordSuccess(
  registry: CertificateStatusRegistry | undefined,
  kind: SslListenerKind,
  ssl: Exclude<GlobalSslConfig, { enabled: false }>,
  hostnames: string[],
  material: ResolvedTlsMaterial,
): void {
  if (!registry) return;
  const status: Partial<CertificateStatus> = {
    source: ssl.source,
    challengeProvider: challengeProviderFor(ssl),
    state: "active",
    hostnames,
    active: true,
    lastSuccessAt: new Date().toISOString(),
  };
  if (ssl.source === "letsencrypt") {
    try {
      const parsed = parseCertificate(material.cert);
      status.notBefore = parsed.notBefore.toISOString();
      status.notAfter = parsed.notAfter.toISOString();
      status.hostnames = parsed.hostnames;
    } catch {
      // ignore parse failures — status still reflects active resolution
    }
  }
  registry.update(kind, status);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { resolveListenerSsl as default };
