import { X509Certificate } from "node:crypto";

export interface ParsedCertificate {
  hostnames: string[];
  notBefore: Date;
  notAfter: Date;
  subject: string;
}

/**
 * Parse a PEM-encoded X.509 certificate using node:crypto's X509Certificate.
 * Returns DNS hostnames covered by the certificate (Subject CN + SAN dnsNames).
 */
export function parseCertificate(pem: string): ParsedCertificate {
  const cert = new X509Certificate(pem);
  const hostnames = collectHostnames(cert);
  return {
    hostnames,
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    subject: cert.subject,
  };
}

function collectHostnames(cert: X509Certificate): string[] {
  // SubjectAltName is the source of truth for modern certs (CN is deprecated
  // by RFC 2818/6125). Let's Encrypt always populates SAN; parsing it avoids
  // the unstable DN-formatting of `cert.subject` across Node versions.
  const out = new Set<string>();
  const san = cert.subjectAltName;
  if (san) {
    const parts = san.split(/,\s*/);
    for (const p of parts) {
      const m = /^DNS:(.+)$/.exec(p);
      if (m && m[1]) out.add(m[1].trim());
    }
  }
  return Array.from(out);
}

/**
 * Check whether a parsed certificate's SAN/CN covers every required hostname.
 * Wildcard certificates (`*.example.com`) cover one level of subdomain only.
 */
export function coversHostnames(
  parsed: ParsedCertificate,
  required: string[],
): boolean {
  for (const req of required) {
    if (!hostnameCovered(parsed.hostnames, req)) return false;
  }
  return true;
}

export function hostnameCovered(provided: string[], required: string): boolean {
  for (const p of provided) {
    if (p === required) return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      // Wildcard covers single-label subdomains only.
      if (required.endsWith(suffix)) {
        const head = required.slice(0, required.length - suffix.length);
        if (head.length > 0 && !head.includes(".")) return true;
      }
    }
  }
  return false;
}

export interface RenewalEvaluation {
  /** True when the certificate is currently within its validity window. */
  active: boolean;
  /** True when the certificate is past its `notAfter`. */
  expired: boolean;
  /** Days until expiration (negative when expired). */
  daysUntilExpiry: number;
  /** True when the certificate is inside the renewal window. */
  shouldRenew: boolean;
}

export interface EvaluateRenewalOptions {
  /** Reference time for evaluation. Defaults to Date.now(). */
  now?: Date;
  /** Days before notAfter that should trigger renewal. Defaults to 30. */
  renewalWindowDays?: number;
}

export function evaluateRenewal(
  parsed: ParsedCertificate,
  opts: EvaluateRenewalOptions = {},
): RenewalEvaluation {
  const now = opts.now ?? new Date();
  const windowDays = opts.renewalWindowDays ?? 30;
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilExpiry = (parsed.notAfter.getTime() - now.getTime()) / msPerDay;
  const active = now >= parsed.notBefore && now < parsed.notAfter;
  return {
    active,
    expired: now >= parsed.notAfter,
    daysUntilExpiry,
    shouldRenew: daysUntilExpiry <= windowDays,
  };
}
