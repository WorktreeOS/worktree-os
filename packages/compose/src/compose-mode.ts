import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ComposeExposePort } from "@worktreeos/core/config";
import type { PortAssignments } from "@worktreeos/core/state";
import {
  sessionComposeBasePath,
  sessionComposeOverlayPath,
  sessionNameForWorktree,
} from "@worktreeos/core/paths";
import { emitYaml, type YamlValue } from "./generated-compose";
import type { PortBinding } from "./port-allocator";
import {
  WOS_LABEL_TUNNEL_PORTS,
  WOS_ENV_HOSTNAME,
  buildWosIdentityLabels,
  firstManagedPortServiceEnv,
  stableWosHomeHash,
  tunnelEnvHostnameKey,
  tunnelHostnameLabelKey,
  tunnelHostPortLabelKey,
} from "@worktreeos/core/tunnel-metadata";

export class ComposeModeError extends Error {}

/** Resolve a user-owned `compose.config` path against the worktree root. */
export function resolveComposeConfigPath(
  rawConfig: string,
  worktreeRoot: string,
): string {
  return isAbsolute(rawConfig) ? rawConfig : resolve(worktreeRoot, rawConfig);
}

/**
 * Convert normalized `compose.expose` entries into allocator bindings. Every
 * exposed port maps to one binding with service kind `app` (compose mode has
 * no `deps`).
 */
export function collectComposeExposeBindings(
  expose: readonly ComposeExposePort[],
): PortBinding[] {
  return expose.map((e) => ({
    kind: "app",
    service: e.service,
    containerPort: e.port,
  }));
}

/** Unique service names from `compose.expose`, in first-seen order. */
export function uniqueExposeServices(
  expose: readonly ComposeExposePort[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of expose) {
    if (!seen.has(e.service)) {
      seen.add(e.service);
      out.push(e.service);
    }
  }
  return out;
}

/**
 * Parse a user-owned Docker Compose YAML and return a deep-cloned mapping
 * with every `services.<name>.ports` entry removed. Comments, anchors, and
 * formatting from the source file are lost — this is an execution artifact,
 * not a user-editable file.
 */
export function sanitizeComposeYamlText(text: string): string {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (e) {
    throw new ComposeModeError(
      `failed to parse user-owned compose file: ${(e as Error).message}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return emitYaml({ services: {} });
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ComposeModeError(
      "user-owned compose file must be a YAML mapping at the top level",
    );
  }
  const root = parsed as Record<string, unknown>;
  const services = root.services;
  if (services !== undefined && services !== null) {
    if (typeof services !== "object" || Array.isArray(services)) {
      throw new ComposeModeError(
        "user-owned compose file: `services` must be a mapping",
      );
    }
    for (const [name, svc] of Object.entries(services as Record<string, unknown>)) {
      if (svc === null || svc === undefined) continue;
      if (typeof svc !== "object" || Array.isArray(svc)) continue;
      const svcObj = svc as Record<string, unknown>;
      if ("ports" in svcObj) {
        delete svcObj.ports;
      }
      // Preserve other keys verbatim; the sanitizer must NOT alter image,
      // env, depends_on, etc. Sanitized files only differ from the source
      // by missing `ports` entries (plus YAML-level reformatting from
      // parse/emit).
      void name;
    }
  }
  return emitYaml(toYamlValue(root));
}

/** Build the wos-owned overlay YAML text from expose entries + assignments. */
export function buildComposeOverlayYaml(
  expose: readonly ComposeExposePort[],
  assignments: PortAssignments,
  opts?: {
    tunnelHostnames?: Record<string, Record<string, string>>;
    worktreeRoot?: string;
    projectName?: string;
    deploymentId?: string;
  },
): string {
  const services: Record<string, YamlValue> = {};
  const grouped = new Map<string, ComposeExposePort[]>();
  for (const e of expose) {
    const list = grouped.get(e.service) ?? [];
    list.push(e);
    grouped.set(e.service, list);
  }
  const tunnelHostnames = opts?.tunnelHostnames ?? {};
  for (const [serviceName, entries] of grouped) {
    const ports: YamlValue[] = entries.map((entry) => {
      const hostPort = assignments[serviceName]?.[String(entry.port)];
      if (typeof hostPort !== "number") {
        throw new ComposeModeError(
          `missing host-port assignment for compose.expose ${serviceName}:${entry.port}`,
        );
      }
      return `${hostPort}:${entry.port}`;
    });
    const svc: Record<string, YamlValue> = { ports };
    const env: Record<string, string> = {};

    // Identity labels are mandatory for every managed compose-mode service.
    if (opts?.worktreeRoot) {
      const homeHash = stableWosHomeHash();
      const sessionName = sessionNameForWorktree(opts.worktreeRoot);
      const labels: Record<string, string> = buildWosIdentityLabels({
        homeHash,
        sessionName,
        projectName: opts.projectName ?? "",
        mode: "compose",
        serviceName,
        deploymentId: opts.deploymentId,
      });

      const portHostnames = tunnelHostnames[serviceName];
      const tunnelPorts: string[] = [];
      const filtered: Record<string, string> = {};
      if (portHostnames) {
        for (const portStr of Object.keys(portHostnames)) {
          const hostname = portHostnames[portStr]!;
          if (!hostname) continue;
          const hostPort = assignments[serviceName]?.[portStr];
          if (typeof hostPort !== "number") continue;
          tunnelPorts.push(portStr);
          filtered[portStr] = hostname;
        }
      }
      if (tunnelPorts.length > 0) {
        labels[WOS_LABEL_TUNNEL_PORTS] = tunnelPorts.join(",");
        for (const [portStr, hostname] of Object.entries(filtered)) {
          const port = Number(portStr);
          labels[tunnelHostnameLabelKey(port)] = hostname;
          labels[tunnelHostPortLabelKey(port)] = String(assignments[serviceName]![portStr]!);
        }
        for (const portStr of tunnelPorts) {
          env[tunnelEnvHostnameKey(Number(portStr))] = filtered[portStr]!;
        }
        if (tunnelPorts.length === 1) {
          env[WOS_ENV_HOSTNAME] = filtered[tunnelPorts[0]!]!;
        }
      }
      svc.labels = labels as YamlValue;

      // Authoritative first-exposed-port convenience pair (declaration order).
      // Applied last so wos-owned values win over any tunnel-derived hostname.
      Object.assign(
        env,
        firstManagedPortServiceEnv({
          containerPorts: entries.map((entry) => entry.port),
          hostPorts: assignments[serviceName],
          tunnelHostnames: tunnelHostnames[serviceName],
        }),
      );
      if (Object.keys(env).length > 0) {
        svc.environment = env as YamlValue;
      }
    }
    services[serviceName] = svc as YamlValue;
  }
  return emitYaml({ services } as YamlValue);
}

export async function writeSanitizedComposeBase(
  worktreeRoot: string,
  userComposeFile: string,
): Promise<string> {
  const file = Bun.file(userComposeFile);
  if (!(await file.exists())) {
    throw new ComposeModeError(
      `compose.config file not found: ${userComposeFile}`,
    );
  }
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    throw new ComposeModeError(
      `failed to read user-owned compose file ${userComposeFile}: ${(e as Error).message}`,
    );
  }
  const sanitized = sanitizeComposeYamlText(text);
  const path = sessionComposeBasePath(worktreeRoot);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, sanitized);
  return path;
}

export async function writeComposeOverlay(
  worktreeRoot: string,
  expose: readonly ComposeExposePort[],
  assignments: PortAssignments,
  opts?: {
    tunnelHostnames?: Record<string, Record<string, string>>;
    projectName?: string;
    deploymentId?: string;
  },
): Promise<string> {
  const yaml = buildComposeOverlayYaml(expose, assignments, { ...opts, worktreeRoot });
  const path = sessionComposeOverlayPath(worktreeRoot);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, yaml);
  return path;
}

function toYamlValue(value: unknown): YamlValue {
  // YAML null is represented as an empty mapping so the emitter can serialize
  // it without a dedicated null scalar form.
  if (value === null || value === undefined) return {} as YamlValue;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toYamlValue);
  if (typeof value === "object") {
    const out: Record<string, YamlValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toYamlValue(v);
    }
    return out;
  }
  return String(value);
}
