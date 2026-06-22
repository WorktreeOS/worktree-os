/**
 * Normalize Docker Engine API container payloads into wos-friendly
 * snapshots keyed by container id and grouped by session/service.
 */
import {
  WOS_LABEL_DEPLOYMENT_ID,
  WOS_LABEL_HOME_HASH,
  WOS_LABEL_MANAGED,
  WOS_LABEL_MODE,
  WOS_LABEL_PROJECT,
  WOS_LABEL_SCHEMA,
  WOS_LABEL_SCHEMA_VALUE,
  WOS_LABEL_SERVICE,
  WOS_LABEL_SESSION,
  type WosMode,
} from "@worktreeos/core/tunnel-metadata";
import type {
  DockerContainerInspect,
  DockerContainerListItem,
  DockerContainerStats,
} from "./docker-client";
import type { PortMapping, ResourceUsage } from "@worktreeos/compose/ps";

/** Service name used for internal init containers. Excluded from user views. */
export const INIT_SERVICE_NAME = "wos-init";

export interface WosContainerSnapshot {
  containerId: string;
  containerName: string;
  image: string;
  homeHash: string;
  sessionName: string;
  projectName: string;
  serviceName: string;
  mode: WosMode;
  deploymentId?: string;
  state: string;
  status: string;
  ports: PortMapping[];
  labels: Record<string, string>;
  /** Container start time (`State.StartedAt`), captured on inspect only. */
  startedAt?: string;
  /** Cumulative restart count (`RestartCount`), captured on inspect only. */
  restartCount?: number;
  /** Latest sampled resource usage; unset until/unless stats are obtained. */
  resourceUsage?: ResourceUsage;
  /** True once Docker reports the container was destroyed/removed. */
  removed?: boolean;
}

export function normalizeListItem(
  item: DockerContainerListItem,
): WosContainerSnapshot | null {
  const labels = item.Labels ?? {};
  if (!isManaged(labels)) return null;
  const id = item.Id;
  const name = pickName(item.Names);
  const ports: PortMapping[] = (item.Ports ?? [])
    .filter((p) => typeof p.PrivatePort === "number")
    .map((p) => ({
      containerPort: p.PrivatePort,
      hostPort: p.PublicPort,
      hostIp: p.IP,
      protocol: p.Type ?? "tcp",
    }));
  return {
    containerId: id,
    containerName: name,
    image: item.Image,
    homeHash: labels[WOS_LABEL_HOME_HASH] ?? "",
    sessionName: labels[WOS_LABEL_SESSION] ?? "",
    projectName: labels[WOS_LABEL_PROJECT] ?? "",
    serviceName: labels[WOS_LABEL_SERVICE] ?? "",
    mode: (labels[WOS_LABEL_MODE] as WosMode) ?? "generated",
    deploymentId: labels[WOS_LABEL_DEPLOYMENT_ID],
    state: item.State ?? "",
    status: item.Status ?? "",
    ports,
    labels,
  };
}

export function normalizeInspect(
  inspect: DockerContainerInspect,
): WosContainerSnapshot | null {
  const labels = inspect.Config?.Labels ?? {};
  if (!isManaged(labels)) return null;
  const ports: PortMapping[] = [];
  const nsPorts = inspect.NetworkSettings?.Ports ?? {};
  for (const [key, bindings] of Object.entries(nsPorts)) {
    const match = /^(\d+)\/(.+)$/.exec(key);
    if (!match) continue;
    const containerPort = Number(match[1]);
    const protocol = match[2] ?? "tcp";
    if (!bindings || bindings.length === 0) {
      ports.push({ containerPort, protocol });
      continue;
    }
    for (const b of bindings) {
      const hostPort = b.HostPort ? Number(b.HostPort) : undefined;
      ports.push({
        containerPort,
        hostPort: Number.isFinite(hostPort as number) ? (hostPort as number) : undefined,
        hostIp: b.HostIp || undefined,
        protocol,
      });
    }
  }
  return {
    containerId: inspect.Id,
    containerName: inspect.Name?.replace(/^\//, "") ?? "",
    image: inspect.Image,
    homeHash: labels[WOS_LABEL_HOME_HASH] ?? "",
    sessionName: labels[WOS_LABEL_SESSION] ?? "",
    projectName: labels[WOS_LABEL_PROJECT] ?? "",
    serviceName: labels[WOS_LABEL_SERVICE] ?? "",
    mode: (labels[WOS_LABEL_MODE] as WosMode) ?? "generated",
    deploymentId: labels[WOS_LABEL_DEPLOYMENT_ID],
    state: inspect.State?.Status ?? "",
    status: formatStatus(inspect),
    ports,
    labels,
    startedAt: inspect.State?.StartedAt,
    restartCount: inspect.RestartCount,
  };
}

function pickName(names: string[] | undefined): string {
  if (!names || names.length === 0) return "";
  const first = names[0] ?? "";
  return first.replace(/^\//, "");
}

function formatStatus(inspect: DockerContainerInspect): string {
  const s = inspect.State;
  if (!s) return "";
  if (s.Running) {
    if (s.Health?.Status) return `Up (${s.Health.Status})`;
    return "Up";
  }
  if (s.ExitCode !== undefined) return `Exited (${s.ExitCode})`;
  return s.Status ?? "";
}

/**
 * Convert a raw Docker stats payload into the wos `ResourceUsage` shape.
 *
 * CPU% uses the standard delta formula
 * `cpuDelta / systemDelta * onlineCPUs * 100`. The CPU figure is omitted (left
 * `undefined`) rather than emitted as `NaN`/`0` when its inputs are missing or
 * would divide by zero — for example on the first sample where `precpu_stats`
 * has no system usage yet, or when `online_cpus` is absent. Memory used/limit
 * are included when Docker reports them. Disk is not derivable from the stats
 * endpoint and is left unset in v1.
 *
 * Returns `null` when no usable field could be derived (e.g. an empty payload
 * for a stopped container).
 */
export function normalizeStats(
  stats: DockerContainerStats | null | undefined,
): ResourceUsage | null {
  if (!stats) return null;
  const usage: ResourceUsage = {};

  const cpuPercent = computeCpuPercent(stats);
  if (cpuPercent !== undefined) usage.cpuPercent = cpuPercent;

  const mem = stats.memory_stats;
  if (mem) {
    // Docker's reported `usage` includes page cache; subtract it when the
    // cgroup v1 `cache` / cgroup v2 `inactive_file` stat is present so the
    // number matches what `docker stats` shows.
    const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
    if (typeof mem.usage === "number" && Number.isFinite(mem.usage)) {
      usage.memUsedBytes = Math.max(0, mem.usage - (Number.isFinite(cache) ? cache : 0));
    }
    if (typeof mem.limit === "number" && Number.isFinite(mem.limit) && mem.limit > 0) {
      usage.memLimitBytes = mem.limit;
    }
  }

  if (
    usage.cpuPercent === undefined &&
    usage.memUsedBytes === undefined &&
    usage.memLimitBytes === undefined
  ) {
    return null;
  }
  return usage;
}

function computeCpuPercent(stats: DockerContainerStats): number | undefined {
  const cpu = stats.cpu_stats;
  const precpu = stats.precpu_stats;
  const total = cpu?.cpu_usage?.total_usage;
  const preTotal = precpu?.cpu_usage?.total_usage;
  const system = cpu?.system_cpu_usage;
  const preSystem = precpu?.system_cpu_usage;
  if (
    typeof total !== "number" ||
    typeof preTotal !== "number" ||
    typeof system !== "number" ||
    typeof preSystem !== "number"
  ) {
    return undefined;
  }
  const cpuDelta = total - preTotal;
  const systemDelta = system - preSystem;
  if (systemDelta <= 0 || cpuDelta < 0) return undefined;
  const onlineCpus = cpu?.online_cpus;
  if (typeof onlineCpus !== "number" || onlineCpus <= 0) return undefined;
  const pct = (cpuDelta / systemDelta) * onlineCpus * 100;
  if (!Number.isFinite(pct)) return undefined;
  return pct;
}

export function isManaged(labels: Record<string, string>): boolean {
  return (
    labels[WOS_LABEL_MANAGED] === "true" &&
    labels[WOS_LABEL_SCHEMA] === WOS_LABEL_SCHEMA_VALUE
  );
}

export function isInternalService(snapshot: WosContainerSnapshot): boolean {
  return snapshot.serviceName === INIT_SERVICE_NAME;
}
