import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readState, type WosState } from "@worktreeos/core/state";
import {
  wosHome,
  sessionNameForWorktree,
  SESSION_STATE_FILENAME,
  SESSIONS_DIRNAME,
} from "@worktreeos/core/paths";
import { readdir, stat } from "node:fs/promises";
import {
  composePs,
  defaultDockerRunner,
  type ComposeContext,
  type DockerRunner,
} from "@worktreeos/compose/compose";
import { parseComposePs, type ServiceStatus } from "@worktreeos/compose/ps";
import { listSessionServices } from "./docker/docker-cache-adapter";
import type { DockerStateStore } from "./docker/docker-state-store";
import type { TunnelRegistry, RestoreTunnelRequest } from "@worktreeos/runtime/tunnel-registry";
import {
  WOS_LABEL_DEPLOYMENT_ID,
  WOS_LABEL_HOME_HASH,
  WOS_LABEL_MANAGED,
  WOS_LABEL_MODE,
  WOS_LABEL_PROJECT,
  WOS_LABEL_SCHEMA,
  WOS_LABEL_SERVICE,
  WOS_LABEL_SESSION,
  WOS_LABEL_TUNNEL_PORTS,
  stableWosHomeHash,
  tunnelHostnameLabelKey,
  tunnelHostPortLabelKey,
} from "@worktreeos/core/tunnel-metadata";

export interface TunnelRestorationOptions {
  env?: NodeJS.ProcessEnv;
  sessionsDir?: string;
  readStateFn?: typeof readState;
  dockerRunner?: DockerRunner;
  /**
   * Daemon Docker state cache. When provided, tunnel candidates are validated
   * against current Docker container state from the cache (after a forced sync)
   * instead of running `docker compose ps`. When omitted, the Compose status
   * path is used.
   */
  dockerState?: DockerStateStore;
  warn?: (msg: string) => void;
}

export interface TunnelRestorationResult {
  restored: number;
  skipped: number;
}

/**
 * Scan `<wos-home>/sessions/*` for initialized wos deployments with
 * tunnel restore labels in their Compose artifacts and restore active local
 * HTTP tunnel routes. Stale, invalid, or unconfirmed candidates are skipped
 * without failing daemon startup.
 */
export async function restoreTunnelsFromSessions(
  tunnels: TunnelRegistry,
  opts: TunnelRestorationOptions = {},
): Promise<TunnelRestorationResult> {
  const env = opts.env ?? process.env;
  const sessionsDir =
    opts.sessionsDir ?? resolve(wosHome(env), SESSIONS_DIRNAME);
  const readStateFn = opts.readStateFn ?? readState;
  const dockerRunner = opts.dockerRunner ?? defaultDockerRunner;
  const warn = opts.warn;

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return { restored: 0, skipped: 0 };
  }

  // Ensure the Docker state cache reflects current containers before we use it
  // to validate restore candidates. Tunnel restoration is a one-time startup
  // step, so a single full sync is cheap and avoids racing the initial sync.
  if (opts.dockerState) {
    await opts.dockerState.syncNow();
  }

  let restored = 0;
  let skipped = 0;

  for (const name of entries) {
    const sessionRoot = resolve(sessionsDir, name);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(sessionRoot);
    } catch {
      skipped += 1;
      continue;
    }
    if (!st.isDirectory()) {
      skipped += 1;
      continue;
    }

    let state: WosState | null = null;
    try {
      state = await readStateFn(resolve(sessionRoot, SESSION_STATE_FILENAME));
    } catch {
      state = null;
    }

    if (
      !state ||
      !state.initialized ||
      typeof state.projectName !== "string" ||
      typeof state.composeFile !== "string" ||
      typeof state.worktreeRoot !== "string" ||
      !state.deploymentId
    ) {
      skipped += 1;
      continue;
    }

    const worktreeRoot = state.worktreeRoot;

    // Collect wos restore labels from Compose artifacts.
    const candidates = collectRestoreCandidates(state);
    if (candidates.length === 0) {
      skipped += 1;
      continue;
    }

    // Validate wos home hash against current daemon home.
    const expectedHomeHash = stableWosHomeHash(env);
    if (candidates[0]!.homeHash !== expectedHomeHash) {
      warn?.(
        `wos daemon: skipping tunnel restoration for ${name}: wos home hash mismatch`,
      );
      skipped += 1;
      continue;
    }

    // Validate session name.
    const expectedSessionName = sessionNameForWorktree(worktreeRoot);
    if (candidates[0]!.sessionName !== expectedSessionName) {
      warn?.(
        `wos daemon: skipping tunnel restoration for ${name}: session name mismatch`,
      );
      skipped += 1;
      continue;
    }

    // Validate project name and deployment id.
    if (candidates[0]!.projectName !== state.projectName) {
      warn?.(
        `wos daemon: skipping tunnel restoration for ${name}: project name mismatch`,
      );
      skipped += 1;
      continue;
    }
    if (candidates[0]!.deploymentId !== state.deploymentId) {
      warn?.(
        `wos daemon: skipping tunnel restoration for ${name}: deployment id mismatch`,
      );
      skipped += 1;
      continue;
    }

    // Resolve current running services and port bindings. Prefer the Docker
    // state cache; fall back to `docker compose ps` when no cache is provided.
    let psServices: ServiceStatus[];
    if (opts.dockerState) {
      psServices = listSessionServices(opts.dockerState, {
        sessionName: candidates[0]!.sessionName,
      });
    } else {
      const composeContext: ComposeContext = {
        projectName: state.projectName,
        composeFile: state.composeFile,
        composeFiles: state.composeFiles,
      };
      try {
        const psOutput = await composePs(composeContext, dockerRunner);
        psServices = parseComposePs(psOutput);
      } catch (e) {
        warn?.(
          `wos daemon: failed to query docker compose ps for ${name}: ${(e as Error).message}`,
        );
        skipped += 1;
        continue;
      }
    }

    let sessionRestored = 0;
    for (const candidate of candidates) {
      const psService = psServices.find((s) => s.service === candidate.service);
      if (!psService) {
        warn?.(
          `wos daemon: skipping tunnel for ${name}/${candidate.service}: not found in docker compose ps`,
        );
        continue;
      }

      const stateStr = psService.state.toLowerCase();
      if (!stateStr.includes("up") && !stateStr.includes("running")) {
        warn?.(
          `wos daemon: skipping tunnel for ${name}/${candidate.service}: container not running (state=${psService.state})`,
        );
        continue;
      }

      for (const port of candidate.tunnelPorts) {
        const hostname = candidate.hostnames[port];
        const expectedHostPort = candidate.hostPorts[port];
        if (!hostname || expectedHostPort === undefined) continue;

        const portMapping = psService.ports.find(
          (p) =>
            p.containerPort === port && p.hostPort === expectedHostPort,
        );
        if (!portMapping) {
          warn?.(
            `wos daemon: skipping tunnel for ${name}/${candidate.service}:${port}: port not published on host port ${expectedHostPort}`,
          );
          continue;
        }

        try {
          const outcome = await tunnels.restore(name, {
            worktreeRoot,
            service: candidate.service,
            containerPort: port,
            hostPort: expectedHostPort,
            hostname,
          } satisfies RestoreTunnelRequest);
          if (outcome.snapshot.state === "active") {
            sessionRestored += 1;
          }
        } catch (e) {
          warn?.(
            `wos daemon: failed to restore tunnel for ${name}/${candidate.service}:${port}: ${(e as Error).message}`,
          );
        }
      }
    }

    if (sessionRestored > 0) restored += sessionRestored;
    else skipped += 1;
  }

  return { restored, skipped };
}

interface RestoreCandidate {
  homeHash: string;
  sessionName: string;
  projectName: string;
  deploymentId: string;
  service: string;
  tunnelPorts: number[];
  hostnames: Record<number, string>;
  hostPorts: Record<number, number>;
}

function collectRestoreCandidates(state: WosState): RestoreCandidate[] {
  const composeFiles =
    state.composeFiles && state.composeFiles.length > 0
      ? state.composeFiles
      : [state.composeFile];
  const candidates: RestoreCandidate[] = [];

  for (const composeFile of composeFiles) {
    let text: string;
    try {
      text = readFileSync(composeFile, "utf-8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(text);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const root = parsed as Record<string, unknown>;
    const svcs = root.services;
    if (!svcs || typeof svcs !== "object" || Array.isArray(svcs)) continue;

    for (const [svcName, svcObj] of Object.entries(
      svcs as Record<string, unknown>,
    )) {
      if (!svcObj || typeof svcObj !== "object" || Array.isArray(svcObj))
        continue;
      const svc = svcObj as Record<string, unknown>;

      const labels = svc.labels as Record<string, string> | undefined;
      if (!labels || typeof labels !== "object") continue;
      if (labels[WOS_LABEL_MANAGED] !== "true") continue;
      if (labels[WOS_LABEL_SCHEMA] !== "1") continue;

      const homeHash = labels[WOS_LABEL_HOME_HASH];
      const sessionName = labels[WOS_LABEL_SESSION];
      const projectName = labels[WOS_LABEL_PROJECT];
      const deploymentId = labels[WOS_LABEL_DEPLOYMENT_ID];
      const service = labels[WOS_LABEL_SERVICE];
      const tunnelPortsStr = labels[WOS_LABEL_TUNNEL_PORTS];

      if (
        !homeHash ||
        !sessionName ||
        !projectName ||
        !deploymentId ||
        !service ||
        !tunnelPortsStr
      )
        continue;

      const portStrs = tunnelPortsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (portStrs.length === 0) continue;

      const tunnelPorts: number[] = [];
      const hostnames: Record<number, string> = {};
      const hostPorts: Record<number, number> = {};

      let valid = true;
      for (const portStr of portStrs) {
        const port = Number(portStr);
        if (!Number.isInteger(port)) {
          valid = false;
          break;
        }
        const hostname = labels[tunnelHostnameLabelKey(port)];
        if (!hostname) {
          valid = false;
          break;
        }
        const hostPortStr = labels[tunnelHostPortLabelKey(port)];
        const hostPort = Number(hostPortStr);
        if (!Number.isInteger(hostPort)) {
          valid = false;
          break;
        }
        tunnelPorts.push(port);
        hostnames[port] = hostname;
        hostPorts[port] = hostPort;
      }
      if (!valid) continue;

      candidates.push({
        homeHash,
        sessionName,
        projectName,
        deploymentId,
        service,
        tunnelPorts,
        hostnames,
        hostPorts,
      });
    }
  }

  return candidates;
}
