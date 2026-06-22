import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Per-port healthcheck spec parsed from the deploy config. Timing fields are
 * optional: when omitted the runtime falls back to the effective defaults
 * (global `config.json` overrides or the hardcoded `DEFAULT_HEALTHCHECK_*`
 * constants below). Storing them as `undefined` here is intentional — it
 * preserves the "user did not specify" signal so that a later change to the
 * global defaults takes effect without re-parsing the deploy config.
 *
 * `expectedStatus` is also optional and `undefined` when the user did not
 * write `status:` in YAML. Undefined means lenient matching: any HTTP
 * response below 500 counts as healthy. Setting `status: N` switches to
 * strict equality with that single code.
 */
export type AppPortHealthcheck =
  | { enabled: false }
  | {
      enabled: true;
      url: string;
      expectedStatus?: number;
      timeoutMs?: number;
      startPeriodMs?: number;
      intervalMs?: number;
      retries?: number;
    };

export interface AppPortSpec {
  containerPort: number;
  healthcheck: AppPortHealthcheck;
  allowFailure: boolean;
}

export interface AppServiceConfig {
  image: string | null;
  ports: AppPortSpec[];
  script: string[];
  cwd: string | null;
  envFile: string | null;
  environment: Record<string, string>;
  volumes: string[];
  /**
   * Per-service init commands. Run inside the wos-init container after the
   * global `app.init_script` and only for services included in the resolved
   * startup selection. Default: empty list (omit field for backwards
   * compatibility with literal test fixtures).
   */
  initScript?: string[];
  /**
   * Generated service names this app service depends on. May reference other
   * `app.services` or `deps` entries. Including this service in a startup
   * selection transitively expands to all listed dependencies. Default: empty
   * list (omit field for backwards compatibility with literal test fixtures).
   */
  dependencies?: string[];
}

export const DEFAULT_HEALTHCHECK_URL = "/";
export const DEFAULT_HEALTHCHECK_STATUS = 200;
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 180_000;
export const DEFAULT_HEALTHCHECK_START_PERIOD_MS = 15_000;
export const DEFAULT_HEALTHCHECK_INTERVAL_MS = 5_000;
export const DEFAULT_HEALTHCHECK_RETRIES = 20;
/**
 * Per-HTTP-request timeout used by the wait-mode loop. Generous enough for
 * slow-warming frameworks (Spring, Rails, etc.) where the very first request
 * after compose-up can be several seconds. Status-mode (single attempt) uses
 * the shorter `SINGLE_ATTEMPT_TIMEOUT_MS` so monitoring stays snappy.
 */
export const DEFAULT_HEALTHCHECK_REQUEST_TIMEOUT_MS = 10_000;

export interface ResolvedHealthcheckDefaults {
  timeoutMs: number;
  startPeriodMs: number;
  intervalMs: number;
  retries: number;
  requestTimeoutMs: number;
}

export function hardcodedHealthcheckDefaults(): ResolvedHealthcheckDefaults {
  return {
    timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
    startPeriodMs: DEFAULT_HEALTHCHECK_START_PERIOD_MS,
    intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
    retries: DEFAULT_HEALTHCHECK_RETRIES,
    requestTimeoutMs: DEFAULT_HEALTHCHECK_REQUEST_TIMEOUT_MS,
  };
}

export function defaultAppPortHealthcheck(): AppPortHealthcheck {
  return {
    enabled: true,
    url: DEFAULT_HEALTHCHECK_URL,
  };
}

export function appPortFromNumber(containerPort: number): AppPortSpec {
  return {
    containerPort,
    healthcheck: defaultAppPortHealthcheck(),
    allowFailure: false,
  };
}

export interface AppConfig {
  image: string | null;
  initScript: string[];
  connectNpmCache?: PackageManagerCacheConfig;
  connectYarnCache?: PackageManagerCacheConfig;
  connectBunCache?: PackageManagerCacheConfig;
  services: Record<string, AppServiceConfig>;
}

export type PackageManagerCacheConfig = boolean | string;

export interface DepServiceConfig {
  image: string;
  ports: number[];
  environment: Record<string, string>;
  volumes: string[];
}

export interface HostPortRange {
  start: number;
  end: number;
}

export type CacheKey =
  | { kind: "literal"; literal: string }
  | { kind: "files"; files: string[] };

export interface CacheEntryConfig {
  key: CacheKey;
  paths: string[];
}

export interface CloneVolumeConfig {
  source: string;
  destination: string;
  displayPath: string;
}

export function cloneVolume(path: string): CloneVolumeConfig;
export function cloneVolume(source: string, destination: string): CloneVolumeConfig;
export function cloneVolume(sourceOrPath: string, destination?: string): CloneVolumeConfig {
  if (destination === undefined) {
    return { source: sourceOrPath, destination: sourceOrPath, displayPath: sourceOrPath };
  }
  return { source: sourceOrPath, destination, displayPath: `${sourceOrPath}:${destination}` };
}

export type DeploymentMode = "generated" | "compose" | "shell";

/**
 * Normalized compose-mode exposed port entry. Every `compose.expose` element
 * resolves to one of these, regardless of whether the source YAML was a
 * `service:port` string or a `{ name, port, tunnel? }` mapping.
 */
export interface ComposeExposePort {
  service: string;
  port: number;
}

export interface ComposeModeConfig {
  /**
   * Raw `compose.config` path from the deploy config. Relative paths are kept as
   * written and resolved against the current worktree root at use time.
   */
  config: string;
  /** Compose-mode exposed ports wos manages (port allocation + overlay). */
  expose: ComposeExposePort[];
  /**
   * Raw env-file paths (in listed order) merged into the Docker Compose
   * command environment. Values from later files override earlier files.
   * Paths are resolved against the worktree root at load time.
   */
  envFile: string[];
  /**
   * Inline environment passed to Docker Compose commands. Overrides values
   * loaded from `envFile`.
   */
  environment: Record<string, string>;
}

export interface WosConfig {
  /**
   * Deployment mode discriminator. Treat `undefined` as `"generated"` for
   * backwards compatibility with consumers that build a config literally
   * (tests, mock fixtures) without going through `validateConfig`.
   */
  mode?: DeploymentMode;
  cloneVolumes: CloneVolumeConfig[];
  app: AppConfig;
  deps: Record<string, DepServiceConfig>;
  hostPorts: HostPortRange;
  /**
   * Host-port assignment policy, parsed from top-level `dynamic_ports`
   * (default `true`). When `true`, wos allocates host ports from
   * `hostPorts.range`. When `false`, every declared managed port binds to the
   * same host port and conflicts fail instead of reallocating.
   */
  dynamicPorts: boolean;
  cache: CacheEntryConfig[];
  /**
   * Generated-compose startup aliases mapping a target name to a list of
   * generated service entries (either `app.services.<name>` or `deps.<name>`).
   * Optional with empty default — omit field for backwards compatibility with
   * literal test fixtures. Not used in compose mode.
   */
  targets?: Record<string, string[]>;
  /**
   * Declared runtime argument names accepted by the project. Only meaningful
   * in generated-compose mode. Optional with empty default — omit field for
   * backwards compatibility with literal test fixtures. Names are unique
   * shell environment-style identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
   */
  arguments?: string[];
  /** Present only when `mode === "compose"`. */
  compose?: ComposeModeConfig;
}

/**
 * Resolve the effective deployment mode, treating `undefined` (legacy
 * fixtures) as `"generated"`.
 */
export function deploymentModeOf(config: WosConfig): DeploymentMode {
  return config.mode ?? "generated";
}

export function isComposeMode(
  config: WosConfig,
): config is WosConfig & { mode: "compose"; compose: ComposeModeConfig } {
  return config.mode === "compose" && config.compose !== undefined;
}

export function isShellMode(
  config: WosConfig,
): config is WosConfig & { mode: "shell" } {
  return config.mode === "shell";
}

export const DEFAULT_HOST_PORT_RANGE: HostPortRange = { start: 20000, end: 29999 };

/**
 * Project-local configuration directory, resolved against the repository
 * primary/source worktree path. Distinct from `$WOS_HOME` / `~/.wos`, which is
 * runtime storage: `<source>/.wos/` is repository configuration that lives
 * beside the code.
 */
export const PROJECT_CONFIG_DIRNAME = ".wos";
/** Deploy config file used by the selected primary/source worktree. */
export const ROOT_DEPLOY_CONFIG_FILENAME = "deploy.yaml";
/** Deploy config file used by every non-source (secondary) worktree. */
export const WORKTREE_DEPLOY_CONFIG_FILENAME = "deploy.worktree.yaml";

export type DeployConfigKind = "root" | "worktree";

export interface DeployConfigSelection {
  /** Absolute path to the selected deploy config file. */
  path: string;
  /** Which deploy config the current worktree resolves to. */
  kind: DeployConfigKind;
}

/**
 * Select the effective deploy config file for a worktree from the repository
 * primary/source worktree path and the current worktree root.
 *
 * The source/root worktree resolves to `<source>/.wos/deploy.yaml`; every other
 * worktree in the same Git worktree set resolves to
 * `<source>/.wos/deploy.worktree.yaml`. Both files live in the source worktree;
 * secondary checkouts do not carry their own deploy config.
 */
export function selectDeployConfig(
  sourcePath: string,
  currentWorktreeRoot: string,
): DeployConfigSelection {
  const isSource = resolve(currentWorktreeRoot) === resolve(sourcePath);
  const kind: DeployConfigKind = isSource ? "root" : "worktree";
  const filename = isSource
    ? ROOT_DEPLOY_CONFIG_FILENAME
    : WORKTREE_DEPLOY_CONFIG_FILENAME;
  return { path: resolve(sourcePath, PROJECT_CONFIG_DIRNAME, filename), kind };
}

const REMOVED_FIELDS = ["volumes", "init-script", "publish"] as const;
const RENAMED_FIELDS: Record<string, string> = {
  init_cache: "cache",
};
const MISSPELLED_FIELDS: Record<string, string> = {
  cloned_volumes: "clone_volumes",
};

const GENERATED_ONLY_FIELDS = ["app", "deps", "targets", "arguments"] as const;

const RUNTIME_ARGUMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ConfigError extends Error {}

/**
 * Read and validate the effective project deploy config for a worktree.
 *
 * `sourcePath` MUST be the repository primary/source worktree path — wos
 * resolves it via `selectSourceWorktree()` before calling this function.
 * `currentWorktreeRoot` is the worktree the command acts on; it selects
 * `.wos/deploy.yaml` (source) versus `.wos/deploy.worktree.yaml` (secondary)
 * via {@link selectDeployConfig}. Both files live under the source worktree's
 * project-local `.wos/` directory. The runtime worktree root used to resolve
 * relative compose paths, volumes, env files, and generated output is a
 * separate concern and is NOT what these parameters select.
 */
export async function loadConfig(
  sourcePath: string,
  currentWorktreeRoot: string,
): Promise<WosConfig> {
  return loadDeployConfigFile(selectDeployConfig(sourcePath, currentWorktreeRoot));
}

/** Read and validate the deploy config file named by a resolved selection. */
export async function loadDeployConfigFile(
  selection: DeployConfigSelection,
): Promise<WosConfig> {
  const { path } = selection;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`deploy config not found at ${path}`);
  }
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    throw new ConfigError(`failed to read ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`failed to parse ${path}: ${(e as Error).message}`);
  }
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): WosConfig {
  if (raw === null || raw === undefined) {
    return defaultGeneratedConfig();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config must be a YAML mapping");
  }
  const obj = raw as Record<string, unknown>;
  rejectRemovedFields(obj);
  const mode = parseDeploymentMode(obj.mode);
  if (mode === "compose") {
    return parseComposeModeConfig(obj);
  }
  if (mode === "shell") {
    return parseShellModeConfig(obj);
  }
  if ("compose" in obj) {
    throw new ConfigError(
      `config field "compose" is no longer supported; migrate to clone_volumes, app, and deps, or set "mode: compose" to use a user-owned Docker Compose file`,
    );
  }
  const cloneVolumes = parseCloneVolumes(obj.clone_volumes);
  const app = parseApp(obj.app);
  const deps = parseDeps(obj.deps);
  const hostPorts = parseHostPorts(obj.host_ports);
  const dynamicPorts = parseDynamicPorts(obj.dynamic_ports);
  const cache = parseCache(obj.cache);
  const targets = parseTargets(obj.targets);
  const runtimeArguments = parseRuntimeArguments(obj.arguments);
  for (const [name, svc] of Object.entries(app.services)) {
    if (svc.image === null && app.image === null) {
      throw new ConfigError(
        `app.services.${name}.image is required when app.image is not set`,
      );
    }
  }
  if (app.initScript.length > 0 && app.image === null) {
    throw new ConfigError("app.image is required when app.init_script is configured");
  }
  for (const [name, svc] of Object.entries(app.services)) {
    if (svc.initScript.length > 0 && app.image === null) {
      throw new ConfigError(
        `app.image is required when app.services.${name}.init_script is configured`,
      );
    }
  }
  const knownServices = new Set<string>([
    ...Object.keys(app.services),
    ...Object.keys(deps),
  ]);
  for (const [name, svc] of Object.entries(app.services)) {
    for (let i = 0; i < svc.dependencies.length; i += 1) {
      const dep = svc.dependencies[i]!;
      if (!knownServices.has(dep)) {
        throw new ConfigError(
          `app.services.${name}.dependencies[${i}] references unknown service "${dep}"`,
        );
      }
      if (dep === name) {
        throw new ConfigError(
          `app.services.${name}.dependencies[${i}] cannot reference itself`,
        );
      }
    }
  }
  for (const [tname, entries] of Object.entries(targets)) {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      if (!knownServices.has(entry)) {
        throw new ConfigError(
          `targets.${tname}[${i}] references unknown service "${entry}"`,
        );
      }
    }
  }
  return {
    mode: "generated",
    cloneVolumes,
    app,
    deps,
    hostPorts,
    dynamicPorts,
    cache,
    targets,
    arguments: runtimeArguments,
  };
}

function defaultGeneratedConfig(): WosConfig {
  return {
    mode: "generated",
    cloneVolumes: [],
    app: {
      image: null,
      initScript: [],
      connectNpmCache: false,
      connectYarnCache: false,
      connectBunCache: false,
      services: {},
    },
    deps: {},
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    dynamicPorts: true,
    cache: [],
    targets: {},
    arguments: [],
  };
}

function parseDeploymentMode(value: unknown): DeploymentMode {
  if (value === undefined || value === null) return "generated";
  if (value === "generated" || value === "compose" || value === "shell") return value;
  throw new ConfigError(
    `mode must be "generated", "compose", or "shell"; got ${JSON.stringify(value)}`,
  );
}

function parseComposeModeConfig(obj: Record<string, unknown>): WosConfig {
  for (const field of GENERATED_ONLY_FIELDS) {
    if (field in obj) {
      throw new ConfigError(
        `config field "${field}" is only supported by generated-compose mode; remove it when "mode: compose" is set`,
      );
    }
  }
  const composeRaw = obj.compose;
  if (composeRaw === undefined || composeRaw === null) {
    throw new ConfigError(
      `"mode: compose" requires a "compose" mapping with "config" and "expose"`,
    );
  }
  if (typeof composeRaw !== "object" || Array.isArray(composeRaw)) {
    throw new ConfigError(`compose must be a mapping`);
  }
  const composeObj = composeRaw as Record<string, unknown>;
  const config = composeObj.config;
  if (typeof config !== "string" || config.length === 0) {
    throw new ConfigError(
      `compose.config is required and must be a non-empty string path to a Docker Compose file`,
    );
  }
  const exposeRaw = composeObj.expose;
  if (exposeRaw === undefined || exposeRaw === null) {
    throw new ConfigError(
      `compose.expose is required and must be a non-empty list of exposed port entries`,
    );
  }
  if (!Array.isArray(exposeRaw) || exposeRaw.length === 0) {
    throw new ConfigError(
      `compose.expose must be a non-empty list of exposed port entries`,
    );
  }
  const expose: ComposeExposePort[] = exposeRaw.map((entry, i) =>
    parseComposeExposeEntry(entry, `compose.expose[${i}]`),
  );
  const envFile = parseComposeEnvFile(composeObj.env_file);
  const environment = parseStringMap(composeObj.environment, "compose.environment");
  const cloneVolumes = parseCloneVolumes(obj.clone_volumes);
  const cache = parseCache(obj.cache);
  const hostPorts = parseHostPorts(obj.host_ports);
  const dynamicPorts = parseDynamicPorts(obj.dynamic_ports);
  return {
    mode: "compose",
    cloneVolumes,
    app: {
      image: null,
      initScript: [],
      connectNpmCache: false,
      connectYarnCache: false,
      connectBunCache: false,
      services: {},
    },
    deps: {},
    hostPorts,
    dynamicPorts,
    cache,
    targets: {},
    compose: { config, expose, envFile, environment },
  };
}

/**
 * Package-manager cache mount flags. These map a host cache directory into a
 * Docker build/run via a cache mount, so they have no meaning for host
 * processes and are rejected in shell mode.
 */
const SHELL_REJECTED_CACHE_FIELDS = [
  "connect_npm_cache",
  "connect_yarn_cache",
  "connect_bun_cache",
] as const;

function parseShellModeConfig(obj: Record<string, unknown>): WosConfig {
  if ("compose" in obj) {
    throw new ConfigError(
      `config field "compose" is only supported by "mode: compose"; remove it when "mode: shell" is set`,
    );
  }
  if ("deps" in obj) {
    throw new ConfigError(
      `dependency containers ("deps") are not supported by shell mode; shell mode runs only host processes declared under app.services`,
    );
  }
  const app = parseShellApp(obj.app);
  const cloneVolumes = parseCloneVolumes(obj.clone_volumes);
  const cache = parseCache(obj.cache);
  const hostPorts = parseHostPorts(obj.host_ports);
  const dynamicPorts = parseDynamicPorts(obj.dynamic_ports);
  const targets = parseTargets(obj.targets);
  const runtimeArguments = parseRuntimeArguments(obj.arguments);
  const knownServices = new Set<string>(Object.keys(app.services));
  for (const [name, svc] of Object.entries(app.services)) {
    const dependencies = svc.dependencies ?? [];
    for (let i = 0; i < dependencies.length; i += 1) {
      const dep = dependencies[i]!;
      if (!knownServices.has(dep)) {
        throw new ConfigError(
          `app.services.${name}.dependencies[${i}] references unknown service "${dep}"`,
        );
      }
      if (dep === name) {
        throw new ConfigError(
          `app.services.${name}.dependencies[${i}] cannot reference itself`,
        );
      }
    }
  }
  for (const [tname, entries] of Object.entries(targets)) {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      if (!knownServices.has(entry)) {
        throw new ConfigError(
          `targets.${tname}[${i}] references unknown service "${entry}"`,
        );
      }
    }
  }
  return {
    mode: "shell",
    cloneVolumes,
    app,
    deps: {},
    hostPorts,
    dynamicPorts,
    cache,
    targets,
    arguments: runtimeArguments,
  };
}

function parseShellApp(value: unknown): AppConfig {
  if (value === undefined || value === null) {
    return {
      image: null,
      initScript: [],
      connectNpmCache: false,
      connectYarnCache: false,
      connectBunCache: false,
      services: {},
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("app must be a mapping");
  }
  const obj = value as Record<string, unknown>;
  if ("image" in obj && obj.image !== null && obj.image !== undefined) {
    throw new ConfigError(
      `app.image is not supported by shell mode; Docker images are not supported by shell mode, which runs host processes`,
    );
  }
  for (const field of SHELL_REJECTED_CACHE_FIELDS) {
    if (field in obj) {
      throw new ConfigError(
        `app.${field} is not supported by shell mode; package-manager cache mounts require Docker`,
      );
    }
  }
  const initScript = parseStringList(obj.init_script, "app.init_script");
  const services = parseShellAppServices(obj.services);
  return {
    image: null,
    initScript,
    connectNpmCache: false,
    connectYarnCache: false,
    connectBunCache: false,
    services,
  };
}

function parseShellAppServices(value: unknown): Record<string, AppServiceConfig> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("app.services must be a mapping of service name -> config");
  }
  const result: Record<string, AppServiceConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`app.services.${name} must be a mapping with a script`);
    }
    const obj = raw as Record<string, unknown>;
    if ("image" in obj && obj.image !== null && obj.image !== undefined) {
      throw new ConfigError(
        `app.services.${name}.image is not supported by shell mode; Docker images are not supported by shell mode, which runs host processes`,
      );
    }
    if ("volumes" in obj) {
      throw new ConfigError(
        `app.services.${name}.volumes is not supported by shell mode; Docker volume mounts are not supported by shell mode`,
      );
    }
    const script = parseStringList(obj.script, `app.services.${name}.script`);
    if (script.length === 0) {
      throw new ConfigError(
        `app.services.${name}.script is required and must contain at least one command in shell mode`,
      );
    }
    result[name] = {
      image: null,
      ports: parseAppPortList(obj.ports, `app.services.${name}.ports`),
      script,
      cwd: parseOptionalString(obj.cwd, `app.services.${name}.cwd`),
      envFile: parseOptionalString(obj.env_file, `app.services.${name}.env_file`),
      environment: parseStringMap(obj.environment, `app.services.${name}.environment`),
      volumes: [],
      initScript: parseStringList(obj.init_script, `app.services.${name}.init_script`),
      dependencies: parseStringList(obj.dependencies, `app.services.${name}.dependencies`),
    };
  }
  return result;
}

function parseComposeExposeEntry(raw: unknown, field: string): ComposeExposePort {
  if (typeof raw === "string") {
    if (raw.length === 0) {
      throw new ConfigError(
        `${field} must be a non-empty "service:port" string or a mapping with name and port`,
      );
    }
    const colonIndex = raw.indexOf(":");
    if (colonIndex === -1) {
      throw new ConfigError(
        `${field} must be in "service:port" form; plain service names are no longer supported`,
      );
    }
    const service = raw.slice(0, colonIndex);
    const portStr = raw.slice(colonIndex + 1);
    if (service.length === 0) {
      throw new ConfigError(`${field} has an empty service name`);
    }
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(
        `${field} container port must be an integer in 1..65535 (got "${portStr}")`,
      );
    }
    return { service, port };
  }
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `${field} must be a "service:port" string or a mapping with name and port`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ConfigError(`${field}.name must be a non-empty string`);
  }
  const portValue = obj.port;
  if (
    typeof portValue !== "number" ||
    !Number.isInteger(portValue) ||
    portValue < 1 ||
    portValue > 65535
  ) {
    throw new ConfigError(`${field}.port must be an integer port in 1..65535`);
  }
  if ("tunnel" in obj) {
    throw new ConfigError(
      `${field}.tunnel is no longer supported; tunnels are configured in <wos-home>/config.json under "tunnel". Enable service tunnel publication with "tunnel.serviceTunnels.enabled", and use "wos up --no-tunnel" to opt out per run.`,
    );
  }
  return { service: name, port: portValue };
}

function parseComposeEnvFile(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new ConfigError(`compose.env_file must be a non-empty string or list of strings`);
    }
    return [value];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`compose.env_file must be a string or list of strings`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(`compose.env_file[${i}] must be a non-empty string`);
    }
    return entry;
  });
}

function parseHostPorts(value: unknown): HostPortRange {
  if (value === undefined || value === null) {
    return { ...DEFAULT_HOST_PORT_RANGE };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("host_ports must be a mapping");
  }
  const obj = value as Record<string, unknown>;
  const range = obj.range;
  if (range === undefined || range === null) {
    return { ...DEFAULT_HOST_PORT_RANGE };
  }
  if (typeof range !== "object" || Array.isArray(range)) {
    throw new ConfigError("host_ports.range must be a mapping with start and end");
  }
  const rangeObj = range as Record<string, unknown>;
  const start = parsePortNumber(rangeObj.start, "host_ports.range.start");
  const end = parsePortNumber(rangeObj.end, "host_ports.range.end");
  if (start > end) {
    throw new ConfigError(
      `host_ports.range.start (${start}) must be less than or equal to host_ports.range.end (${end})`,
    );
  }
  return { start, end };
}

function parsePortNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${field} must be an integer port in 1..65535`);
  }
  return value;
}

function parseDynamicPorts(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") {
    throw new ConfigError("dynamic_ports must be a boolean");
  }
  return value;
}

function rejectRemovedFields(obj: Record<string, unknown>): void {
  for (const field of REMOVED_FIELDS) {
    if (field in obj) {
      throw new ConfigError(
        `config field "${field}" is no longer supported; migrate to clone_volumes, app, and deps`,
      );
    }
  }
  for (const [oldField, newField] of Object.entries(RENAMED_FIELDS)) {
    if (oldField in obj) {
      throw new ConfigError(
        `config field "${oldField}" has been renamed; rename it to "${newField}"`,
      );
    }
  }
  for (const [bad, good] of Object.entries(MISSPELLED_FIELDS)) {
    if (bad in obj) {
      throw new ConfigError(
        `config field "${bad}" is not a supported field; did you mean "${good}"?`,
      );
    }
  }
}

function parseApp(value: unknown): AppConfig {
  if (value === undefined || value === null) {
    return {
      image: null,
      initScript: [],
      connectNpmCache: false,
      connectYarnCache: false,
      connectBunCache: false,
      services: {},
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("app must be a mapping");
  }
  const obj = value as Record<string, unknown>;
  const image = parseOptionalString(obj.image, "app.image");
  const initScript = parseStringList(obj.init_script, "app.init_script");
  const connectNpmCache = parsePackageManagerCacheConfig(
    obj.connect_npm_cache,
    "app.connect_npm_cache",
  );
  const connectYarnCache = parsePackageManagerCacheConfig(
    obj.connect_yarn_cache,
    "app.connect_yarn_cache",
  );
  const connectBunCache = parsePackageManagerCacheConfig(
    obj.connect_bun_cache,
    "app.connect_bun_cache",
  );
  const services = parseAppServices(obj.services);
  return {
    image,
    initScript,
    connectNpmCache,
    connectYarnCache,
    connectBunCache,
    services,
  };
}

function parsePackageManagerCacheConfig(
  value: unknown,
  field: string,
): PackageManagerCacheConfig {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.length > 0) {
    if (value === "~" || value.startsWith("~/") || isAbsolute(value)) {
      return value;
    }
    throw new ConfigError(`${field} must be a boolean, an absolute path, or a ~/ path`);
  }
  throw new ConfigError(`${field} must be a boolean or a non-empty host path string`);
}

function parseAppServices(value: unknown): Record<string, AppServiceConfig> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("app.services must be a mapping of service name -> config");
  }
  const result: Record<string, AppServiceConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) {
      result[name] = {
        image: null,
        ports: [],
        script: [],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
        initScript: [],
        dependencies: [],
      };
      continue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`app.services.${name} must be a mapping`);
    }
    const obj = raw as Record<string, unknown>;
    result[name] = {
      image: parseOptionalString(obj.image, `app.services.${name}.image`),
      ports: parseAppPortList(obj.ports, `app.services.${name}.ports`),
      script: parseStringList(obj.script, `app.services.${name}.script`),
      cwd: parseOptionalString(obj.cwd, `app.services.${name}.cwd`),
      envFile: parseOptionalString(obj.env_file, `app.services.${name}.env_file`),
      environment: parseStringMap(obj.environment, `app.services.${name}.environment`),
      volumes: parseStringList(obj.volumes, `app.services.${name}.volumes`),
      initScript: parseStringList(obj.init_script, `app.services.${name}.init_script`),
      dependencies: parseStringList(obj.dependencies, `app.services.${name}.dependencies`),
    };
  }
  return result;
}

function parseTargets(value: unknown): Record<string, string[]> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("targets must be a mapping of target name -> service list");
  }
  const result: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0) {
      throw new ConfigError(`targets has an empty target name`);
    }
    if (!Array.isArray(raw)) {
      throw new ConfigError(`targets.${name} must be a non-empty list of service names`);
    }
    if (raw.length === 0) {
      throw new ConfigError(`targets.${name} must be a non-empty list of service names`);
    }
    const entries: string[] = raw.map((entry, i) => {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new ConfigError(`targets.${name}[${i}] must be a non-empty string`);
      }
      return entry;
    });
    result[name] = entries;
  }
  return result;
}

function parseRuntimeArguments(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("arguments must be a list of runtime argument names");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(`arguments[${i}] must be a non-empty string`);
    }
    if (!RUNTIME_ARGUMENT_NAME_PATTERN.test(entry)) {
      throw new ConfigError(
        `arguments[${i}] must be a shell environment-style identifier matching ${RUNTIME_ARGUMENT_NAME_PATTERN.source} (got "${entry}")`,
      );
    }
    if (seen.has(entry)) {
      throw new ConfigError(`arguments[${i}] duplicates runtime argument "${entry}"`);
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function parseDeps(value: unknown): Record<string, DepServiceConfig> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("deps must be a mapping of service name -> config");
  }
  const result: Record<string, DepServiceConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`deps.${name} must be a mapping with at least image`);
    }
    const obj = raw as Record<string, unknown>;
    const image = parseRequiredString(obj.image, `deps.${name}.image`);
    const ports = parsePortList(obj.ports, `deps.${name}.ports`);
    const environment = parseStringMap(obj.environment, `deps.${name}.environment`);
    const volumes = parseStringList(obj.volumes, `deps.${name}.volumes`);
    result[name] = { image, ports, environment, volumes };
  }
  return result;
}

function parseOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${field} is required and must be a non-empty string`);
  }
  return value;
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * Index of the mapping-separator colon in a `source:destination` path string,
 * skipping a leading Windows drive prefix (`C:\` / `C:/`) so drive-letter
 * colons are never treated as separators. Returns -1 for a single path.
 */
export function pathMappingSeparatorIndex(entry: string): number {
  const searchFrom = WINDOWS_DRIVE_PREFIX.test(entry) ? 2 : 0;
  return entry.indexOf(":", searchFrom);
}

function parseCloneVolumes(value: unknown): CloneVolumeConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("clone_volumes must be a list");
  }
  return value.map((entry, i) => {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.source !== "string" || obj.source.length === 0) {
        throw new ConfigError(
          `clone_volumes[${i}] object entry requires a non-empty string "source"`,
        );
      }
      if (typeof obj.destination !== "string" || obj.destination.length === 0) {
        throw new ConfigError(
          `clone_volumes[${i}] object entry requires a non-empty string "destination"`,
        );
      }
      return {
        source: obj.source,
        destination: obj.destination,
        displayPath: `${obj.source}:${obj.destination}`,
      };
    }
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(
        `clone_volumes[${i}] must be a non-empty string or a { source, destination } object`,
      );
    }
    const colonIndex = pathMappingSeparatorIndex(entry);
    if (colonIndex === -1) {
      return { source: entry, destination: entry, displayPath: entry };
    }
    const source = entry.slice(0, colonIndex);
    const destination = entry.slice(colonIndex + 1);
    if (source.length === 0) {
      throw new ConfigError(`clone_volumes[${i}] mapped entry has an empty source`);
    }
    if (destination.length === 0) {
      throw new ConfigError(`clone_volumes[${i}] mapped entry has an empty destination`);
    }
    return { source, destination, displayPath: entry };
  });
}

function parseStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a list`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(`${field}[${i}] must be a non-empty string`);
    }
    return entry;
  });
}

function parsePortList(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a list of ports`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > 65535) {
      throw new ConfigError(`${field}[${i}] must be an integer port in 1..65535`);
    }
    return entry;
  });
}

function parseAppPortList(value: unknown, field: string): AppPortSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a list of ports`);
  }
  return value.map((entry, i) => parseAppPortEntry(entry, `${field}[${i}]`));
}

function parseAppPortEntry(raw: unknown, field: string): AppPortSpec {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
      throw new ConfigError(`${field} must be an integer port in 1..65535`);
    }
    return {
      containerPort: raw,
      healthcheck: defaultAppPortHealthcheck(),
      allowFailure: false,
    };
  }
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `${field} must be an integer port or a mapping with "port"`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!("port" in obj)) {
    throw new ConfigError(`${field}.port is required`);
  }
  const portValue = obj.port;
  if (
    typeof portValue !== "number" ||
    !Number.isInteger(portValue) ||
    portValue < 1 ||
    portValue > 65535
  ) {
    throw new ConfigError(`${field}.port must be an integer port in 1..65535`);
  }
  if ("tunnel" in obj) {
    throw new ConfigError(
      `${field}.tunnel is no longer supported; tunnels are configured in <wos-home>/config.json under "tunnel". Enable service tunnel publication with "tunnel.serviceTunnels.enabled", and use "wos up --no-tunnel" to opt out per run.`,
    );
  }
  const healthcheck = parseAppPortHealthcheck(obj.healthcheck, `${field}.healthcheck`);
  const allowFailure = parseAppPortAllowFailure(obj.allow_failure, `${field}.allow_failure`);
  return {
    containerPort: portValue,
    healthcheck,
    allowFailure,
  };
}

function parseAppPortHealthcheck(value: unknown, field: string): AppPortHealthcheck {
  if (value === undefined || value === null) return defaultAppPortHealthcheck();
  if (value === false) return { enabled: false };
  if (value === true) return defaultAppPortHealthcheck();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be a boolean or a mapping with healthcheck options`);
  }
  const obj = value as Record<string, unknown>;
  const url = parseAppPortHealthcheckUrl(obj.url, `${field}.url`);
  const expectedStatus = parseOptionalHealthcheckStatus(obj.status, `${field}.status`);
  const timeoutMs = parseOptionalDuration(obj.timeout, `${field}.timeout`);
  const startPeriodMs = parseOptionalDuration(obj.start_period, `${field}.start_period`);
  const intervalMs = parseOptionalDuration(obj.interval, `${field}.interval`);
  const retries = parseOptionalRetries(obj.retries, `${field}.retries`);
  const hc: AppPortHealthcheck = { enabled: true, url };
  if (expectedStatus !== undefined) hc.expectedStatus = expectedStatus;
  if (timeoutMs !== undefined) hc.timeoutMs = timeoutMs;
  if (startPeriodMs !== undefined) hc.startPeriodMs = startPeriodMs;
  if (intervalMs !== undefined) hc.intervalMs = intervalMs;
  if (retries !== undefined) hc.retries = retries;
  return hc;
}

function parseAppPortHealthcheckUrl(value: unknown, field: string): string {
  if (value === undefined || value === null) return DEFAULT_HEALTHCHECK_URL;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${field} must be a non-empty absolute path starting with "/"`);
  }
  if (!value.startsWith("/")) {
    throw new ConfigError(`${field} must be an absolute path starting with "/"`);
  }
  return value;
}

function parseOptionalHealthcheckStatus(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new ConfigError(`${field} must be an integer HTTP status in 100..599`);
  }
  return value;
}

function parseOptionalDuration(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return parseDurationValue(value, field);
}

/**
 * Parse a duration accepted from a config file. Numbers are treated as
 * milliseconds; strings accept `ms`, `s`, or `m` suffixes (defaulting to `ms`
 * when omitted). Exposed for the global-config parser so JSON and YAML share
 * the same format.
 */
export function parseDurationValue(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`${field} must be a positive duration`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${field} must be a positive duration`);
  }
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(trimmed);
  if (!match) {
    throw new ConfigError(`${field} must be a positive duration`);
  }
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new ConfigError(`${field} must be a positive duration`);
  }
  const suffix = (match[2] ?? "ms").toLowerCase();
  let ms: number;
  if (suffix === "ms") ms = numeric;
  else if (suffix === "s") ms = numeric * 1000;
  else if (suffix === "m") ms = numeric * 60 * 1000;
  else throw new ConfigError(`${field} must be a positive duration`);
  ms = Math.round(ms);
  if (ms <= 0) {
    throw new ConfigError(`${field} must be a positive duration`);
  }
  return ms;
}

function parseOptionalRetries(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return parseRetriesValue(value, field);
}

export function parseRetriesValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${field} must be a positive integer`);
  }
  return value;
}

function parseAppPortAllowFailure(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${field} must be a boolean`);
  }
  return value;
}

function parseCache(value: unknown): CacheEntryConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("cache must be a list of cache entries");
  }
  return value.map((raw, i) => parseCacheEntry(raw, i));
}

function parseCacheEntry(raw: unknown, index: number): CacheEntryConfig {
  const field = `cache[${index}]`;
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${field} must be a mapping with key and paths`);
  }
  const obj = raw as Record<string, unknown>;
  if (!("key" in obj)) {
    throw new ConfigError(`${field}.key is required`);
  }
  if (!("paths" in obj)) {
    throw new ConfigError(`${field}.paths is required`);
  }
  const key = parseCacheKey(obj.key, `${field}.key`);
  const paths = parseCachePaths(obj.paths, `${field}.paths`);
  return { key, paths };
}

function parseCacheKey(value: unknown, field: string): CacheKey {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new ConfigError(`${field} must be a non-empty string`);
    }
    return { kind: "literal", literal: value };
  }
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${field} must be a non-empty string or a mapping with "files"`,
    );
  }
  const obj = value as Record<string, unknown>;
  if (!("files" in obj)) {
    throw new ConfigError(`${field}.files is required when ${field} is a mapping`);
  }
  const files = parseCachePathEntries(obj.files, `${field}.files`);
  if (files.length === 0) {
    throw new ConfigError(`${field}.files must not be empty`);
  }
  return { kind: "files", files };
}

function parseCachePaths(value: unknown, field: string): string[] {
  const paths = parseCachePathEntries(value, field);
  if (paths.length === 0) {
    throw new ConfigError(`${field} must not be empty`);
  }
  return paths;
}

function parseCachePathEntries(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a list of relative paths inside the worktree`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigError(`${field}[${i}] must be a non-empty string`);
    }
    if (isAbsolute(entry)) {
      throw new ConfigError(
        `${field}[${i}] must be a relative path inside the worktree, got "${entry}"`,
      );
    }
    const normalized = normalize(entry);
    if (normalized === ".." || normalized === "." || normalized.startsWith(`..${sep}`)) {
      throw new ConfigError(
        `${field}[${i}] must resolve strictly inside the worktree, got "${entry}"`,
      );
    }
    return entry;
  });
}

function parseStringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be a mapping of string -> string`);
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      result[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      result[key] = String(raw);
    } else {
      throw new ConfigError(`${field}.${key} must be a string, number, or boolean`);
    }
  }
  return result;
}
