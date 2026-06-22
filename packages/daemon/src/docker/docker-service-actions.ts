/**
 * Docker-API-backed service-level actions resolved through the daemon's
 * Docker state cache. These helpers replace the runtime/operations.ts paths
 * that invoke `docker compose stop/start` for individual services.
 *
 * They return `null` when there is no known managed container for the
 * requested (session, service) pair so callers can decide how to surface
 * "nothing to act on" — either as a soft success or a structured error.
 */
import type { DockerClient } from "./docker-client";
import type { DockerStateStore } from "./docker-state-store";

export type ServiceAction = "start" | "stop" | "restart";

export interface ServiceActionResult {
  action: ServiceAction;
  containerId: string;
  serviceName: string;
  sessionName: string;
}

export class ServiceActionTargetMissing extends Error {
  readonly sessionName: string;
  readonly serviceName: string;
  constructor(sessionName: string, serviceName: string) {
    super(`no managed container in Docker cache for ${sessionName}/${serviceName}`);
    this.sessionName = sessionName;
    this.serviceName = serviceName;
  }
}

export async function runServiceAction(
  client: DockerClient,
  store: DockerStateStore,
  args: {
    action: ServiceAction;
    sessionName: string;
    serviceName: string;
    stopTimeoutSec?: number;
  },
): Promise<ServiceActionResult> {
  const target = store.findCurrent(args.sessionName, args.serviceName);
  if (!target) throw new ServiceActionTargetMissing(args.sessionName, args.serviceName);
  switch (args.action) {
    case "start":
      await client.startContainer(target.containerId);
      break;
    case "stop":
      await client.stopContainer(target.containerId, {
        timeoutSec: args.stopTimeoutSec,
      });
      break;
    case "restart":
      await client.restartContainer(target.containerId, {
        timeoutSec: args.stopTimeoutSec,
      });
      break;
  }
  // Refresh the cache so subsequent readers see the new state.
  await store.syncNow();
  return {
    action: args.action,
    containerId: target.containerId,
    serviceName: target.serviceName,
    sessionName: target.sessionName,
  };
}
