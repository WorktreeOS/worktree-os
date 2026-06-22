export interface PortMapping {
  containerPort: number;
  hostPort?: number;
  hostIp?: string;
  protocol: string;
}

/**
 * Instantaneous resource usage for a single container/service. All fields are
 * optional and best-effort: a field is present only when the runtime could
 * derive it. CPU is a percentage (can exceed 100 across multiple cores);
 * memory is bytes; disk is best-effort and may be omitted.
 */
export interface ResourceUsage {
  /** CPU usage percentage across all cores (e.g. 12.4). */
  cpuPercent?: number;
  /** Resident memory used in bytes. */
  memUsedBytes?: number;
  /** Memory limit in bytes when the container has one. */
  memLimitBytes?: number;
  /** Writable-layer/volume disk usage in bytes when available. */
  diskBytes?: number;
}

export interface ServiceStatus {
  service: string;
  state: string;
  status?: string;
  ports: PortMapping[];
  /** Container start time (ISO), present for docker-mode services when sampled. */
  startedAt?: string;
  /** Cumulative restart count; 0 for shell-mode, omitted when not yet sampled. */
  restartCount?: number;
  /** Latest sampled resource usage; omitted when unavailable. */
  resourceUsage?: ResourceUsage;
}

export class PsParseError extends Error {}

export function parseComposePs(output: string): ServiceStatus[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  const records: unknown[] = [];
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new PsParseError(`failed to parse compose ps JSON array: ${(e as Error).message}`);
    }
    if (!Array.isArray(arr)) {
      throw new PsParseError("compose ps JSON did not contain an array");
    }
    records.push(...arr);
  } else {
    for (const line of trimmed.split("\n")) {
      const piece = line.trim();
      if (piece.length === 0) continue;
      try {
        records.push(JSON.parse(piece));
      } catch (e) {
        throw new PsParseError(`failed to parse compose ps NDJSON line: ${(e as Error).message}`);
      }
    }
  }
  return records.map((r) => parseRecord(r as Record<string, unknown>));
}

function parseRecord(r: Record<string, unknown>): ServiceStatus {
  const service = pickString(r, ["Service", "service"]) ?? "";
  const state = pickString(r, ["State", "state"]) ?? "";
  const status = pickString(r, ["Status", "status"]);
  const ports = parsePorts(
    r.Publishers ?? r.publishers ?? r.Ports ?? r.ports,
  );
  return { service, state, status, ports };
}

function pickString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function parsePorts(raw: unknown): PortMapping[] {
  if (Array.isArray(raw)) {
    return raw
      .map((p) => parsePublisher(p as Record<string, unknown>))
      .filter((p): p is PortMapping => p !== null);
  }
  if (typeof raw === "string" && raw.length > 0) {
    return raw
      .split(",")
      .map((s) => parsePortString(s.trim()))
      .filter((p): p is PortMapping => p !== null);
  }
  return [];
}

function parsePublisher(p: Record<string, unknown>): PortMapping | null {
  const target = numeric(p.TargetPort ?? p.targetPort);
  if (target === null) return null;
  const published = numeric(p.PublishedPort ?? p.publishedPort);
  const url = pickString(p, ["URL", "url"]);
  const protocol = pickString(p, ["Protocol", "protocol"]) ?? "tcp";
  return {
    containerPort: target,
    hostPort: published === null ? undefined : published === 0 ? undefined : published,
    hostIp: url,
    protocol,
  };
}

function parsePortString(s: string): PortMapping | null {
  const match = s.match(/^(?:(?<host>[^:]+):(?<hostPort>\d+)->)?(?<container>\d+)\/(?<proto>\w+)$/);
  if (!match || !match.groups) return null;
  const g = match.groups;
  return {
    containerPort: Number(g.container),
    hostPort: g.hostPort ? Number(g.hostPort) : undefined,
    hostIp: g.host,
    protocol: g.proto ?? "tcp",
  };
}

function numeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}
