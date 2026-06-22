import type { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { TunnelServer } from "@worktreeos/runtime/tunnel";

export interface WebListenerHandle {
  /** Stop the listener (free the port). */
  stop: () => Promise<void>;
}

export interface RotateWebListenerOptions<H extends WebListenerHandle> {
  /** Current listener handle. */
  current: H;
  /** Factory that binds a new listener with the supplied TLS material. */
  start: (tls: { cert: string; key: string }) => Promise<H>;
  /** Renewed TLS material. */
  material: { cert: string; key: string };
}

export interface RotateWebListenerResult<H extends WebListenerHandle> {
  ok: true;
  handle: H;
}

export interface RotateWebListenerFailure {
  ok: false;
  message: string;
}

/**
 * Rotate the Web UI listener: stop the existing listener, bind a replacement
 * with the renewed TLS material, and return the new handle. If the bind fails
 * the previous listener is left running so the daemon process keeps serving.
 */
export async function rotateWebListener<H extends WebListenerHandle>(
  opts: RotateWebListenerOptions<H>,
): Promise<RotateWebListenerResult<H> | RotateWebListenerFailure> {
  // Stop old first; Bun does not allow two listeners on the same port.
  try {
    await opts.current.stop();
  } catch (e) {
    return { ok: false, message: `failed to stop existing listener: ${(e as Error).message}` };
  }
  try {
    const replacement = await opts.start(opts.material);
    return { ok: true, handle: replacement };
  } catch (e) {
    return {
      ok: false,
      message: `failed to bind replacement listener: ${(e as Error).message}`,
    };
  }
}

export interface RotateTunnelListenerOptions {
  registry: TunnelRegistry;
  /** Bind a replacement tunnel server using the supplied TLS material. */
  start: (tls: { cert: string; key: string }) => Promise<TunnelServer>;
  material: { cert: string; key: string };
  /** Publish per-route replay failures so UI clients see the breakage. */
  onAppRouteFailure?: (hostname: string, reason: string) => void;
  onDaemonRouteFailure?: (hostname: string, reason: string) => void;
}

export interface RotateTunnelListenerResult {
  ok: boolean;
  message?: string;
  appFailures: { hostname: string; reason: string }[];
  daemonFailures: { hostname: string; reason: string }[];
}

/**
 * Rotate the tunnel listener: snapshot every registered route, stop the old
 * server, start a replacement with the new TLS material, and replay every
 * route onto the replacement. Replay failures are reported but do not abort
 * the rotation — the daemon keeps the replacement listener so the rest of the
 * routes keep working.
 */
export async function rotateTunnelListener(
  opts: RotateTunnelListenerOptions,
): Promise<RotateTunnelListenerResult> {
  const snapshot = opts.registry.routeReplaySnapshot();
  const old = opts.registry.getServer();
  opts.registry.setServer(undefined);
  try {
    if (old) await old.stop();
  } catch (e) {
    return {
      ok: false,
      message: `failed to stop existing tunnel listener: ${(e as Error).message}`,
      appFailures: [],
      daemonFailures: [],
    };
  }
  let replacement: TunnelServer;
  try {
    replacement = await opts.start(opts.material);
  } catch (e) {
    return {
      ok: false,
      message: `failed to bind replacement tunnel listener: ${(e as Error).message}`,
      appFailures: [],
      daemonFailures: [],
    };
  }
  opts.registry.setServer(replacement);
  const replay = opts.registry.replayRoutes(snapshot);
  for (const f of replay.appFailures) opts.onAppRouteFailure?.(f.hostname, f.reason);
  for (const f of replay.daemonFailures) opts.onDaemonRouteFailure?.(f.hostname, f.reason);
  return {
    ok: true,
    appFailures: replay.appFailures,
    daemonFailures: replay.daemonFailures,
  };
}
