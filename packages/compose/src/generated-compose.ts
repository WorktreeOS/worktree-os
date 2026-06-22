import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathMappingSeparatorIndex, type WosConfig } from "@worktreeos/core/config";
import type { PackageManagerCacheMount } from "@worktreeos/runtime/package-cache";
import type { RuntimeArgumentMap } from "./runtime-arguments";
import { sessionComposePath, sessionNameForWorktree } from "@worktreeos/core/paths";
import type { PortAssignments } from "@worktreeos/core/state";
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

export const INIT_SERVICE_NAME = "wos-init";
export const INTERNAL_PROFILE = "wos-internal";
const APP_WORKING_DIR = "/workspace";

export type YamlValue =
  | string
  | number
  | boolean
  | YamlValue[]
  | { [k: string]: YamlValue };

export interface GeneratedComposeService {
  image: string;
  container_name?: string;
  working_dir?: string;
  env_file?: string;
  volumes?: string[];
  ports?: string[];
  command?: string[];
  environment?: Record<string, string>;
  profiles?: string[];
  labels?: Record<string, string>;
  depends_on?: string[];
}

export interface GeneratedCompose {
  services: Record<string, GeneratedComposeService>;
}

export interface ComposeBuildContext {
  config: WosConfig;
  worktreeRoot: string;
  projectName: string;
  portAssignments: PortAssignments;
  packageManagerCaches?: PackageManagerCacheMount[];
  /**
   * Map of `service -> containerPort (string) -> public hostname`. When a
   * configured app port has no entry, `${app.services.<name>.hostname[<port>]}`
   * resolves to `localhost`.
   */
  tunnelHostnames?: Record<string, Record<string, string>>;
  /**
   * Map of `service -> containerPort (string) -> full public URL`. When a
   * configured app port has no entry, `${app.services.<name>.url[<port>]}`
   * resolves to `http://localhost:<hostPort>`.
   */
  tunnelUrls?: Record<string, Record<string, string>>;
  /**
   * Optional LAN address to publish managed host ports on, in addition to
   * loopback. When set, each managed port is published on both `127.0.0.1` and
   * this address. When unset, the prior single mapping is used.
   */
  serviceBind?: string;
  /** Deployment id persisted alongside Compose artifacts for daemon startup restoration. */
  deploymentId?: string;
  /**
   * Resolved generated-service selection. When provided, the generator emits
   * only services present in this set and limits `depends_on` to selected
   * dependencies. Undefined means full deployment (default).
   */
  selectedServices?: ReadonlySet<string>;
  /**
   * Submitted runtime argument values keyed by declared argument name. Empty
   * string values are treated as missing so `${KEY:-default}` templates can
   * fall through to the default. Undefined or missing values for declared
   * arguments are also treated as missing.
   */
  runtimeArguments?: RuntimeArgumentMap;
}

export class TemplateError extends Error {}

export function buildGeneratedCompose(ctx: ComposeBuildContext): GeneratedCompose {
  const { config, worktreeRoot, projectName, portAssignments } = ctx;
  const packageManagerCaches = ctx.packageManagerCaches ?? [];
  const tunnelHostnames = ctx.tunnelHostnames ?? {};
  const tunnelUrls = ctx.tunnelUrls ?? {};
  const selected = ctx.selectedServices;
  const isSelected = (name: string): boolean =>
    selected === undefined || selected.has(name);
  const resolver = new TemplateResolver(
    config,
    portAssignments,
    projectName,
    tunnelHostnames,
    tunnelUrls,
    ctx.runtimeArguments,
  );

  const services: Record<string, GeneratedComposeService> = {};

  for (const name of sortedKeys(config.app.services)) {
    if (!isSelected(name)) continue;
    const svc = config.app.services[name]!;
    const image = svc.image ?? config.app.image;
    if (image === null) {
      throw new Error(`app.services.${name}.image or app.image is required to generate compose`);
    }
    const service: GeneratedComposeService = {
      image,
      container_name: serviceContainerName(projectName, name),
      working_dir: resolveWorkingDir(svc.cwd),
      volumes: [
        `${worktreeRoot}:${APP_WORKING_DIR}`,
        ...svc.volumes.map((v) => resolveVolumeHost(v, worktreeRoot)),
      ],
    };
    if (svc.envFile !== null) {
      service.env_file = resolveEnvFilePath(svc.envFile, worktreeRoot);
    }
    if (svc.script.length > 0) {
      service.command = ["sh", "-c", joinScript(svc.script)];
    }
    if (svc.ports.length > 0) {
      service.ports = svc.ports.flatMap((p) =>
        portMapping(
          p.containerPort,
          requireAssignment(
            portAssignments,
            name,
            p.containerPort,
            `app.services.${name}.ports`,
          ),
          ctx.serviceBind,
        ),
      );
    }
    if (Object.keys(svc.environment).length > 0) {
      service.environment = resolver.resolveEnv(svc.environment, `app.services.${name}.environment`);
    }
    const deps = (svc.dependencies ?? []).filter(isSelected);
    if (deps.length > 0) {
      service.depends_on = [...deps].sort();
    }
    applyIdentityLabels(service, name, ctx);
    applyTunnelRestoreMetadata(service, name, ctx);
    applyFirstPortServiceEnv(service, name, svc.ports.map((p) => p.containerPort), ctx);
    services[name] = service;
  }

  for (const name of sortedKeys(config.deps)) {
    if (!isSelected(name)) continue;
    const dep = config.deps[name]!;
    const service: GeneratedComposeService = {
      image: dep.image,
      container_name: serviceContainerName(projectName, name),
    };
    if (dep.ports.length > 0) {
      service.ports = dep.ports.flatMap((p) =>
        portMapping(
          p,
          requireAssignment(portAssignments, name, p, `deps.${name}.ports`),
          ctx.serviceBind,
        ),
      );
    }
    if (Object.keys(dep.environment).length > 0) {
      service.environment = resolver.resolveEnv(dep.environment, `deps.${name}.environment`);
    }
    if (dep.volumes.length > 0) {
      service.volumes = dep.volumes.map((v) => resolveVolumeHost(v, worktreeRoot));
    }
    applyIdentityLabels(service, name, ctx);
    applyTunnelRestoreMetadata(service, name, ctx);
    services[name] = service;
  }

  const hasSelectedServiceInit = Object.entries(config.app.services).some(
    ([n, s]) => isSelected(n) && (s.initScript ?? []).length > 0,
  );
  const needsInitService =
    config.app.image !== null &&
    (config.app.initScript.length > 0 || hasSelectedServiceInit);
  if (needsInitService) {
    const cacheEnv = packageManagerCacheEnvironment(packageManagerCaches);
    services[INIT_SERVICE_NAME] = {
      image: config.app.image!,
      container_name: serviceContainerName(projectName, INIT_SERVICE_NAME),
      working_dir: APP_WORKING_DIR,
      volumes: [
        `${worktreeRoot}:${APP_WORKING_DIR}`,
        ...packageManagerCaches.map((cache) => `${cache.hostPath}:${cache.containerPath}`),
      ],
      profiles: [INTERNAL_PROFILE],
      ...(Object.keys(cacheEnv).length > 0 ? { environment: cacheEnv } : {}),
    };
  }

  return { services };
}

function applyIdentityLabels(
  service: GeneratedComposeService,
  serviceName: string,
  ctx: ComposeBuildContext,
): void {
  const homeHash = stableWosHomeHash();
  const sessionName = sessionNameForWorktree(ctx.worktreeRoot);
  const identity = buildWosIdentityLabels({
    homeHash,
    sessionName,
    projectName: ctx.projectName,
    mode: "generated",
    serviceName,
    deploymentId: ctx.deploymentId,
  });
  service.labels = { ...identity, ...(service.labels ?? {}) };
}

function applyTunnelRestoreMetadata(
  service: GeneratedComposeService,
  serviceName: string,
  ctx: ComposeBuildContext,
): void {
  const tunnelHostnames = ctx.tunnelHostnames ?? {};
  const portHostnames = tunnelHostnames[serviceName];
  if (!portHostnames || Object.keys(portHostnames).length === 0) return;

  // Strip port hostname entries without a matching port in the assignment.
  // This prevents stale hostname metadata from leaking into the compose file
  // when a port was previously tunnelled but is no longer managed.
  const tunnelPorts: string[] = [];
  const filtered: Record<string, string> = {};
  for (const portStr of Object.keys(portHostnames)) {
    const hostname = portHostnames[portStr]!;
    if (!hostname) continue;
    const hostPort = ctx.portAssignments[serviceName]?.[portStr];
    if (typeof hostPort !== "number") continue;
    tunnelPorts.push(portStr);
    filtered[portStr] = hostname;
  }
  if (tunnelPorts.length === 0) return;

  const labels: Record<string, string> = { ...(service.labels ?? {}) };
  labels[WOS_LABEL_TUNNEL_PORTS] = tunnelPorts.join(",");
  for (const [portStr, hostname] of Object.entries(filtered)) {
    const port = Number(portStr);
    labels[tunnelHostnameLabelKey(port)] = hostname;
    labels[tunnelHostPortLabelKey(port)] = String(ctx.portAssignments[serviceName]![portStr]!);
  }
  service.labels = labels;

  const env: Record<string, string> = { ...(service.environment ?? {}) };
  for (const portStr of tunnelPorts) {
    const hostname = filtered[portStr]!;
    env[tunnelEnvHostnameKey(Number(portStr))] = hostname;
  }
  if (tunnelPorts.length === 1) {
    env[WOS_ENV_HOSTNAME] = filtered[tunnelPorts[0]!]!;
  }
  service.environment = env;
}

/**
 * Inject the authoritative first-port `WOS_SERVICE_PORT` / `WOS_SERVICE_HOSTNAME`
 * convenience pair for an app service. Applied after resolved user environment
 * and tunnel restore metadata so the wos-owned values win over any user-defined
 * values for these keys. Services without a managed port receive neither.
 */
function applyFirstPortServiceEnv(
  service: GeneratedComposeService,
  serviceName: string,
  containerPorts: readonly number[],
  ctx: ComposeBuildContext,
): void {
  const auto = firstManagedPortServiceEnv({
    containerPorts,
    hostPorts: ctx.portAssignments[serviceName],
    tunnelHostnames: (ctx.tunnelHostnames ?? {})[serviceName],
  });
  if (Object.keys(auto).length === 0) return;
  service.environment = { ...(service.environment ?? {}), ...auto };
}

export function serviceContainerName(projectName: string, serviceName: string): string {
  return `${projectName}-${serviceName}`;
}

export function serializeGeneratedCompose(compose: GeneratedCompose): string {
  const orderedServices: Record<string, YamlValue> = {};
  for (const name of sortedKeys(compose.services)) {
    orderedServices[name] = serviceToYaml(compose.services[name]!);
  }
  return emitYaml({ services: orderedServices });
}

export function generatedComposePath(worktreeRoot: string): string {
  return sessionComposePath(worktreeRoot);
}

export async function writeGeneratedCompose(ctx: ComposeBuildContext): Promise<string> {
  const path = generatedComposePath(ctx.worktreeRoot);
  await mkdir(dirname(path), { recursive: true });
  const data = buildGeneratedCompose(ctx);
  await Bun.write(path, serializeGeneratedCompose(data));
  return path;
}

export function joinScript(script: string[]): string {
  return script.join(" && ");
}

export function resolveWorkingDir(cwd: string | null): string {
  if (cwd === null || cwd.length === 0) return APP_WORKING_DIR;
  if (cwd.startsWith("/")) return cwd;
  return `${APP_WORKING_DIR}/${cwd.replace(/^\.\//, "")}`;
}

export function resolveEnvFilePath(envFile: string, worktreeRoot: string): string {
  if (envFile.startsWith("/")) return envFile;
  return resolve(worktreeRoot, envFile);
}

export function resolveVolumeHost(volume: string, worktreeRoot: string): string {
  const separator = pathMappingSeparatorIndex(volume);
  if (separator === -1) return volume;
  const host = volume.slice(0, separator);
  const rest = volume.slice(separator);
  if (host.startsWith(".")) {
    return resolve(worktreeRoot, host) + rest;
  }
  return volume;
}

/** Bracket IPv6 literals for the `host_ip` part of a compose port mapping. */
function formatPortHostIp(ip: string): string {
  return ip.includes(":") ? `[${ip}]` : ip;
}

/**
 * Build the published port mappings for one assigned host port. With no
 * `serviceBind`, emits the prior single `hostPort:containerPort` mapping
 * (Docker binds `0.0.0.0`). With `serviceBind` set, publishes on both loopback
 * and `serviceBind` so the loopback-bound tunnel proxy and healthchecks keep
 * working while the bind address becomes reachable. A `serviceBind` that is
 * already loopback collapses to a single entry.
 */
function portMapping(
  containerPort: number,
  hostPort: number,
  serviceBind?: string,
): string[] {
  if (!serviceBind) return [`${hostPort}:${containerPort}`];
  const hostIps = serviceBind === "127.0.0.1" ? ["127.0.0.1"] : ["127.0.0.1", serviceBind];
  return hostIps.map((ip) => `${formatPortHostIp(ip)}:${hostPort}:${containerPort}`);
}

function requireAssignment(
  assignments: PortAssignments,
  service: string,
  containerPort: number,
  field: string,
): number {
  const port = assignments[service]?.[String(containerPort)];
  if (typeof port !== "number") {
    throw new TemplateError(
      `missing host-port assignment for ${field} container port ${containerPort}`,
    );
  }
  return port;
}

const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;

const RUNTIME_ARGUMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class TemplateResolver {
  private readonly appServices: Set<string>;
  private readonly depServices: Set<string>;
  private readonly declaredArguments: Set<string>;
  private readonly submittedArguments: RuntimeArgumentMap;

  constructor(
    private readonly config: WosConfig,
    private readonly assignments: PortAssignments,
    private readonly projectName: string,
    private readonly tunnelHostnames: Record<string, Record<string, string>>,
    private readonly tunnelUrls: Record<string, Record<string, string>>,
    runtimeArguments?: RuntimeArgumentMap,
  ) {
    this.appServices = new Set(Object.keys(config.app.services));
    this.depServices = new Set(Object.keys(config.deps));
    this.declaredArguments = new Set(config.arguments ?? []);
    this.submittedArguments = runtimeArguments ?? {};
  }

  resolveEnv(
    env: Record<string, string>,
    fieldPrefix: string,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(env).sort()) {
      result[key] = this.resolveValue(env[key]!, `${fieldPrefix}.${key}`);
    }
    return result;
  }

  private resolveValue(value: string, field: string): string {
    return value.replace(TEMPLATE_PATTERN, (match, expr: string) => {
      return this.resolveExpression(match, expr.trim(), field);
    });
  }

  private resolveExpression(raw: string, expr: string, field: string): string {
    const runtime = this.tryResolveRuntimeArgument(raw, expr, field);
    if (runtime !== null) return runtime;
    // app.services.<name>.containerName | app.services.<name>.hostPort[<port>] | app.services.<name>.hostname[<port>] | app.services.<name>.url[<port>]
    const app = expr.match(
      /^app\.services\.([A-Za-z0-9_-]+)\.(containerName|hostPort\[(\d+)\]|hostname\[(\d+)\]|url\[(\d+)\])$/,
    );
    if (app) {
      const [, service, tail, hostPortStr, hostnamePortStr, urlPortStr] = app;
      if (!this.appServices.has(service!)) {
        throw new TemplateError(
          `${field}: template "${raw}" references unknown app service "${service}"`,
        );
      }
      if (tail === "containerName") {
        return serviceContainerName(this.projectName, service!);
      }
      if (tail!.startsWith("hostPort")) {
        return this.lookupHostPort("app", service!, Number(hostPortStr), raw, field);
      }
      if (tail!.startsWith("url")) {
        return this.lookupUrl(service!, Number(urlPortStr), raw, field);
      }
      return this.lookupHostname(service!, Number(hostnamePortStr), raw, field);
    }
    const dep = expr.match(
      /^deps\.([A-Za-z0-9_-]+)\.(containerName|hostPort\[(\d+)\])$/,
    );
    if (dep) {
      const [, service, tail, portStr] = dep;
      if (!this.depServices.has(service!)) {
        throw new TemplateError(
          `${field}: template "${raw}" references unknown dep service "${service}"`,
        );
      }
      if (tail === "containerName") {
        return serviceContainerName(this.projectName, service!);
      }
      return this.lookupHostPort("deps", service!, Number(portStr), raw, field);
    }
    throw new TemplateError(`${field}: unsupported template expression "${raw}"`);
  }

  private tryResolveRuntimeArgument(
    raw: string,
    expr: string,
    field: string,
  ): string | null {
    // Match `NAME` or `NAME:-default` where NAME is a shell-style identifier.
    // The default value runs to the end of the expression and may contain any
    // characters that already passed `${...}` extraction.
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(expr);
    if (!match) return null;
    const [, name, defaultValue] = match;
    if (!RUNTIME_ARGUMENT_NAME_PATTERN.test(name!)) return null;
    if (!this.declaredArguments.has(name!)) {
      throw new TemplateError(
        `${field}: template "${raw}" references undeclared runtime argument "${name}"`,
      );
    }
    const submitted = this.submittedArguments[name!];
    if (typeof submitted === "string" && submitted.length > 0) {
      return submitted;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new TemplateError(
      `${field}: template "${raw}" requires runtime argument "${name}" but no value was provided`,
    );
  }

  private lookupHostname(
    service: string,
    containerPort: number,
    raw: string,
    field: string,
  ): string {
    const configuredPorts: number[] =
      this.config.app.services[service]?.ports.map((p) => p.containerPort) ?? [];
    if (!configuredPorts.includes(containerPort)) {
      throw new TemplateError(
        `${field}: template "${raw}" references unconfigured container port ${containerPort} for app service "${service}"`,
      );
    }
    const hostname = this.tunnelHostnames[service]?.[String(containerPort)];
    return hostname ?? "localhost";
  }

  private lookupUrl(
    service: string,
    containerPort: number,
    raw: string,
    field: string,
  ): string {
    const configuredPorts: number[] =
      this.config.app.services[service]?.ports.map((p) => p.containerPort) ?? [];
    if (!configuredPorts.includes(containerPort)) {
      throw new TemplateError(
        `${field}: template "${raw}" references unconfigured container port ${containerPort} for app service "${service}"`,
      );
    }
    const url = this.tunnelUrls[service]?.[String(containerPort)];
    if (url) return url;
    const host = this.assignments[service]?.[String(containerPort)];
    if (typeof host !== "number") {
      throw new TemplateError(
        `${field}: missing host-port assignment for app.${service}:${containerPort}`,
      );
    }
    return `http://localhost:${host}`;
  }

  private lookupHostPort(
    kind: "app" | "deps",
    service: string,
    containerPort: number,
    raw: string,
    field: string,
  ): string {
    const configuredPorts: number[] =
      kind === "app"
        ? (this.config.app.services[service]?.ports.map((p) => p.containerPort) ?? [])
        : (this.config.deps[service]?.ports ?? []);
    if (!configuredPorts.includes(containerPort)) {
      throw new TemplateError(
        `${field}: template "${raw}" references unconfigured container port ${containerPort} for ${kind === "app" ? "app service" : "dep service"} "${service}"`,
      );
    }
    const host = this.assignments[service]?.[String(containerPort)];
    if (typeof host !== "number") {
      throw new TemplateError(
        `${field}: missing host-port assignment for ${kind === "app" ? "app" : "deps"}.${service}:${containerPort}`,
      );
    }
    return String(host);
  }
}

function sortedKeys<T>(obj: Record<string, T>): string[] {
  return Object.keys(obj).sort();
}

function packageManagerCacheEnvironment(
  caches: PackageManagerCacheMount[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const cache of caches) {
    env[cache.envName] = cache.containerPath;
  }
  return env;
}

const SERVICE_KEY_ORDER = [
  "image",
  "container_name",
  "working_dir",
  "profiles",
  "env_file",
  "environment",
  "labels",
  "volumes",
  "ports",
  "depends_on",
  "command",
] as const;

function serviceToYaml(svc: GeneratedComposeService): YamlValue {
  const out: Record<string, YamlValue> = {};
  for (const key of SERVICE_KEY_ORDER) {
    const value = svc[key];
    if (value === undefined) continue;
    out[key] = value as YamlValue;
  }
  return out;
}

export function emitYaml(value: YamlValue): string {
  const lines: string[] = [];
  emitNode(value, 0, lines);
  return lines.join("\n") + "\n";
}

function emitNode(value: YamlValue, indent: number, lines: string[]): void {
  if (isMapping(value)) {
    emitMapping(value as Record<string, YamlValue>, indent, lines);
  } else if (Array.isArray(value)) {
    emitSequence(value, indent, lines);
  } else {
    lines.push(pad(indent) + emitScalar(value));
  }
}

function emitMapping(
  obj: Record<string, YamlValue>,
  indent: number,
  lines: string[],
): void {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    lines.push(pad(indent) + "{}");
    return;
  }
  for (const key of keys) {
    const child = obj[key]!;
    if (isMapping(child)) {
      const childKeys = Object.keys(child as Record<string, YamlValue>);
      if (childKeys.length === 0) {
        lines.push(`${pad(indent)}${emitKey(key)}: {}`);
      } else {
        lines.push(`${pad(indent)}${emitKey(key)}:`);
        emitMapping(child as Record<string, YamlValue>, indent + 2, lines);
      }
    } else if (Array.isArray(child)) {
      if (child.length === 0) {
        lines.push(`${pad(indent)}${emitKey(key)}: []`);
      } else {
        lines.push(`${pad(indent)}${emitKey(key)}:`);
        emitSequence(child, indent, lines);
      }
    } else {
      lines.push(`${pad(indent)}${emitKey(key)}: ${emitScalar(child)}`);
    }
  }
}

function emitSequence(arr: YamlValue[], indent: number, lines: string[]): void {
  for (const item of arr) {
    if (isMapping(item)) {
      const obj = item as Record<string, YamlValue>;
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        lines.push(`${pad(indent)}- {}`);
        continue;
      }
      const first = keys[0]!;
      const firstValue = obj[first]!;
      if (isMapping(firstValue) || Array.isArray(firstValue)) {
        lines.push(`${pad(indent)}- ${emitKey(first)}:`);
        emitNode(firstValue, indent + 4, lines);
      } else {
        lines.push(
          `${pad(indent)}- ${emitKey(first)}: ${emitScalar(firstValue)}`,
        );
      }
      for (let i = 1; i < keys.length; i++) {
        const k = keys[i]!;
        const v = obj[k]!;
        if (isMapping(v) || Array.isArray(v)) {
          lines.push(`${pad(indent + 2)}${emitKey(k)}:`);
          emitNode(v, indent + 4, lines);
        } else {
          lines.push(`${pad(indent + 2)}${emitKey(k)}: ${emitScalar(v)}`);
        }
      }
    } else if (Array.isArray(item)) {
      lines.push(`${pad(indent)}-`);
      emitSequence(item, indent + 2, lines);
    } else {
      lines.push(`${pad(indent)}- ${emitScalar(item)}`);
    }
  }
}

function pad(indent: number): string {
  return " ".repeat(indent);
}

function isMapping(v: YamlValue): v is Record<string, YamlValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function emitKey(key: string): string {
  if (KEY_BARE.test(key)) return key;
  return emitDoubleQuoted(key);
}

const KEY_BARE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function emitScalar(v: string | number | boolean): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : emitDoubleQuoted(String(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  return emitDoubleQuoted(v);
}

function emitDoubleQuoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += ch;
    }
  }
  out += '"';
  return out;
}
