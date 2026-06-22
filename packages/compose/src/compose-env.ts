import { isAbsolute, resolve } from "node:path";
import type { ComposeExposePort, ComposeModeConfig } from "@worktreeos/core/config";
import type { PortAssignments } from "@worktreeos/core/state";

export class ComposeEnvError extends Error {}

/**
 * Tunnel hostname map keyed by `service -> containerPort string -> hostname`.
 * Compose-mode `${expose.<service>.hostname[<port>]}` looks up entries here
 * and falls back to `localhost` when no active tunnel exists.
 */
export type ComposeTunnelHostnames = Record<string, Record<string, string>>;

/**
 * Tunnel URL map keyed by `service -> containerPort string -> full url`.
 * Compose-mode `${expose.<service>.url[<port>]}` looks up entries here and
 * falls back to `http://localhost:<hostPort>` when no active tunnel exists.
 */
export type ComposeTunnelUrls = Record<string, Record<string, string>>;

/**
 * Resolve a compose env-file path against the worktree root. Absolute paths
 * are returned unchanged.
 */
export function resolveComposeEnvFilePath(
  raw: string,
  worktreeRoot: string,
): string {
  if (isAbsolute(raw)) return raw;
  return resolve(worktreeRoot, raw);
}

/**
 * Parse a single env-file's contents. Blank lines and `#`-comments are
 * skipped; `KEY=value` entries are returned as a string -> string map.
 * Surrounding single or double quotes around the value are stripped
 * conservatively. Malformed non-empty lines raise an actionable error
 * naming the file and line number.
 */
export function parseEnvFileContents(
  text: string,
  filePath: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new ComposeEnvError(
        `compose env-file ${filePath}: line ${i + 1} is not in KEY=value form`,
      );
    }
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ComposeEnvError(
        `compose env-file ${filePath}: line ${i + 1} has an invalid key "${key}"`,
      );
    }
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load all configured env files in listed order, returning a single merged
 * map where later files override earlier files. Missing or unreadable files
 * raise an actionable error.
 */
export async function loadComposeEnvFiles(
  envFiles: readonly string[],
  worktreeRoot: string,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const raw of envFiles) {
    const path = resolveComposeEnvFilePath(raw, worktreeRoot);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new ComposeEnvError(`compose env-file not found: ${path}`);
    }
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      throw new ComposeEnvError(
        `failed to read compose env-file ${path}: ${(e as Error).message}`,
      );
    }
    const parsed = parseEnvFileContents(text, path);
    Object.assign(merged, parsed);
  }
  return merged;
}

/**
 * Build the merged Docker Compose command environment for compose mode.
 *
 * Precedence (lowest to highest):
 *   1. process environment
 *   2. compose.env_file files, in listed order (later files override earlier)
 *   3. compose.environment (inline, with wos expose templates resolved)
 *
 * Pass the returned object as the spawned process environment when invoking
 * `docker compose ...`.
 *
 * `assignments` and `tunnelHostnames` are used to resolve wos templates
 * inside inline `compose.environment` values. When omitted, the inline
 * environment is passed through untouched — this preserves the pre-template
 * behavior for callers that have not yet wired allocations through.
 */
export async function buildComposeCommandEnvironment(opts: {
  config: ComposeModeConfig;
  worktreeRoot: string;
  processEnv?: NodeJS.ProcessEnv;
  assignments?: PortAssignments;
  tunnelHostnames?: ComposeTunnelHostnames;
  tunnelUrls?: ComposeTunnelUrls;
  /** LAN bind address that replaces the `localhost` fallback when set. */
  serviceBind?: string;
}): Promise<Record<string, string>> {
  const envFromFiles = await loadComposeEnvFiles(
    opts.config.envFile,
    opts.worktreeRoot,
  );
  const merged: Record<string, string> = {};
  const baseEnv = opts.processEnv ?? process.env;
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") merged[key] = value;
  }
  Object.assign(merged, envFromFiles);
  const inline = opts.assignments
    ? resolveComposeEnvironment(
        opts.config.environment,
        opts.config.expose,
        opts.assignments,
        opts.tunnelHostnames ?? {},
        opts.tunnelUrls ?? {},
        opts.serviceBind,
      )
    : opts.config.environment;
  Object.assign(merged, inline);
  return merged;
}

const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;

/** Bracket IPv6 literals so they are valid in a `http://<host>:<port>` URL. */
function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Resolve every `${expose.<service>.hostPort[<port>]}`,
 * `${expose.<service>.hostname[<port>]}` and `${expose.<service>.url[<port>]}`
 * template in an inline compose environment map. Unknown services,
 * unconfigured ports, or unsupported expressions raise `ComposeEnvError`.
 */
export function resolveComposeEnvironment(
  env: Record<string, string>,
  expose: readonly ComposeExposePort[],
  assignments: PortAssignments,
  tunnelHostnames: ComposeTunnelHostnames,
  tunnelUrls: ComposeTunnelUrls,
  serviceBind?: string,
): Record<string, string> {
  const services = new Map<string, Set<number>>();
  for (const e of expose) {
    let set = services.get(e.service);
    if (!set) {
      set = new Set();
      services.set(e.service, set);
    }
    set.add(e.port);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = resolveEnvValue(
      value,
      `compose.environment.${key}`,
      services,
      assignments,
      tunnelHostnames,
      tunnelUrls,
      serviceBind,
    );
  }
  return out;
}

function resolveEnvValue(
  value: string,
  field: string,
  services: Map<string, Set<number>>,
  assignments: PortAssignments,
  tunnelHostnames: ComposeTunnelHostnames,
  tunnelUrls: ComposeTunnelUrls,
  serviceBind?: string,
): string {
  return value.replace(TEMPLATE_PATTERN, (match, expr: string) => {
    return resolveExposeExpression(
      match,
      expr.trim(),
      field,
      services,
      assignments,
      tunnelHostnames,
      tunnelUrls,
      serviceBind,
    );
  });
}

function resolveExposeExpression(
  raw: string,
  expr: string,
  field: string,
  services: Map<string, Set<number>>,
  assignments: PortAssignments,
  tunnelHostnames: ComposeTunnelHostnames,
  tunnelUrls: ComposeTunnelUrls,
  serviceBind?: string,
): string {
  const m = expr.match(
    /^expose\.([A-Za-z0-9_-]+)\.(hostPort\[(\d+)\]|hostname\[(\d+)\]|url\[(\d+)\])$/,
  );
  if (!m) {
    throw new ComposeEnvError(
      `${field}: unsupported template expression "${raw}"; allowed: \${expose.<service>.hostPort[<port>]}, \${expose.<service>.hostname[<port>]} or \${expose.<service>.url[<port>]}`,
    );
  }
  const [, service, tail, hostPortStr, hostnamePortStr, urlPortStr] = m;
  const configuredPorts = services.get(service!);
  if (!configuredPorts) {
    throw new ComposeEnvError(
      `${field}: template "${raw}" references unknown compose.expose service "${service}"`,
    );
  }
  if (tail!.startsWith("hostPort")) {
    const port = Number(hostPortStr);
    if (!configuredPorts.has(port)) {
      throw new ComposeEnvError(
        `${field}: template "${raw}" references unconfigured container port ${port} for compose.expose service "${service}"`,
      );
    }
    const hostPort = assignments[service!]?.[String(port)];
    if (typeof hostPort !== "number") {
      throw new ComposeEnvError(
        `${field}: missing host-port assignment for ${service}:${port}`,
      );
    }
    return String(hostPort);
  }
  if (tail!.startsWith("url")) {
    const port = Number(urlPortStr);
    if (!configuredPorts.has(port)) {
      throw new ComposeEnvError(
        `${field}: template "${raw}" references unconfigured container port ${port} for compose.expose service "${service}"`,
      );
    }
    const url = tunnelUrls[service!]?.[String(port)];
    if (url) return url;
    const hostPort = assignments[service!]?.[String(port)];
    if (typeof hostPort !== "number") {
      throw new ComposeEnvError(
        `${field}: missing host-port assignment for ${service}:${port}`,
      );
    }
    return `http://${formatUrlHost(serviceBind ?? "localhost")}:${hostPort}`;
  }
  // hostname[<port>]
  const port = Number(hostnamePortStr);
  if (!configuredPorts.has(port)) {
    throw new ComposeEnvError(
      `${field}: template "${raw}" references unconfigured container port ${port} for compose.expose service "${service}"`,
    );
  }
  const hostname = tunnelHostnames[service!]?.[String(port)];
  return hostname ?? serviceBind ?? "localhost";
}
