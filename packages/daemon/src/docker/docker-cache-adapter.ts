/**
 * Adapters that translate the Docker state cache into shapes consumed by
 * existing wos readers (status operations, UI snapshots, session monitor,
 * tunnel restoration). These adapters intentionally mirror the shape produced
 * by `parseComposePs` so callers can swap data sources without changing their
 * downstream logic.
 */
import type { ServiceStatus } from "@worktreeos/compose/ps";
import type { WosContainerSnapshot } from "./docker-snapshot";
import type { DockerStateStore } from "./docker-state-store";

/** Map a single Docker snapshot to the compose-ps-shaped `ServiceStatus`. */
export function snapshotToServiceStatus(
  snapshot: WosContainerSnapshot,
): ServiceStatus {
  return {
    service: snapshot.serviceName,
    state: snapshot.state,
    status: snapshot.status,
    ports: snapshot.ports,
    startedAt: snapshot.startedAt,
    restartCount: snapshot.restartCount,
    ...(snapshot.resourceUsage ? { resourceUsage: snapshot.resourceUsage } : {}),
  };
}

export interface DockerCacheServiceFilter {
  sessionName: string;
  projectName?: string;
  /** Restrict to a specific subset of service names. */
  services?: ReadonlySet<string>;
  /** Include the internal init container in results. Default: false. */
  includeInternal?: boolean;
}

/**
 * Return current Docker-cached services formatted as `ServiceStatus[]`. Each
 * (sessionName, serviceName) pair contributes at most one entry; running
 * containers are preferred when more than one matches.
 */
export function listSessionServices(
  store: DockerStateStore,
  filter: DockerCacheServiceFilter,
): ServiceStatus[] {
  const byService = new Map<string, WosContainerSnapshot>();
  for (const snap of store.list({
    sessionName: filter.sessionName,
    projectName: filter.projectName,
    includeInternal: filter.includeInternal,
  })) {
    if (filter.services && !filter.services.has(snap.serviceName)) continue;
    const existing = byService.get(snap.serviceName);
    if (!existing) {
      byService.set(snap.serviceName, snap);
      continue;
    }
    if (existing.state !== "running" && snap.state === "running") {
      byService.set(snap.serviceName, snap);
    }
  }
  return Array.from(byService.values())
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName))
    .map(snapshotToServiceStatus);
}

/**
 * Resolve the authoritative Docker-cache service list for a session, or
 * `undefined` when the cache is not yet usable and the caller should fall back
 * to `docker compose ps`.
 *
 * Returns `undefined` when no store is provided or the store has not completed
 * an initial sync (Docker socket unavailable / daemon still starting). Once the
 * store has synced the cache is authoritative — an empty array is a real result
 * meaning "no managed containers for this session" (e.g. a stopped deployment),
 * not a signal to fall back. Compose mode only labels `compose.expose` services,
 * so the cache is already scoped correctly for both modes without extra
 * filtering; internal init containers are excluded by `store.list`.
 */
export function cachedSessionServicesOrNull(
  store: DockerStateStore | undefined,
  sessionName: string,
): ServiceStatus[] | undefined {
  if (!store || !store.hasSynced()) return undefined;
  return listSessionServices(store, { sessionName });
}
