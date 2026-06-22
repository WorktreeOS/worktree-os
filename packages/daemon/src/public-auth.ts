import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "wos_public_auth";
/** Default 30-day session lifetime in seconds. */
export const DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_VERSION = "v1";

/** Normalize a hostname for `Host`-header comparisons: lowercase, no port. */
export function normalizePublicHostname(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim().toLowerCase();
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * Classify a request as targeting the public daemon hostname. The tunnel
 * server rewrites the `Host` header to `127.0.0.1:<port>` before proxying to
 * the daemon web listener and preserves the original hostname in
 * `X-Forwarded-Host`, so we check that header first.
 */
export function isPublicHostRequest(
  req: Request,
  publicHostname: string | undefined,
): boolean {
  if (!publicHostname) return false;
  const original =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const host = normalizePublicHostname(original);
  return host.length > 0 && host === normalizePublicHostname(publicHostname);
}

/**
 * Classify an IPv4/IPv6 address string as loopback. Bun's `server.requestIP`
 * returns the raw socket address — `127.0.0.1`, `::1`, or the IPv4-mapped
 * IPv6 form `::ffff:127.x.y.z` — so we handle each. Returns `false` when the
 * address is missing or empty so callers default to the safe "unknown ≠
 * trusted local" behavior.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "::1") return true;
  if (trimmed === "127.0.0.1") return true;
  if (trimmed.startsWith("127.")) return true;
  if (trimmed.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Read the remote peer address for a Bun request. Tests and Unix-socket
 * callers may invoke handlers without a `server` instance; in that case we
 * have no socket metadata and return `undefined`.
 */
export function readRequestAddress(
  req: Request,
  server: import("bun").Server | undefined,
): string | undefined {
  if (!server) return undefined;
  try {
    return server.requestIP(req)?.address ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a request reaching the daemon web listener as a public tunnel Web
 * UI request. Public classification is now keyed strictly off the configured
 * tunnel Web UI hostname (matched against `X-Forwarded-Host` from the tunnel
 * proxy or the direct `Host` header). Direct main-port public access is no
 * longer supported — the daemon Web UI listener is always loopback HTTP.
 *
 * Local loopback clients that do not target the public hostname keep the
 * existing local UI API contract (no public authentication required).
 */
export function isPublicTunnelRequest(
  req: Request,
  publicWebUiEnabled: boolean,
  publicHostname: string | undefined,
): boolean {
  if (!publicWebUiEnabled) return false;
  return isPublicHostRequest(req, publicHostname);
}

/**
 * Sign an auth cookie. Format: `v1.<iat>.<hex hmac>` where the HMAC is
 * computed with the configured secret over `v1.<iat>`. Rotating the secret
 * invalidates all previously issued cookies.
 */
export function signAuthCookie(secret: string, issuedAtMs: number): string {
  const payload = `${COOKIE_VERSION}.${issuedAtMs}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export interface VerifyAuthCookieOptions {
  /** Override "now" for tests. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Maximum cookie age in milliseconds. Defaults to 30 days. */
  maxAgeMs?: number;
}

/**
 * Verify a signed auth cookie value with constant-time signature comparison.
 * Returns false when the secret is empty, the token is malformed, the HMAC
 * does not match, or the cookie is older than `maxAgeMs`.
 */
export function verifyAuthCookie(
  secret: string,
  token: string | undefined | null,
  opts: VerifyAuthCookieOptions = {},
): boolean {
  if (!secret || !token) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!payload.startsWith(`${COOKIE_VERSION}.`)) return false;
  const iatStr = payload.slice(COOKIE_VERSION.length + 1);
  const iat = Number(iatStr);
  if (!Number.isFinite(iat) || !Number.isInteger(iat) || iat < 0) return false;

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (sig.length !== expected.length) return false;
  let equal: boolean;
  try {
    equal = timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
  if (!equal) return false;

  const now = opts.nowMs ?? Date.now();
  const maxAgeMs =
    opts.maxAgeMs ?? DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS * 1000;
  if (maxAgeMs > 0 && now - iat > maxAgeMs) return false;
  return true;
}

export interface BuildSetCookieOptions {
  /** Cookie max-age in seconds. Defaults to 30 days. */
  maxAgeSeconds?: number;
  /** Add the `Secure` attribute. Defaults to false (public daemon is HTTP). */
  secure?: boolean;
}

export function buildSetCookieHeader(
  value: string,
  opts: BuildSetCookieOptions = {},
): string {
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS;
  const parts = [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookieHeader(): string {
  return [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

/**
 * Classify whether a request reached the daemon over an effective HTTPS
 * channel. Either the listener itself is HTTPS (the URL scheme is `https:`),
 * or an HTTPS tunnel proxy forwarded the original scheme via
 * `X-Forwarded-Proto: https`.
 */
export function isEffectivelyHttpsRequest(req: Request): boolean {
  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch {
    // ignore malformed URLs
  }
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp && xfp.trim().toLowerCase() === "https") return true;
  return false;
}

/** Extract the auth cookie value from a request's `Cookie` header. */
export function extractAuthCookie(req: Request): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const segment of raw.split(/;\s*/)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    if (name === AUTH_COOKIE_NAME) {
      return segment.slice(eq + 1);
    }
  }
  return undefined;
}
