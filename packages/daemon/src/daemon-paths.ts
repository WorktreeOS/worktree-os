import { resolve } from "node:path";
import { wosHome } from "@worktreeos/core/paths";

export const DAEMON_METADATA_FILENAME = "daemon.json";

export function daemonMetadataPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), DAEMON_METADATA_FILENAME);
}

/**
 * HTTP-oriented daemon discovery metadata written to `<wos-home>/daemon.json`
 * after the management listener is bound. Socket-era files may still contain a
 * `socketPath` field — readers tolerate and ignore it.
 */
export interface DaemonMetadata {
  pid: number;
  startedAt: string;
  protocol: string;
  /** Fresh identifier per daemon startup (distinguishes restart from stale metadata). */
  daemonId: string;
  /** Client-facing URL of the daemon HTTP listener (loopback-mapped for wildcard binds). */
  webUrl: string;
  /** Actual bind host of the listener (e.g. `127.0.0.1` or `0.0.0.0`). */
  webHost: string;
  /** Bound listener port. */
  webPort: number;
  /** Listener scheme. */
  webScheme: "http" | "https";
  /** Legacy socket-era field; tolerated on read, never written. */
  socketPath?: string;
}
