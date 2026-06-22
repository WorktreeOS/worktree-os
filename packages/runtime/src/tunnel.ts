/**
 * Daemon-owned local HTTP tunnel server abstraction.
 *
 * Responsibilities:
 * - Bind a single HTTP listener (typically `0.0.0.0:<port>`).
 * - Maintain a map from normalized request `Host` header to a registered
 *   local backend host port + route policy.
 * - Enforce route policy (currently exact-IP client whitelist) before
 *   proxying upstream.
 * - Proxy incoming HTTP requests by `Host` header to `127.0.0.1:<hostPort>`.
 * - Return a not-found response when no route matches.
 */

export type BackendProtocol = "http" | "https";
export type TunnelScheme = "http" | "https";

/**
 * Route classification used by lifecycle, restore metadata, and proxy policy
 * enforcement. `service` routes belong to a deployment; `daemon-web-ui` is the
 * single daemon-scoped route that publishes the management Web UI.
 */
export type TunnelRouteType = "service" | "daemon-web-ui";

export interface TunnelRoutePolicy {
  routeType: TunnelRouteType;
  /** Exact client IPs allowed through. Empty list = allow all. */
  whitelistIps: string[];
}

export interface TunnelRoute {
  hostname: string;
  hostPort: number;
  /** Defaults to `http` when omitted. */
  backendProtocol?: BackendProtocol;
  policy: TunnelRoutePolicy;
}

export interface TunnelServer {
  /** Configured tunnel domain (used for hostname generation). */
  readonly domain: string;
  /** Listener bind port (where the tunnel server actually listens). */
  readonly port: number;
  /**
   * Port advertised in tunnel URLs. Undefined when the user did not configure
   * `tunnel.publicPort`; URL builders treat undefined as "use `port`".
   */
  readonly publicPort?: number;
  /** Effective public listener scheme — `http` or `https`. */
  readonly scheme: TunnelScheme;
  /**
   * Register a route. Throws if `hostname` is already taken (caller resolves
   * conflicts before calling — see `TunnelRegistry.allocateHostname`).
   */
  registerRoute(route: TunnelRoute): void;
  /** Unregister a route by hostname. No-op when missing. */
  unregisterRoute(hostname: string): void;
  /** True when no other route owns `hostname`. */
  hasRoute(hostname: string): boolean;
  /** Stop the server and clear all routes. */
  stop(): Promise<void>;
}

export interface TunnelTlsOptions {
  cert: string;
  key: string;
}

export interface StartTunnelServerOptions {
  port: number;
  /**
   * Public-facing port used by URL builders. When omitted, URLs use `port`.
   * Set this when wos sits behind a reverse proxy / NAT that exposes the
   * tunnel on a different port than the listener bind port.
   */
  publicPort?: number;
  domain: string;
  hostname?: string;
  /** When provided, the tunnel listener terminates TLS using this material. */
  tls?: TunnelTlsOptions;
}

const NOT_FOUND_BODY = "tunnel: no route for host\n";
const FORBIDDEN_BODY = "tunnel: forbidden\n";

// RFC 7230 §6.1 — connection-specific headers that must not be forwarded through a proxy.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

/**
 * Sanitize a DNS label: lowercase, replace any non `[a-z0-9-]` with `-`,
 * collapse repeated dashes, trim leading/trailing dashes. Returns the
 * `fallback` when the result is empty.
 */
export function sanitizeDnsLabel(input: string, fallback: string): string {
  const lowered = input.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : fallback;
}

export interface BuildHostnameOptions {
  worktreeName: string;
  serviceName: string;
  domain: string;
  suffix?: number;
}

/** Build the base hostname `{worktree}{suffix?}-{service}.{domain}`. */
export function buildTunnelHostname(opts: BuildHostnameOptions): string {
  const wt = sanitizeDnsLabel(opts.worktreeName, "worktree");
  const svc = sanitizeDnsLabel(opts.serviceName, "service");
  const labelWithSuffix = opts.suffix && opts.suffix >= 2 ? `${wt}${opts.suffix}` : wt;
  return `${labelWithSuffix}-${svc}.${opts.domain}`;
}

/** Normalize a request `Host` header value to a lowercased hostname (no port). */
export function normalizeHostHeader(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim().toLowerCase();
  const colon = trimmed.indexOf(":");
  const host = colon === -1 ? trimmed : trimmed.slice(0, colon);
  return host;
}

/**
 * Normalize an IP address for whitelist comparison. Bun's `server.requestIP`
 * returns the raw socket address — including IPv4-mapped IPv6 forms like
 * `::ffff:127.0.0.1`. Returns the canonical IPv4 form when the input is a
 * mapped address; otherwise lowercases IPv6 literals.
 */
function normalizeClientIp(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const lower = trimmed.toLowerCase();
  // IPv4-mapped IPv6 form: `::ffff:1.2.3.4` → `1.2.3.4`.
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return mapped[1]!;
  return lower;
}

/**
 * Check whether a client IP is allowed by a whitelist policy. An empty
 * whitelist means allow all; otherwise the client IP must exactly match an
 * entry (after IPv4-mapped IPv6 normalization).
 */
export function isClientIpAllowed(
  clientIp: string | undefined | null,
  whitelistIps: readonly string[],
): boolean {
  if (whitelistIps.length === 0) return true;
  const normalized = normalizeClientIp(clientIp);
  if (normalized.length === 0) return false;
  for (const entry of whitelistIps) {
    if (normalizeClientIp(entry) === normalized) return true;
  }
  return false;
}

interface TunnelWsProxyData {
  kind: "ws-proxy";
  upstream: WebSocket;
}

/**
 * Start a daemon-owned local HTTP tunnel server. Returns a `TunnelServer`
 * handle for route management.
 */
export async function startTunnelServer(
  opts: StartTunnelServerOptions,
): Promise<TunnelServer> {
  interface RouteRecord {
    hostPort: number;
    backendProtocol: BackendProtocol;
    policy: TunnelRoutePolicy;
  }
  const routes = new Map<string, RouteRecord>();
  const hostname = opts.hostname ?? "0.0.0.0";
  const scheme: TunnelScheme = opts.tls ? "https" : "http";

  type ServeOpts = Parameters<typeof Bun.serve<TunnelWsProxyData>>[0] & {
    tls?: { cert: string; key: string };
  };
  const serveOpts: ServeOpts = {
    hostname,
    port: opts.port,
    development: false,
    // WebSocket-bridged sessions (e.g. terminal attach) can sit idle for long
    // stretches; rely on Bun's automatic PINGs and disable idle timeouts so
    // the proxy never tears the bridge down on its own.
    idleTimeout: 0,
    fetch: async (req: Request, srv?: import("bun").Server<TunnelWsProxyData>) => {
      const host = normalizeHostHeader(req.headers.get("host"));
      const route = routes.get(host);
      if (!route) {
        return new Response(NOT_FOUND_BODY, {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
      }
      const { hostPort, backendProtocol, policy } = route;

      // IP whitelist enforcement: reject with 403 before any upstream proxying.
      if (policy.whitelistIps.length > 0) {
        const clientIp = srv ? srv.requestIP(req)?.address : undefined;
        if (!isClientIpAllowed(clientIp ?? undefined, policy.whitelistIps)) {
          return new Response(FORBIDDEN_BODY, {
            status: 403,
            headers: { "content-type": "text/plain" },
          });
        }
      }

      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        return proxyWebSocketUpgrade(req, srv, host, hostPort, backendProtocol, scheme);
      }

      const url = new URL(req.url);
      const target = `${backendProtocol}://127.0.0.1:${hostPort}${url.pathname}${url.search}`;
      const forwardHeaders = new Headers(req.headers);
      for (const name of HOP_BY_HOP_HEADERS) forwardHeaders.delete(name);
      forwardHeaders.set("host", `127.0.0.1:${hostPort}`);
      forwardHeaders.set("x-forwarded-host", host);
      forwardHeaders.set("x-forwarded-proto", scheme);
      try {
        // Backend is always loopback (`127.0.0.1`). When the route's backend
        // protocol is HTTPS the daemon owns the upstream listener and its
        // certificate is typically self-signed (the generated cert under
        // `<wos-home>/certs`), so default TLS verification rejects it.
        // Disabling verification is safe here because the target is hard-coded
        // to loopback and the upstream listener is the same daemon process.
        const fetchOpts: Parameters<typeof fetch>[1] & {
          tls?: { rejectUnauthorized: boolean };
        } = {
          method: req.method,
          headers: forwardHeaders,
          body: methodHasBody(req.method) ? req.body : undefined,
          redirect: "manual",
        };
        if (backendProtocol === "https") {
          fetchOpts.tls = { rejectUnauthorized: false };
        }
        const upstream = await fetch(target, fetchOpts);
        const responseHeaders = new Headers(upstream.headers);
        // `fetch` already decompressed the body — content-encoding/length no longer match,
        // and hop-by-hop headers must not be forwarded through a proxy.
        for (const name of HOP_BY_HOP_HEADERS) responseHeaders.delete(name);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      } catch (e) {
        return new Response(`tunnel: upstream error (${(e as Error).message})\n`, {
          status: 502,
          headers: { "content-type": "text/plain" },
        });
      }
    },
    websocket: {
      idleTimeout: 0,
      open(client: import("bun").ServerWebSocket<TunnelWsProxyData>) {
        const { upstream } = client.data;
        upstream.binaryType = "arraybuffer";
        upstream.addEventListener("message", (ev: MessageEvent) => {
          const data = ev.data;
          try {
            if (typeof data === "string") {
              client.send(data);
            } else if (data instanceof ArrayBuffer) {
              client.send(new Uint8Array(data));
            } else if (ArrayBuffer.isView(data)) {
              client.send(
                new Uint8Array(
                  data.buffer,
                  data.byteOffset,
                  data.byteLength,
                ),
              );
            }
          } catch {
            /* peer closed */
          }
        });
        upstream.addEventListener("close", (ev: CloseEvent) => {
          try {
            client.close(ev.code || 1000, ev.reason || "");
          } catch {
            /* already closed */
          }
        });
        upstream.addEventListener("error", () => {
          try {
            client.close(1011, "upstream error");
          } catch {
            /* already closed */
          }
        });
      },
      message(
        client: import("bun").ServerWebSocket<TunnelWsProxyData>,
        msg: string | Buffer,
      ) {
        const { upstream } = client.data;
        if (upstream.readyState !== WebSocket.OPEN) return;
        try {
          if (typeof msg === "string") {
            upstream.send(msg);
          } else {
            // Bun ServerWebSocket delivers binary as Buffer; forward as
            // ArrayBuffer view so the upstream WebSocket sends a binary frame.
            upstream.send(
              msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength),
            );
          }
        } catch {
          /* upstream may be mid-close */
        }
      },
      close(
        client: import("bun").ServerWebSocket<TunnelWsProxyData>,
        code: number,
        reason: string,
      ) {
        const { upstream } = client.data;
        if (
          upstream.readyState === WebSocket.OPEN ||
          upstream.readyState === WebSocket.CONNECTING
        ) {
          try {
            upstream.close(code || 1000, reason || "");
          } catch {
            /* already closed */
          }
        }
      },
    },
  };
  if (opts.tls) {
    serveOpts.tls = { cert: opts.tls.cert, key: opts.tls.key };
  }
  const server = Bun.serve<TunnelWsProxyData>(serveOpts);

  return {
    domain: opts.domain,
    port: server.port ?? opts.port,
    ...(opts.publicPort !== undefined ? { publicPort: opts.publicPort } : {}),
    scheme,
    registerRoute(route: TunnelRoute) {
      const host = normalizeHostHeader(route.hostname);
      if (routes.has(host)) {
        throw new Error(`tunnel hostname already registered: ${host}`);
      }
      routes.set(host, {
        hostPort: route.hostPort,
        backendProtocol: route.backendProtocol ?? "http",
        policy: {
          routeType: route.policy.routeType,
          whitelistIps: [...route.policy.whitelistIps],
        },
      });
    },
    unregisterRoute(hostname: string) {
      const host = normalizeHostHeader(hostname);
      routes.delete(host);
    },
    hasRoute(hostname: string) {
      return routes.has(normalizeHostHeader(hostname));
    },
    async stop() {
      routes.clear();
      try {
        server.stop(true);
      } catch {
        /* ignore */
      }
    },
  };
}

function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

/**
 * Bridge a WebSocket upgrade through the tunnel. Opens an upstream WebSocket
 * client to `127.0.0.1:<hostPort>` first so we can negotiate the subprotocol
 * before responding to the browser; then calls `server.upgrade` and stashes
 * the upstream socket on the connection data. The websocket handlers wire
 * frames in both directions.
 */
async function proxyWebSocketUpgrade(
  req: Request,
  srv: import("bun").Server<TunnelWsProxyData> | undefined,
  host: string,
  hostPort: number,
  backendProtocol: BackendProtocol,
  externalScheme: TunnelScheme,
): Promise<Response> {
  if (!srv) {
    return new Response("tunnel: websocket upgrade not available\n", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }
  const url = new URL(req.url);
  const wsScheme = backendProtocol === "https" ? "wss" : "ws";
  const upstreamUrl = `${wsScheme}://127.0.0.1:${hostPort}${url.pathname}${url.search}`;

  const reqProtocol = req.headers.get("sec-websocket-protocol");
  const subprotocols = reqProtocol
    ? reqProtocol
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  const upstreamHeaders: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) upstreamHeaders["cookie"] = cookie;
  const userAgent = req.headers.get("user-agent");
  if (userAgent) upstreamHeaders["user-agent"] = userAgent;
  upstreamHeaders["x-forwarded-host"] = host;
  upstreamHeaders["x-forwarded-proto"] = externalScheme;

  let upstream: WebSocket;
  try {
    // Bun extends the WebSocket constructor with an options bag (headers,
    // protocols, tls) — used here to forward the auth cookie and X-Forwarded-*
    // into the daemon's upgrade handler. For loopback WSS backends (the
    // daemon's own self-signed HTTPS Web UI), TLS verification must be
    // disabled — see the matching note in the HTTP proxy path.
    const WS = globalThis.WebSocket as unknown as new (
      url: string,
      options: {
        headers?: Record<string, string>;
        protocols?: string[];
        tls?: { rejectUnauthorized: boolean };
      },
    ) => WebSocket;
    const wsOpts: {
      headers: Record<string, string>;
      protocols?: string[];
      tls?: { rejectUnauthorized: boolean };
    } = {
      headers: upstreamHeaders,
    };
    if (subprotocols && subprotocols.length > 0) {
      wsOpts.protocols = subprotocols;
    }
    if (backendProtocol === "https") {
      wsOpts.tls = { rejectUnauthorized: false };
    }
    upstream = new WS(upstreamUrl, wsOpts);
  } catch (e) {
    return new Response(
      `tunnel: upstream websocket failed (${(e as Error).message})\n`,
      { status: 502, headers: { "content-type": "text/plain" } },
    );
  }

  const opened = await new Promise<
    { ok: true } | { ok: false; status: number; reason: string }
  >((resolve) => {
    const cleanup = () => {
      upstream.removeEventListener("open", onOpen);
      upstream.removeEventListener("error", onError as EventListener);
      upstream.removeEventListener("close", onClose as EventListener);
    };
    const onOpen = () => {
      cleanup();
      resolve({ ok: true });
    };
    const onError = () => {
      cleanup();
      resolve({ ok: false, status: 502, reason: "upstream connection error" });
    };
    const onClose = (ev: CloseEvent) => {
      cleanup();
      resolve({
        ok: false,
        status: 502,
        reason: `upstream closed before open (${ev.code})`,
      });
    };
    upstream.addEventListener("open", onOpen);
    upstream.addEventListener("error", onError as EventListener);
    upstream.addEventListener("close", onClose as EventListener);
  });

  if (!opened.ok) {
    try {
      upstream.close();
    } catch {
      /* ignore */
    }
    return new Response(`tunnel: ${opened.reason}\n`, {
      status: opened.status,
      headers: { "content-type": "text/plain" },
    });
  }

  const chosenProtocol = upstream.protocol;
  const upgradeHeaders: Record<string, string> = {};
  if (chosenProtocol) {
    upgradeHeaders["sec-websocket-protocol"] = chosenProtocol;
  }
  const data: TunnelWsProxyData = { kind: "ws-proxy", upstream };
  const ok = srv.upgrade(req, {
    data,
    headers:
      Object.keys(upgradeHeaders).length > 0 ? upgradeHeaders : undefined,
  });
  if (ok) {
    // Bun's contract: returning `undefined` from `fetch` after a successful
    // upgrade signals the response is owned by the WebSocket. The cast keeps
    // the `Promise<Response>` return type consistent with the rest of `fetch`.
    return undefined as unknown as Response;
  }
  try {
    upstream.close();
  } catch {
    /* ignore */
  }
  return new Response("tunnel: websocket upgrade rejected\n", {
    status: 400,
    headers: { "content-type": "text/plain" },
  });
}
