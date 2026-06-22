import type {
  LetsEncryptChallengeProvider,
  SslCertificateSource,
} from "@worktreeos/core/global-config";
import type { SslListenerKind } from "./storage";

export type CertificateState =
  | "disabled"
  | "issuing"
  | "active"
  | "renewing"
  | "failed"
  | "stale";

export interface CertificateStatus {
  listenerKind: SslListenerKind;
  source: SslCertificateSource | "disabled";
  /**
   * DNS-01 provider when the source is `letsencrypt`. Reported so the UI can
   * distinguish Cloudflare-managed certificates from hook-driven ones without
   * exposing token material.
   */
  challengeProvider?: LetsEncryptChallengeProvider;
  state: CertificateState;
  hostnames: string[];
  notBefore?: string;
  notAfter?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: {
    phase: string;
    message: string;
    at: string;
  };
  active: boolean;
}

/**
 * Lifecycle events published by ACME-managed paths. Separate from
 * CertificateStatus mutations so callers can distinguish "stored cert reused"
 * from "newly issued/renewed" and avoid double-publishing on every status
 * mutation.
 */
export type CertificateLifecycleSignal =
  | { kind: "issued"; listenerKind: SslListenerKind; source: SslCertificateSource; hostnames: string[]; notAfter?: string }
  | { kind: "renewed"; listenerKind: SslListenerKind; source: SslCertificateSource; hostnames: string[]; notAfter?: string }
  | { kind: "activated"; listenerKind: SslListenerKind; source: SslCertificateSource; activatedAt: string }
  | { kind: "failed"; listenerKind: SslListenerKind; source: SslCertificateSource; phase: string; message: string };

export type CertificateLifecycleListener = (
  signal: CertificateLifecycleSignal,
) => void;

/**
 * In-process certificate status registry. The daemon owns one of these and
 * publishes updates to UI clients via the existing unified event bus.
 */
export class CertificateStatusRegistry {
  private statuses = new Map<SslListenerKind, CertificateStatus>();
  private listeners = new Set<(status: CertificateStatus) => void>();

  get(kind: SslListenerKind): CertificateStatus | undefined {
    return this.statuses.get(kind);
  }

  snapshot(): { web?: CertificateStatus; tunnel?: CertificateStatus } {
    return {
      web: this.statuses.get("web"),
      tunnel: this.statuses.get("tunnel"),
    };
  }

  set(status: CertificateStatus): void {
    this.statuses.set(status.listenerKind, status);
    for (const l of this.listeners) {
      try {
        l(status);
      } catch {
        // listener errors are non-fatal
      }
    }
  }

  update(
    kind: SslListenerKind,
    patch: Partial<CertificateStatus>,
  ): CertificateStatus {
    const prev = this.statuses.get(kind) ?? {
      listenerKind: kind,
      source: "disabled" as const,
      state: "disabled" as const,
      hostnames: [],
      active: false,
    };
    const next: CertificateStatus = { ...prev, ...patch };
    this.set(next);
    return next;
  }

  subscribe(listener: (status: CertificateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
