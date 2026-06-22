import type { LetsEncryptConfig } from "@worktreeos/core/global-config";
import { parseCertificate, evaluateRenewal } from "./certificate";
import {
  acquireListenerLock,
  loadStoredCertificate,
  type SslListenerKind,
} from "./storage";
import type { AcmeManager } from "./manager";
import type {
  CertificateLifecycleListener,
  CertificateStatusRegistry,
} from "./status";
import type { ModuleLogger } from "../logger";

export interface ManagedListener {
  kind: SslListenerKind;
  letsencrypt: LetsEncryptConfig;
  hostnames: string[];
  /** Called after a successful renewal to rotate the listener TLS material. */
  rotate: (material: { cert: string; key: string }) => Promise<void>;
}

export interface RenewalSchedulerOptions {
  manager: AcmeManager;
  statusRegistry?: CertificateStatusRegistry;
  /** Publish certificate lifecycle events for the unified event bus. */
  onLifecycle?: CertificateLifecycleListener;
  /** Listeners to monitor. May be empty when no listener uses Let's Encrypt. */
  listeners: ManagedListener[];
  /** Renewal evaluation interval in ms. Defaults to 12 hours. */
  checkIntervalMs?: number;
  /** Jitter ratio (0..1) applied to scheduler ticks. Defaults to 0.2. */
  jitterRatio?: number;
  /** Days before notAfter that should trigger renewal. Defaults to 30. */
  renewalWindowDays?: number;
  /** Inject `setTimeout` for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  /** Inject `clearTimeout` for tests. */
  clearTimeoutFn?: (id: NodeJS.Timeout | number) => void;
  env?: NodeJS.ProcessEnv;
  /** Daemon `acme` module logger; renewal errors are captured here when present. */
  logger?: ModuleLogger;
}

export interface RenewalScheduler {
  /** Start the scheduler. Returns immediately. */
  start(): void;
  /** Stop the scheduler and wait for any in-flight tick to settle. */
  stop(): Promise<void>;
  /** Force a renewal evaluation pass. Used by tests. */
  tick(): Promise<void>;
}

export function createRenewalScheduler(
  opts: RenewalSchedulerOptions,
): RenewalScheduler {
  const checkIntervalMs = opts.checkIntervalMs ?? 12 * 60 * 60 * 1000;
  const jitterRatio = opts.jitterRatio ?? 0.2;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  let timer: NodeJS.Timeout | number | undefined;
  let stopped = false;
  let inflight: Promise<void> | undefined;

  const scheduleNext = () => {
    if (stopped) return;
    const jitter = 1 - jitterRatio + Math.random() * (2 * jitterRatio);
    const delay = Math.max(1000, Math.round(checkIntervalMs * jitter));
    timer = setT(() => {
      inflight = tick().finally(() => {
        inflight = undefined;
        scheduleNext();
      });
    }, delay);
  };

  async function tick(): Promise<void> {
    if (stopped) return;
    for (const listener of opts.listeners) {
      try {
        await maybeRenew(listener, opts);
      } catch (e) {
        // Recording is done inside maybeRenew; outer catch prevents one
        // listener's failure from aborting the rest of the tick.
        if (opts.logger) {
          opts.logger.warn("renewal error", {
            listener: listener.kind,
            error: (e as Error).message,
          });
        } else {
          console.warn(
            `wos ACME scheduler: ${listener.kind} renewal error: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  return {
    start() {
      if (stopped) return;
      scheduleNext();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearT(timer);
      if (inflight) {
        try {
          await inflight;
        } catch {
          // already handled inside tick
        }
      }
    },
    tick,
  };
}

async function maybeRenew(
  listener: ManagedListener,
  opts: RenewalSchedulerOptions,
): Promise<void> {
  const env = opts.env ?? process.env;
  const stored = await loadStoredCertificate(listener.kind, env);
  let isFirstIssuance = false;
  if (!stored) {
    // First-issuance retry path: the resolver couldn't issue at startup,
    // but the listener is still configured for Let's Encrypt. Try again on
    // each scheduler tick so a transient DNS hook failure doesn't lock the
    // listener at plaintext forever.
    isFirstIssuance = true;
  } else {
    let evaluation;
    try {
      const parsed = parseCertificate(stored.certPem);
      evaluation = evaluateRenewal(parsed, {
        renewalWindowDays: opts.renewalWindowDays,
      });
    } catch {
      return;
    }
    if (!evaluation.shouldRenew) return;
  }

  const lock = await acquireListenerLock(listener.kind, { env });
  if (!lock) {
    // Another daemon (or in-flight call) holds the lock — preserve current cert.
    return;
  }
  try {
    opts.statusRegistry?.update(listener.kind, {
      source: "letsencrypt",
      challengeProvider: listener.letsencrypt.challenge.provider,
      state: "renewing",
      hostnames: listener.hostnames,
      lastAttemptAt: new Date().toISOString(),
    });
    const result = await opts.manager.issue({
      kind: listener.kind,
      letsencrypt: listener.letsencrypt,
      hostnames: listener.hostnames,
      env,
    });
    if (!result.ok) {
      opts.statusRegistry?.update(listener.kind, {
        state: "failed",
        active: stored !== undefined,
        lastError: {
          phase: result.phase,
          message: result.message,
          at: new Date().toISOString(),
        },
      });
      opts.onLifecycle?.({
        kind: "failed",
        listenerKind: listener.kind,
        source: "letsencrypt",
        phase: result.phase,
        message: result.message,
      });
      return;
    }
    // Publish the issued/renewed event tied to actual order success before
    // attempting listener rotation — so subscribers see what was obtained
    // even when activation fails.
    opts.onLifecycle?.({
      kind: isFirstIssuance ? "issued" : "renewed",
      listenerKind: listener.kind,
      source: "letsencrypt",
      hostnames: result.certificate.meta.hostnames,
      notAfter: result.certificate.meta.notAfter,
    });
    try {
      await listener.rotate({
        cert: result.certificate.certPem,
        key: result.certificate.keyPem,
      });
      opts.statusRegistry?.update(listener.kind, {
        state: "active",
        active: true,
        lastSuccessAt: new Date().toISOString(),
        notBefore: result.certificate.meta.notBefore,
        notAfter: result.certificate.meta.notAfter,
        hostnames: result.certificate.meta.hostnames,
        lastError: undefined,
      });
      opts.onLifecycle?.({
        kind: "activated",
        listenerKind: listener.kind,
        source: "letsencrypt",
        activatedAt: new Date().toISOString(),
      });
    } catch (e) {
      const message = (e as Error).message;
      opts.statusRegistry?.update(listener.kind, {
        state: "failed",
        active: stored !== undefined,
        lastError: {
          phase: "activation",
          message,
          at: new Date().toISOString(),
        },
      });
      opts.onLifecycle?.({
        kind: "failed",
        listenerKind: listener.kind,
        source: "letsencrypt",
        phase: "activation",
        message,
      });
    }
  } finally {
    await lock.release();
  }
}
