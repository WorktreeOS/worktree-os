import { basename } from "node:path";
import {
  buildTunnelHostname,
  type BackendProtocol,
  type TunnelRoutePolicy,
  type TunnelRouteType,
  type TunnelScheme,
  type TunnelServer,
} from "./tunnel";

/**
 * Format the public tunnel URL. The port is included only when it is not the
 * scheme default — `:80` for HTTP and `:443` for HTTPS. Pass the effective
 * public port (`tunnel.publicPort ?? tunnel.port`) here: this is the port the
 * client connects to, which may differ from the daemon's listener bind port
 * when wos sits behind a reverse proxy / NAT.
 */
export function formatTunnelUrl(
  scheme: TunnelScheme,
  hostname: string,
  port: number,
): string {
  const isDefault =
    (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
  return isDefault
    ? `${scheme}://${hostname}`
    : `${scheme}://${hostname}:${port}`;
}

/**
 * Effective public-facing port for a tunnel server: `publicPort` when set,
 * otherwise the listener bind port. URL builders MUST use this, not
 * `server.port` directly.
 */
export function effectivePublicPort(server: TunnelServer): number {
  return server.publicPort ?? server.port;
}

export interface TunnelEventPublisher {
  publishOpened(sessionName: string, snapshot: ActiveTunnelSnapshot): void;
  publishFailed(sessionName: string, snapshot: FailedTunnelSnapshot): void;
  publishClosed(
    sessionName: string,
    args: { service: string; containerPort: number },
  ): void;
  publishReset(sessionName: string): void;
  publishDropped(sessionName: string): void;
}

export type TunnelState = "active" | "failed";

export interface ActiveTunnelSnapshot {
  service: string;
  containerPort: number;
  hostPort: number;
  state: "active";
  url: string;
  hostname: string;
}

export interface FailedTunnelSnapshot {
  service: string;
  containerPort: number;
  hostPort: number;
  state: "failed";
  message: string;
}

export type TunnelSnapshot = ActiveTunnelSnapshot | FailedTunnelSnapshot;

interface ActiveRecord {
  service: string;
  containerPort: number;
  hostPort: number;
  hostname: string;
  whitelistIps: string[];
  snapshot: ActiveTunnelSnapshot;
}

interface FailedRecord {
  service: string;
  containerPort: number;
  hostPort: number;
  snapshot: FailedTunnelSnapshot;
}

interface SessionRecords {
  worktreeRoot: string;
  active: Map<string, ActiveRecord>;
  failed: Map<string, FailedRecord>;
}

export interface OpenTunnelRequest {
  worktreeRoot: string;
  service: string;
  containerPort: number;
  hostPort: number;
}

export interface RestoreTunnelRequest {
  worktreeRoot: string;
  service: string;
  containerPort: number;
  hostPort: number;
  hostname: string;
}

export interface OpenTunnelOutcome {
  snapshot: TunnelSnapshot;
}

export interface RestoreTunnelOutcome {
  snapshot: TunnelSnapshot;
}

interface DaemonRouteRecord {
  hostPort: number;
  backendProtocol: BackendProtocol;
  whitelistIps: string[];
}

function key(service: string, containerPort: number): string {
  return `${service}:${containerPort}`;
}

/**
 * Daemon-owned registry of local HTTP tunnel routes, keyed by session name.
 * Active records represent a registered route on the tunnel server. Failed
 * records describe the most recent registration failure for a service/port.
 *
 * The registry also carries route policy (route type + client IP whitelist)
 * so the tunnel server can enforce `403` before proxying upstream, and so
 * route replay onto a replacement listener after certificate rotation
 * preserves the original policy.
 */
export class TunnelRegistry {
  private readonly sessions = new Map<string, SessionRecords>();
  private readonly daemonRoutes = new Map<string, DaemonRouteRecord>();
  private servicePolicy: TunnelRoutePolicy = {
    routeType: "service",
    whitelistIps: [],
  };
  private publisher?: TunnelEventPublisher;
  private server?: TunnelServer;

  /** Attach the daemon-owned tunnel server (or clear it). */
  setServer(server: TunnelServer | undefined): void {
    this.server = server;
  }

  /** Return the active tunnel server, or undefined if tunneling is disabled. */
  getServer(): TunnelServer | undefined {
    return this.server;
  }

  /**
   * Set the default service-route policy applied to subsequently opened or
   * restored service tunnels. Existing active routes keep the policy they
   * were registered with; callers reset+reopen routes when policy changes.
   */
  setServiceRoutePolicy(whitelistIps: readonly string[]): void {
    this.servicePolicy = {
      routeType: "service",
      whitelistIps: [...whitelistIps],
    };
  }

  /** Attach an event publisher so lifecycle changes are emitted. */
  setEventPublisher(publisher: TunnelEventPublisher | undefined): void {
    this.publisher = publisher;
  }

  /**
   * Register a tunnel route. When the server is unavailable, records a
   * failed snapshot for the given service/port and emits a failed event.
   */
  async open(sessionName: string, req: OpenTunnelRequest): Promise<OpenTunnelOutcome> {
    const records = this.ensureSession(sessionName, req.worktreeRoot);
    const k = key(req.service, req.containerPort);
    records.failed.delete(k);
    const server = this.server;
    if (!server) {
      const snapshot: FailedTunnelSnapshot = {
        service: req.service,
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        state: "failed",
        message: "tunnel server is not running",
      };
      records.failed.set(k, {
        service: req.service,
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        snapshot,
      });
      this.publisher?.publishFailed(sessionName, snapshot);
      return { snapshot };
    }

    try {
      const hostname = this.allocateHostname(server, req.worktreeRoot, req.service);
      server.registerRoute({
        hostname,
        hostPort: req.hostPort,
        backendProtocol: "http",
        policy: this.servicePolicy,
      });
      const snapshot: ActiveTunnelSnapshot = {
        service: req.service,
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        state: "active",
        url: formatTunnelUrl(server.scheme, hostname, effectivePublicPort(server)),
        hostname,
      };
      records.active.set(k, {
        service: req.service,
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        hostname,
        whitelistIps: [...this.servicePolicy.whitelistIps],
        snapshot,
      });
      this.publisher?.publishOpened(sessionName, snapshot);
      return { snapshot };
    } catch (e) {
      const message = (e as Error).message || "tunnel registration failed";
      const snapshot: FailedTunnelSnapshot = {
        service: req.service,
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        state: "failed",
        message,
      };
      records.failed.set(k, {
        service: req.service,
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        snapshot,
      });
      this.publisher?.publishFailed(sessionName, snapshot);
      return { snapshot };
    }
  }

  /**
   * Restore a known tunnel hostname for a session/service/container-port/host-port
   * without allocating a new hostname. Idempotent for the same tuple. Skips
   * hostname conflicts owned by a different session/service/container-port tuple.
   */
  async restore(sessionName: string, req: RestoreTunnelRequest): Promise<RestoreTunnelOutcome> {
    const records = this.ensureSession(sessionName, req.worktreeRoot);
    const k = key(req.service, req.containerPort);
    const server = this.server;

    // Already restored with the same hostname/port → idempotent.
    const existing = records.active.get(k);
    if (existing && existing.hostname === req.hostname && existing.hostPort === req.hostPort) {
      return { snapshot: existing.snapshot };
    }

    // Hostname conflict: check if the hostname is already registered for a
    // different session/service/container-port tuple.
    for (const [otherSession, otherRecords] of this.sessions) {
      for (const [otherKey, otherActive] of otherRecords.active) {
        if (otherActive.hostname === req.hostname) {
          if (otherSession === sessionName && otherKey === k) {
            // Same session, same service/port but different record — replace it.
            break;
          }
          // Conflict: hostname belongs to a different session or service/port.
          const snapshot: FailedTunnelSnapshot = {
            service: req.service,
            containerPort: req.containerPort,
            hostPort: req.hostPort,
            state: "failed",
            message: `hostname ${req.hostname} is already registered for ${otherActive.service}:${otherActive.containerPort}`,
          };
          records.failed.set(k, {
            service: req.service,
            containerPort: req.containerPort,
            hostPort: req.hostPort,
            snapshot,
          });
          return { snapshot };
        }
      }
    }

    if (server) {
      // If a previous active record for this service/port exists with a
      // different hostname, unregister it first.
      const prevActive = records.active.get(k);
      if (prevActive && prevActive.hostname !== req.hostname) {
        server.unregisterRoute(prevActive.hostname);
        records.active.delete(k);
      }

      try {
        if (!server.hasRoute(req.hostname)) {
          server.registerRoute({
            hostname: req.hostname,
            hostPort: req.hostPort,
            backendProtocol: "http",
            policy: this.servicePolicy,
          });
        }
        const snapshot: ActiveTunnelSnapshot = {
          service: req.service,
          containerPort: req.containerPort,
          hostPort: req.hostPort,
          state: "active",
          url: formatTunnelUrl(server.scheme, req.hostname, effectivePublicPort(server)),
          hostname: req.hostname,
        };
        records.active.set(k, {
          service: req.service,
          containerPort: req.containerPort,
          hostPort: req.hostPort,
          hostname: req.hostname,
          whitelistIps: [...this.servicePolicy.whitelistIps],
          snapshot,
        });
        records.failed.delete(k);
        this.publisher?.publishOpened(sessionName, snapshot);
        return { snapshot };
      } catch (e) {
        const message = (e as Error).message || "tunnel restoration failed";
        const snapshot: FailedTunnelSnapshot = {
          service: req.service,
          containerPort: req.containerPort,
          hostPort: req.hostPort,
          state: "failed",
          message,
        };
        records.failed.set(k, {
          service: req.service,
          containerPort: req.containerPort,
          hostPort: req.hostPort,
          snapshot,
        });
        this.publisher?.publishFailed(sessionName, snapshot);
        return { snapshot };
      }
    }

    // No server → record as failed.
    const snapshot: FailedTunnelSnapshot = {
      service: req.service,
      containerPort: req.containerPort,
      hostPort: req.hostPort,
      state: "failed",
      message: "tunnel server is not running",
    };
    records.failed.set(k, {
      service: req.service,
      containerPort: req.containerPort,
      hostPort: req.hostPort,
      snapshot,
    });
    return { snapshot };
  }

  /** Snapshot tunnel records for a session. */
  snapshot(sessionName: string): TunnelSnapshot[] {
    const records = this.sessions.get(sessionName);
    if (!records) return [];
    const out: TunnelSnapshot[] = [];
    for (const r of records.active.values()) out.push(r.snapshot);
    for (const r of records.failed.values()) out.push(r.snapshot);
    out.sort((a, b) => {
      if (a.service === b.service) return a.containerPort - b.containerPort;
      return a.service < b.service ? -1 : 1;
    });
    return out;
  }

  /** Hostname map for compose template resolution: service -> port -> hostname. */
  hostnameMap(sessionName: string): Record<string, Record<string, string>> {
    const records = this.sessions.get(sessionName);
    const out: Record<string, Record<string, string>> = {};
    if (!records) return out;
    for (const r of records.active.values()) {
      const bucket = out[r.service] ?? (out[r.service] = {});
      bucket[String(r.containerPort)] = r.snapshot.hostname;
    }
    return out;
  }

  /** Full-URL map for compose template resolution: service -> port -> url. */
  urlMap(sessionName: string): Record<string, Record<string, string>> {
    const records = this.sessions.get(sessionName);
    const out: Record<string, Record<string, string>> = {};
    if (!records) return out;
    for (const r of records.active.values()) {
      const bucket = out[r.service] ?? (out[r.service] = {});
      bucket[String(r.containerPort)] = r.snapshot.url;
    }
    return out;
  }

  /** Unregister all active routes for the session and clear failed records. */
  async reset(sessionName: string): Promise<void> {
    const records = this.sessions.get(sessionName);
    if (!records) return;
    for (const r of records.active.values()) {
      this.server?.unregisterRoute(r.hostname);
    }
    records.active.clear();
    records.failed.clear();
    this.publisher?.publishReset(sessionName);
  }

  /** Unregister all active routes for the session and drop the session record. */
  async drop(sessionName: string): Promise<void> {
    const records = this.sessions.get(sessionName);
    if (!records) return;
    this.sessions.delete(sessionName);
    for (const r of records.active.values()) {
      this.server?.unregisterRoute(r.hostname);
    }
    this.publisher?.publishDropped(sessionName);
  }

  /** Unregister one tunnel by service/port. Used by port-conflict retry. */
  async closeOne(sessionName: string, service: string, containerPort: number): Promise<void> {
    const records = this.sessions.get(sessionName);
    if (!records) return;
    const k = key(service, containerPort);
    const active = records.active.get(k);
    if (active) {
      records.active.delete(k);
      this.server?.unregisterRoute(active.hostname);
      this.publisher?.publishClosed(sessionName, { service, containerPort });
    }
    records.failed.delete(k);
  }

  /**
   * Register a daemon-scoped tunnel route that is not associated with any
   * session. Used for publishing the daemon Web UI through the tunnel server.
   * The route is independent of `reset/drop` calls and is removed only when
   * explicitly unregistered or at `shutdown`.
   */
  registerDaemonRoute(opts: {
    hostname: string;
    hostPort: number;
    backendProtocol?: BackendProtocol;
    routeType: TunnelRouteType;
    whitelistIps?: readonly string[];
  }): { ok: true } | { ok: false; reason: string } {
    const server = this.server;
    if (!server) return { ok: false, reason: "tunnel server is not running" };
    if (server.hasRoute(opts.hostname)) {
      return {
        ok: false,
        reason: `hostname ${opts.hostname} is already registered`,
      };
    }
    const whitelist = [...(opts.whitelistIps ?? [])];
    const backendProtocol: BackendProtocol = opts.backendProtocol ?? "http";
    try {
      server.registerRoute({
        hostname: opts.hostname,
        hostPort: opts.hostPort,
        backendProtocol,
        policy: {
          routeType: opts.routeType,
          whitelistIps: whitelist,
        },
      });
      this.daemonRoutes.set(opts.hostname, {
        hostPort: opts.hostPort,
        backendProtocol,
        whitelistIps: whitelist,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** Unregister a daemon-scoped tunnel route by hostname. No-op when missing. */
  unregisterDaemonRoute(hostname: string): void {
    this.server?.unregisterRoute(hostname);
    this.daemonRoutes.delete(hostname);
  }

  /** True when a daemon-scoped route exists for `hostname`. */
  hasDaemonRoute(hostname: string): boolean {
    return this.daemonRoutes.has(hostname);
  }

  /**
   * Snapshot every active app route across sessions and every daemon-scoped
   * route, enough to replay them onto a replacement tunnel server after a
   * certificate rotation. Each entry carries the route policy so the
   * replacement listener preserves IP whitelist enforcement.
   */
  routeReplaySnapshot(): {
    app: {
      sessionName: string;
      worktreeRoot: string;
      service: string;
      containerPort: number;
      hostPort: number;
      hostname: string;
      whitelistIps: string[];
    }[];
    daemon: {
      hostname: string;
      hostPort: number;
      backendProtocol: BackendProtocol;
      whitelistIps: string[];
    }[];
  } {
    const app: {
      sessionName: string;
      worktreeRoot: string;
      service: string;
      containerPort: number;
      hostPort: number;
      hostname: string;
      whitelistIps: string[];
    }[] = [];
    for (const [sessionName, records] of this.sessions) {
      for (const r of records.active.values()) {
        app.push({
          sessionName,
          worktreeRoot: records.worktreeRoot,
          service: r.service,
          containerPort: r.containerPort,
          hostPort: r.hostPort,
          hostname: r.hostname,
          whitelistIps: [...r.whitelistIps],
        });
      }
    }
    const daemon: {
      hostname: string;
      hostPort: number;
      backendProtocol: BackendProtocol;
      whitelistIps: string[];
    }[] = [];
    for (const [hostname, record] of this.daemonRoutes) {
      daemon.push({
        hostname,
        hostPort: record.hostPort,
        backendProtocol: record.backendProtocol,
        whitelistIps: [...record.whitelistIps],
      });
    }
    return { app, daemon };
  }

  /**
   * Replay the snapshot returned by `routeReplaySnapshot()` onto the currently
   * attached tunnel server. Used when the daemon swaps a tunnel listener after
   * a certificate renewal — the new server must learn every route the old one
   * carried, with the same policy, before the old one is stopped.
   *
   * Returns the per-route registration result so the caller can publish
   * tunnel failure events for any route that could not be replayed.
   */
  replayRoutes(snapshot: ReturnType<TunnelRegistry["routeReplaySnapshot"]>): {
    appFailures: { hostname: string; reason: string }[];
    daemonFailures: { hostname: string; reason: string }[];
  } {
    const server = this.server;
    const appFailures: { hostname: string; reason: string }[] = [];
    const daemonFailures: { hostname: string; reason: string }[] = [];
    if (!server) {
      for (const r of snapshot.app) {
        appFailures.push({ hostname: r.hostname, reason: "tunnel server is not running" });
      }
      for (const r of snapshot.daemon) {
        daemonFailures.push({ hostname: r.hostname, reason: "tunnel server is not running" });
      }
      return { appFailures, daemonFailures };
    }
    for (const r of snapshot.app) {
      try {
        if (!server.hasRoute(r.hostname)) {
          server.registerRoute({
            hostname: r.hostname,
            hostPort: r.hostPort,
            backendProtocol: "http",
            policy: { routeType: "service", whitelistIps: [...r.whitelistIps] },
          });
        }
      } catch (e) {
        appFailures.push({ hostname: r.hostname, reason: (e as Error).message });
      }
    }
    for (const r of snapshot.daemon) {
      try {
        if (!server.hasRoute(r.hostname)) {
          server.registerRoute({
            hostname: r.hostname,
            hostPort: r.hostPort,
            backendProtocol: r.backendProtocol,
            policy: { routeType: "daemon-web-ui", whitelistIps: [...r.whitelistIps] },
          });
        }
        this.daemonRoutes.set(r.hostname, {
          hostPort: r.hostPort,
          backendProtocol: r.backendProtocol,
          whitelistIps: [...r.whitelistIps],
        });
      } catch (e) {
        daemonFailures.push({ hostname: r.hostname, reason: (e as Error).message });
      }
    }
    return { appFailures, daemonFailures };
  }

  /**
   * Unregister every route across every session and stop the owned tunnel
   * server. Used by daemon shutdown.
   */
  async shutdown(): Promise<void> {
    const server = this.server;
    for (const records of this.sessions.values()) {
      for (const r of records.active.values()) {
        server?.unregisterRoute(r.hostname);
      }
    }
    for (const hostname of this.daemonRoutes.keys()) {
      server?.unregisterRoute(hostname);
    }
    this.daemonRoutes.clear();
    this.sessions.clear();
    if (server) {
      this.server = undefined;
      await server.stop();
    }
  }

  /**
   * Allocate an unused hostname for a worktree/service pair. Tries
   * `{worktree}-{service}.{domain}`; on conflict, increments the worktree
   * suffix to `2`, `3`, ... until an unused hostname is found. Returns the
   * chosen hostname.
   */
  private allocateHostname(
    server: TunnelServer,
    worktreeRoot: string,
    serviceName: string,
  ): string {
    const worktreeName = basename(worktreeRoot);
    let suffix: number | undefined;
    for (let i = 0; i < 10_000; i += 1) {
      const candidate = buildTunnelHostname({
        worktreeName,
        serviceName,
        domain: server.domain,
        suffix,
      });
      if (!server.hasRoute(candidate)) return candidate;
      suffix = (suffix ?? 1) + 1;
    }
    throw new Error("tunnel hostname allocation exhausted");
  }

  private ensureSession(sessionName: string, worktreeRoot: string): SessionRecords {
    let s = this.sessions.get(sessionName);
    if (!s) {
      s = { worktreeRoot, active: new Map(), failed: new Map() };
      this.sessions.set(sessionName, s);
    } else {
      s.worktreeRoot = worktreeRoot;
    }
    return s;
  }
}
