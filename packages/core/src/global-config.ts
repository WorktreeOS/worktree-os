import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  hardcodedHealthcheckDefaults,
  parseDurationValue,
  parseRetriesValue,
  type ResolvedHealthcheckDefaults,
} from "./config";
import {
  defaultNotificationRule,
  defaultNotificationsConfig,
  type NotificationChannelsConfig,
  type NotificationRule,
  type NotificationsConfig,
  type PushSubscription,
  redactNotificationsConfig,
} from "./notifications";
import { wosHome } from "./paths";
import type { RepoConfig } from "./repo-config";

export const DEFAULT_WEB_PORT = 4949;
export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_TUNNEL_PORT = 5858;
export const GLOBAL_CONFIG_FILENAME = "config.json";

export type TerminalBackendId = "default" | "tmux";
export const DEFAULT_TERMINAL_BACKEND: TerminalBackendId = "default";
export const SUPPORTED_TERMINAL_BACKENDS: readonly TerminalBackendId[] = [
  "default",
  "tmux",
];

function isTerminalBackendId(value: unknown): value is TerminalBackendId {
  return value === "default" || value === "tmux";
}

export type SslCertificateSource = "files" | "self-signed" | "letsencrypt";
export const SUPPORTED_SSL_SOURCES: readonly SslCertificateSource[] = [
  "files",
  "self-signed",
  "letsencrypt",
];

function isSslCertificateSource(value: unknown): value is SslCertificateSource {
  return value === "files" || value === "self-signed" || value === "letsencrypt";
}

export type LetsEncryptDirectory = "staging" | "production";
export const DEFAULT_LETSENCRYPT_DIRECTORY: LetsEncryptDirectory = "staging";

function isLetsEncryptDirectory(value: unknown): value is LetsEncryptDirectory {
  return value === "staging" || value === "production";
}

export interface LetsEncryptHookChallenge {
  type: "dns-01";
  provider: "hook";
  createCommand: string;
  deleteCommand: string;
  propagationSeconds: number;
}

export interface LetsEncryptCloudflareChallenge {
  type: "dns-01";
  provider: "cloudflare";
  /** Environment variable name that holds the Cloudflare API token. */
  apiTokenEnv?: string;
  /** Direct Cloudflare API token. Used only when `apiTokenEnv` is unset. */
  apiToken?: string;
  /** Optional explicit zone id; when omitted the daemon discovers it. */
  zoneId?: string;
  propagationSeconds: number;
}

export type LetsEncryptChallenge =
  | LetsEncryptHookChallenge
  | LetsEncryptCloudflareChallenge;

export type LetsEncryptChallengeProvider = LetsEncryptChallenge["provider"];

export const SUPPORTED_LETSENCRYPT_PROVIDERS: readonly LetsEncryptChallengeProvider[] = [
  "hook",
  "cloudflare",
];

function isLetsEncryptProvider(
  value: unknown,
): value is LetsEncryptChallengeProvider {
  return value === "hook" || value === "cloudflare";
}

export interface LetsEncryptConfig {
  email: string;
  acceptTerms: true;
  directory: LetsEncryptDirectory;
  challenge: LetsEncryptChallenge;
}

export type GlobalSslConfig =
  | { enabled: false }
  | { enabled: true; source: "files"; cert: string; key: string }
  | { enabled: true; source: "self-signed" }
  | { enabled: true; source: "letsencrypt"; letsencrypt: LetsEncryptConfig };

/**
 * Tunnel Web UI publication settings. When `enabled`, the daemon registers a
 * daemon-scoped tunnel route for the Web UI hostname and applies public-auth
 * gating (signed cookie) plus an optional client IP whitelist.
 */
export type GlobalTunnelWebUiConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Effective public Web UI hostname under `tunnel.domain`. */
      hostname: string;
      /** Secret used to sign and verify the public auth cookie. */
      secret: string;
      /** When true, public users may use terminal endpoints after login. */
      terminalEnabled: boolean;
      /** Exact client IPs allowed through. Empty list = allow all. */
      whitelistIps: string[];
    };

/**
 * Service tunnel publication settings. When `enabled`, `wos up` registers
 * tunnel routes for each managed service port; the tunnel listener applies an
 * optional client IP whitelist before proxying.
 */
export interface GlobalServiceTunnelsConfig {
  enabled: boolean;
  /** Exact client IPs allowed through service routes. Empty list = allow all. */
  whitelistIps: string[];
}

export type GlobalTunnelConfig =
  | {
      enabled: false;
      port: number;
      /**
       * Port advertised in tunnel URLs. When unset, URL builders fall back to
       * `port`. Use this when wos sits behind a reverse proxy / NAT that
       * exposes the tunnel on a port different from the listener bind port.
       */
      publicPort?: number;
      ssl: GlobalSslConfig;
      webUi: GlobalTunnelWebUiConfig;
      serviceTunnels: GlobalServiceTunnelsConfig;
    }
  | {
      enabled: true;
      port: number;
      publicPort?: number;
      domain: string;
      ssl: GlobalSslConfig;
      webUi: GlobalTunnelWebUiConfig;
      serviceTunnels: GlobalServiceTunnelsConfig;
    };

/**
 * User-supplied overrides for the runtime healthcheck timing defaults. Any
 * field omitted falls back to the hardcoded `DEFAULT_HEALTHCHECK_*` constants;
 * per-port settings in the deploy config always win over these.
 */
export interface GlobalHealthcheckConfig {
  timeoutMs?: number;
  startPeriodMs?: number;
  intervalMs?: number;
  retries?: number;
  /**
   * Per-HTTP-attempt timeout for wait-mode polling. Bump this when targeting
   * slow-warming frameworks where the first request after compose-up exceeds
   * the default 10s.
   */
  requestTimeoutMs?: number;
}

export type AiProviderType =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-like"
  | "anthropic-like";

export const SUPPORTED_AI_PROVIDER_TYPES: readonly AiProviderType[] = [
  "openai",
  "anthropic",
  "openrouter",
  "openai-like",
  "anthropic-like",
];

function isAiProviderType(value: unknown): value is AiProviderType {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "openrouter" ||
    value === "openai-like" ||
    value === "anthropic-like"
  );
}

/**
 * A locally configured LLM API provider. `apiKey` is required; `name`,
 * `baseUrl`, and `models` are optional user-declared metadata. `models` is an
 * ordered list of provider-declared model identifiers treated as availability
 * hints — wos never calls the provider to verify them.
 */
export interface AiProviderConfig {
  type: AiProviderType;
  apiKey: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
}

/**
 * Optional default provider/model for AI commit-message generation. `provider`
 * names one of the configured `aiProviders` (by its `name`); both fields are
 * empty when unset, in which case the Review commit composer falls back to the
 * first configured provider.
 */
export interface CommitMessagesConfig {
  provider?: string;
  model?: string;
}

/**
 * Ordered daemon log levels. `off` silences a logger or module entirely; the
 * remaining levels widen from least to most verbose. The numeric ordering used
 * for threshold comparisons lives in the daemon logger, not here.
 */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

export const SUPPORTED_LOG_LEVELS: readonly LogLevel[] = [
  "off",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Performance-span settings. `slowMs` maps an operation key (`git`, `compose`,
 * `docker-http`, `process-detect`, `attach`, `resolve-session`) to its
 * slow-threshold in milliseconds; a `default` key applies to any op without an
 * explicit entry. The stuck-span watchdog reports an in-flight operation that
 * exceeds its threshold before it settles.
 */
export interface LoggingPerfConfig {
  enabled: boolean;
  stuckWatchdog: boolean;
  slowMs: Record<string, number>;
}

/**
 * Daemon file-logging settings. Disabled by default; when `enabled` is false
 * the daemon opens no log file and every logging call is a no-op. `modules`
 * overrides the global `level` per module name; `file` defaults to
 * `<wos-home>/logs/daemon.log` (resolved by the daemon). `redactPrompts`
 * (default true) keeps free-text user prompt content out of the log.
 */
export interface LoggingConfig {
  enabled: boolean;
  level: LogLevel;
  modules: Record<string, LogLevel>;
  /** Absolute or relative log file path; daemon falls back to the default. */
  file?: string;
  redactPrompts: boolean;
  perf: LoggingPerfConfig;
}

export interface GlobalConfig {
  web: {
    port: number;
    /**
     * Address the daemon web UI / UI API listener binds to. Defaults to
     * `127.0.0.1`. A single address only — comma-separated lists are not
     * supported.
     */
    host: string;
    ssl: GlobalSslConfig;
  };
  tunnel: GlobalTunnelConfig;
  healthcheck: GlobalHealthcheckConfig;
  terminalBackend: TerminalBackendId;
  /**
   * Optional shell command used to open a worktree in a local editor. The
   * worktree path is supplied via the `WOS_WORKTREE_PATH` environment variable
   * and an optional shell-quoted `{path}` token. Unset = feature off.
   */
  editorCommand?: string;
  /**
   * Optional LAN address used to publish and advertise managed service ports.
   * When unset, compose publishes the prior single mapping and template
   * hostname/url fallbacks resolve to `localhost`. When set, compose publishes
   * each managed port on both loopback and this address, and the `localhost`
   * template fallbacks resolve to this address instead. Advisory only in shell
   * mode (wos cannot force a host process to bind a specific interface).
   */
  serviceBind?: string;
  /**
   * Locally configured LLM API providers. Empty when none are set. API keys
   * are stored in plaintext in `<wos-home>/config.json` and are only exposed
   * through the local-only settings management flow.
   */
  aiProviders: AiProviderConfig[];
  /**
   * Default provider/model for AI commit-message generation, selected from
   * `aiProviders` by name. Empty `{}` when unset.
   */
  commitMessages: CommitMessagesConfig;
  /**
   * When true, wos wires agent activity plugins automatically: Claude Code
   * hook configuration and the OpenCode plugin entry are kept installed in
   * the user-level agent configs. Default off.
   */
  autoInjectAgentPlugins: boolean;
  /**
   * Daemon file-logging settings. Disabled by default; controls the opt-in
   * leveled file logger, its per-module thresholds, and performance spans.
   */
  logging: LoggingConfig;
  /**
   * Notification engine settings: per-kind rules, attachment suppression,
   * channel credentials, and the registered Web Push subscriptions. Disabled
   * by default; an absent block yields built-in defaults.
   */
  notifications: NotificationsConfig;
}

/** Default disabled-by-default daemon logging settings. */
export function defaultLoggingConfig(): LoggingConfig {
  return {
    enabled: false,
    level: "info",
    modules: {},
    redactPrompts: true,
    perf: { enabled: true, stuckWatchdog: true, slowMs: { default: 1000 } },
  };
}

/**
 * Compose the effective healthcheck defaults (hardcoded constants merged with
 * `config.json` overrides). Use this in runtime code to resolve timing when
 * a per-port spec leaves a field undefined.
 */
export function effectiveHealthcheckDefaults(
  config: GlobalConfig | undefined,
): ResolvedHealthcheckDefaults {
  const base = hardcodedHealthcheckDefaults();
  const override = config?.healthcheck;
  if (!override) return base;
  return {
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    startPeriodMs: override.startPeriodMs ?? base.startPeriodMs,
    intervalMs: override.intervalMs ?? base.intervalMs,
    retries: override.retries ?? base.retries,
    requestTimeoutMs: override.requestTimeoutMs ?? base.requestTimeoutMs,
  };
}

/**
 * Dotted config paths that are applied to the live daemon without a restart.
 * A save that changes only these fields does not require a daemon restart.
 *
 * - `aiProviders` / `commitMessages` / `editorCommand` are re-read fresh per
 *   request by the UI API and are already live.
 * - `healthcheck` defaults are resolved per `up`/status operation.
 * - `tunnel.serviceTunnels.whitelistIps` is re-applied to the tunnel route
 *   policy on save (affects subsequently opened/restored service tunnels).
 * - `notifications` is owned by the dedicated notification endpoints and never
 *   travels in the settings draft, so a change here never requires a restart.
 * - `serviceBind` is consumed fresh at compose-generation time, not bound to a
 *   startup resource.
 *
 * Everything NOT covered by this list (web/tunnel listener sockets, SSL,
 * tunnel.webUi, serviceTunnels.enabled, terminalBackend, autoInjectAgentPlugins,
 * logging) is captured at daemon startup and requires a restart. New/unknown
 * fields are intentionally NOT live-applicable so they err toward restart.
 */
export const LIVE_APPLICABLE_CONFIG_PATHS: readonly string[] = [
  "aiProviders",
  "commitMessages",
  "editorCommand",
  "serviceBind",
  "healthcheck",
  "notifications",
  "tunnel.serviceTunnels.whitelistIps",
];

function isLiveApplicablePath(path: string): boolean {
  return LIVE_APPLICABLE_CONFIG_PATHS.some(
    (live) => path === live || path.startsWith(`${live}.`),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectChangedPaths(
  a: unknown,
  b: unknown,
  prefix: string,
  out: string[],
): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      collectChangedPaths(a[key], b[key], childPrefix, out);
    }
    return;
  }
  // Leaf comparison: primitives, arrays, or an object-vs-non-object mismatch.
  if (!valuesEqual(a, b)) out.push(prefix);
}

/**
 * Return the dotted leaf paths whose effective values differ between two
 * resolved global configs. Recurses into plain objects; arrays and primitives
 * are compared as leaves by structural equality (so e.g. a whitelist change
 * yields `tunnel.serviceTunnels.whitelistIps`).
 */
export function diffChangedPaths(
  prev: GlobalConfig,
  next: GlobalConfig,
): string[] {
  const out: string[] = [];
  collectChangedPaths(prev, next, "", out);
  return out;
}

/**
 * Decide whether persisting `next` over `prev` requires a daemon restart. A
 * restart is required iff at least one changed field is not live-applicable.
 */
export function restartRequiredForSave(
  prev: GlobalConfig,
  next: GlobalConfig,
): boolean {
  return diffChangedPaths(prev, next).some(
    (path) => !isLiveApplicablePath(path),
  );
}

export interface LoadGlobalConfigOptions {
  env?: NodeJS.ProcessEnv;
  stderrWrite?: (text: string) => void;
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(wosHome(env), GLOBAL_CONFIG_FILENAME);
}

export function defaultGlobalConfig(): GlobalConfig {
  return {
    web: {
      port: DEFAULT_WEB_PORT,
      host: DEFAULT_WEB_HOST,
      ssl: { enabled: false },
    },
    tunnel: {
      enabled: false,
      port: DEFAULT_TUNNEL_PORT,
      ssl: { enabled: false },
      webUi: { enabled: false },
      serviceTunnels: { enabled: false, whitelistIps: [] },
    },
    healthcheck: {},
    terminalBackend: DEFAULT_TERMINAL_BACKEND,
    aiProviders: [],
    commitMessages: {},
    autoInjectAgentPlugins: false,
    logging: defaultLoggingConfig(),
    notifications: defaultNotificationsConfig(),
  };
}

export interface ResolvedCommitMessageProvider {
  /** The provider configuration to call. */
  provider: AiProviderConfig;
  /** Resolved model override, when one was configured. */
  model?: string;
}

/**
 * Resolves which AI provider/model to use for commit-message generation,
 * applying the order: repository `commit.message.{provider,model}` → global
 * `commitMessages.{provider,model}` → first configured `aiProviders[]` → none.
 * `provider` is matched against each `aiProviders[].name`. Returns `undefined`
 * when no provider is configured at all.
 */
export function resolveCommitMessageProvider(
  repoConfig: RepoConfig,
  globalConfig: GlobalConfig,
): ResolvedCommitMessageProvider | undefined {
  const providers = globalConfig.aiProviders;
  if (providers.length === 0) return undefined;
  const repo = repoConfig.commit.message;
  const global = globalConfig.commitMessages;
  const model = repo.model ?? global.model;

  const repoProvider = repo.provider
    ? providers.find((p) => p.name === repo.provider)
    : undefined;
  if (repoProvider) return { provider: repoProvider, model };

  const globalProvider = global.provider
    ? providers.find((p) => p.name === global.provider)
    : undefined;
  if (globalProvider) return { provider: globalProvider, model };

  return { provider: providers[0]!, model };
}

/**
 * Quick public DNS hostname check used to gate Let's Encrypt issuance. Rejects
 * `localhost`, IPv4/IPv6 literals, and reserved/private TLDs that Let's
 * Encrypt cannot validate. Conservative on purpose: a hostname passing this
 * is still validated by the ACME server before issuance.
 */
export function isPublicDnsHostname(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 253) return false;
  if (!value.includes(".")) return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (/[:\s]/.test(value)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  const lower = value.toLowerCase();
  const reservedSuffixes = [
    "localhost",
    ".local",
    ".localhost",
    ".test",
    ".example",
    ".invalid",
    ".internal",
  ];
  for (const suffix of reservedSuffixes) {
    if (lower === suffix || lower.endsWith(suffix)) return false;
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(
    value,
  );
}

/**
 * Return the effective public Web UI hostname when `tunnel.webUi.enabled` is
 * true. Otherwise `undefined`.
 */
export function effectiveTunnelWebUiHostname(
  tunnel: GlobalTunnelConfig,
): string | undefined {
  return tunnel.webUi.enabled ? tunnel.webUi.hostname : undefined;
}

export async function loadGlobalConfig(
  opts: LoadGlobalConfigOptions = {},
): Promise<GlobalConfig> {
  const env = opts.env ?? process.env;
  const warn = opts.stderrWrite ?? ((text: string) => process.stderr.write(text));
  const path = globalConfigPath(env);
  const file = Bun.file(path);
  if (!(await file.exists())) return defaultGlobalConfig();

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (e) {
    warn(`wos: ${path} invalid JSON, using defaults (${(e as Error).message})\n`);
    return defaultGlobalConfig();
  }

  const config = defaultGlobalConfig();
  if (!isRecord(parsed)) return config;

  const webRaw = parsed.web;
  if (isRecord(webRaw) && "port" in webRaw) {
    const port = webRaw.port;
    if (
      typeof port === "number" &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    ) {
      config.web.port = port;
    } else {
      warn(
        `wos: ${path} web.port must be an integer in [1, 65535], got ${JSON.stringify(port)}; using ${DEFAULT_WEB_PORT}\n`,
      );
    }
  }

  if (isRecord(webRaw) && "host" in webRaw) {
    const host = webRaw.host;
    if (typeof host === "string" && host.trim().length > 0) {
      config.web.host = host;
    } else {
      warn(
        `wos: ${path} web.host must be a non-empty string, got ${JSON.stringify(host)}; using ${DEFAULT_WEB_HOST}\n`,
      );
    }
  }

  // Order: tunnel base first, then tunnel.webUi/serviceTunnels (need tunnel
  // domain), then SSL parsers (need effective public hostname + tunnel domain).
  const tunnelBase = parseTunnelWithoutSslOrRoutes(parsed.tunnel, path, warn);
  config.healthcheck = parseHealthcheckOverrides(parsed.healthcheck, path, warn);
  const tunnelRaw = isRecord(parsed.tunnel) ? parsed.tunnel : undefined;
  const webUi = parseTunnelWebUi(tunnelRaw?.webUi, tunnelBase, path, warn);
  const serviceTunnels = parseServiceTunnels(
    tunnelRaw?.serviceTunnels,
    path,
    warn,
  );
  const publicHostname = webUi.enabled ? webUi.hostname : undefined;
  config.web.ssl = parseSsl(
    isRecord(webRaw) ? webRaw.ssl : undefined,
    path,
    "web.ssl",
    warn,
    { publicHostname, tunnel: tunnelBase },
  );
  const tunnelSsl = parseSsl(
    tunnelRaw?.ssl,
    path,
    "tunnel.ssl",
    warn,
    { publicHostname, tunnel: tunnelBase },
  );
  config.tunnel = tunnelBase.enabled
    ? {
        enabled: true,
        port: tunnelBase.port,
        ...(tunnelBase.publicPort !== undefined ? { publicPort: tunnelBase.publicPort } : {}),
        domain: tunnelBase.domain,
        ssl: tunnelSsl,
        webUi,
        serviceTunnels,
      }
    : {
        enabled: false,
        port: tunnelBase.port,
        ...(tunnelBase.publicPort !== undefined ? { publicPort: tunnelBase.publicPort } : {}),
        ssl: tunnelSsl,
        webUi,
        serviceTunnels,
      };
  config.terminalBackend = parseTerminalBackend(
    parsed.terminalBackend,
    path,
    warn,
  );
  const editorCommand = parseEditorCommand(parsed.editorCommand, path, warn);
  if (editorCommand !== undefined) config.editorCommand = editorCommand;

  const serviceBind = parseServiceBind(parsed.serviceBind, path, warn);
  if (serviceBind !== undefined) config.serviceBind = serviceBind;

  config.aiProviders = parseAiProviders(parsed.aiProviders, path, warn);
  config.commitMessages = parseCommitMessages(
    parsed.commitMessages,
    config.aiProviders,
    path,
    warn,
  );

  if (parsed.autoInjectAgentPlugins !== undefined) {
    if (typeof parsed.autoInjectAgentPlugins === "boolean") {
      config.autoInjectAgentPlugins = parsed.autoInjectAgentPlugins;
    } else {
      warn(
        `wos: ${path} autoInjectAgentPlugins must be a boolean, got ${JSON.stringify(parsed.autoInjectAgentPlugins)}; ignoring\n`,
      );
    }
  }

  config.logging = parseLogging(parsed.logging, path, warn);
  config.notifications = parseNotifications(parsed.notifications, path, warn);

  return config;
}

/**
 * Parse the `notifications` block. An absent block yields built-in defaults
 * (all rules/channels disabled). Each field is validated independently and a
 * malformed value falls back to its safe default with a single-line stderr
 * warning. Unknown rule kinds are preserved verbatim for forward compatibility.
 */
function parseNotifications(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): NotificationsConfig {
  const out = defaultNotificationsConfig();
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    warn(
      `wos: ${path} notifications must be an object; ignoring notification settings\n`,
    );
    return out;
  }

  if ("rules" in raw && raw.rules !== undefined && raw.rules !== null) {
    if (!isRecord(raw.rules)) {
      warn(
        `wos: ${path} notifications.rules must be an object of per-kind rules, got ${JSON.stringify(raw.rules)}; ignoring rule overrides\n`,
      );
    } else {
      for (const [kind, ruleRaw] of Object.entries(raw.rules)) {
        // Preserve every kind (including ones this build does not recognize);
        // malformed fields fall back to defaults without dropping the entry.
        out.rules[kind] = parseNotificationRule(ruleRaw, kind, path, warn);
      }
    }
  }

  if ("channels" in raw && raw.channels !== undefined && raw.channels !== null) {
    out.channels = parseNotificationChannels(raw.channels, out.channels, path, warn);
  }

  if (
    "pushSubscriptions" in raw &&
    raw.pushSubscriptions !== undefined &&
    raw.pushSubscriptions !== null
  ) {
    out.pushSubscriptions = parsePushSubscriptions(raw.pushSubscriptions, path, warn);
  }

  return out;
}

function parseNotificationRule(
  raw: unknown,
  kind: string,
  path: string,
  warn: (text: string) => void,
): NotificationRule {
  const out = defaultNotificationRule();
  if (!isRecord(raw)) {
    warn(
      `wos: ${path} notifications.rules.${kind} must be an object, got ${JSON.stringify(raw)}; using defaults\n`,
    );
    return out;
  }
  if ("enabled" in raw) {
    if (typeof raw.enabled === "boolean") {
      out.enabled = raw.enabled;
    } else {
      warn(
        `wos: ${path} notifications.rules.${kind}.enabled must be a boolean, got ${JSON.stringify(raw.enabled)}; using ${out.enabled}\n`,
      );
    }
  }
  if ("channels" in raw && raw.channels !== undefined && raw.channels !== null) {
    if (!isRecord(raw.channels)) {
      warn(
        `wos: ${path} notifications.rules.${kind}.channels must be an object, got ${JSON.stringify(raw.channels)}; using defaults\n`,
      );
    } else {
      for (const channel of ["telegram", "webpush"] as const) {
        if (channel in raw.channels) {
          const value = raw.channels[channel];
          if (typeof value === "boolean") {
            out.channels[channel] = value;
          } else {
            warn(
              `wos: ${path} notifications.rules.${kind}.channels.${channel} must be a boolean, got ${JSON.stringify(value)}; using ${out.channels[channel]}\n`,
            );
          }
        }
      }
    }
  }
  return out;
}

function parseNotificationChannels(
  raw: unknown,
  def: NotificationChannelsConfig,
  path: string,
  warn: (text: string) => void,
): NotificationChannelsConfig {
  const out: NotificationChannelsConfig = {
    telegram: { ...def.telegram },
    webpush: { ...def.webpush },
  };
  if (!isRecord(raw)) {
    warn(
      `wos: ${path} notifications.channels must be an object, got ${JSON.stringify(raw)}; ignoring channel overrides\n`,
    );
    return out;
  }
  if (raw.telegram !== undefined && raw.telegram !== null) {
    if (!isRecord(raw.telegram)) {
      warn(
        `wos: ${path} notifications.channels.telegram must be an object, got ${JSON.stringify(raw.telegram)}; using defaults\n`,
      );
    } else {
      if ("enabled" in raw.telegram) {
        if (typeof raw.telegram.enabled === "boolean") {
          out.telegram.enabled = raw.telegram.enabled;
        } else {
          warn(
            `wos: ${path} notifications.channels.telegram.enabled must be a boolean, got ${JSON.stringify(raw.telegram.enabled)}; using ${out.telegram.enabled}\n`,
          );
        }
      }
      if ("botToken" in raw.telegram && raw.telegram.botToken !== undefined) {
        if (typeof raw.telegram.botToken === "string") {
          out.telegram.botToken = raw.telegram.botToken;
        } else {
          warn(
            `wos: ${path} notifications.channels.telegram.botToken must be a string; ignoring\n`,
          );
        }
      }
      if ("chatId" in raw.telegram && raw.telegram.chatId !== undefined) {
        if (typeof raw.telegram.chatId === "string") {
          out.telegram.chatId = raw.telegram.chatId;
        } else {
          warn(
            `wos: ${path} notifications.channels.telegram.chatId must be a string, got ${JSON.stringify(raw.telegram.chatId)}; ignoring\n`,
          );
        }
      }
      if ("mode" in raw.telegram && raw.telegram.mode !== undefined) {
        if (raw.telegram.mode === "always" || raw.telegram.mode === "when-away") {
          out.telegram.mode = raw.telegram.mode;
        } else {
          warn(
            `wos: ${path} notifications.channels.telegram.mode must be "always" or "when-away", got ${JSON.stringify(raw.telegram.mode)}; using ${out.telegram.mode}\n`,
          );
        }
      }
    }
  }
  if (raw.webpush !== undefined && raw.webpush !== null) {
    if (!isRecord(raw.webpush)) {
      warn(
        `wos: ${path} notifications.channels.webpush must be an object, got ${JSON.stringify(raw.webpush)}; using defaults\n`,
      );
    } else if ("enabled" in raw.webpush) {
      if (typeof raw.webpush.enabled === "boolean") {
        out.webpush.enabled = raw.webpush.enabled;
      } else {
        warn(
          `wos: ${path} notifications.channels.webpush.enabled must be a boolean, got ${JSON.stringify(raw.webpush.enabled)}; using ${out.webpush.enabled}\n`,
        );
      }
    }
  }
  return out;
}

function parsePushSubscriptions(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): PushSubscription[] {
  if (!Array.isArray(raw)) {
    warn(
      `wos: ${path} notifications.pushSubscriptions must be an array; ignoring stored subscriptions\n`,
    );
    return [];
  }
  const out: PushSubscription[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warn(
        `wos: ${path} notifications.pushSubscriptions[${index}] must be an object; skipping\n`,
      );
      return;
    }
    if (typeof entry.endpoint !== "string" || entry.endpoint.length === 0) {
      warn(
        `wos: ${path} notifications.pushSubscriptions[${index}].endpoint must be a non-empty string; skipping\n`,
      );
      return;
    }
    if (
      !isRecord(entry.keys) ||
      typeof entry.keys.p256dh !== "string" ||
      typeof entry.keys.auth !== "string"
    ) {
      warn(
        `wos: ${path} notifications.pushSubscriptions[${index}].keys must carry string p256dh + auth; skipping\n`,
      );
      return;
    }
    const sub: PushSubscription = {
      endpoint: entry.endpoint,
      keys: { p256dh: entry.keys.p256dh, auth: entry.keys.auth },
    };
    if (typeof entry.expirationTime === "number") {
      sub.expirationTime = entry.expirationTime;
    }
    out.push(sub);
  });
  return out;
}

/**
 * Parse the `logging` section, validating each field independently and falling
 * back to the disabled-by-default settings for anything malformed. An invalid
 * field warns and reverts to its default without discarding the valid siblings.
 */
function parseLogging(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): LoggingConfig {
  const out = defaultLoggingConfig();
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    warn(`wos: ${path} logging must be an object; ignoring logging settings\n`);
    return out;
  }

  if ("enabled" in raw) {
    if (typeof raw.enabled === "boolean") {
      out.enabled = raw.enabled;
    } else {
      warn(
        `wos: ${path} logging.enabled must be a boolean, got ${JSON.stringify(raw.enabled)}; using ${out.enabled}\n`,
      );
    }
  }

  if ("level" in raw && raw.level !== undefined) {
    if (isLogLevel(raw.level)) {
      out.level = raw.level;
    } else {
      warn(
        `wos: ${path} logging.level must be one of ${SUPPORTED_LOG_LEVELS.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(raw.level)}; using ${JSON.stringify(out.level)}\n`,
      );
    }
  }

  if ("redactPrompts" in raw) {
    if (typeof raw.redactPrompts === "boolean") {
      out.redactPrompts = raw.redactPrompts;
    } else {
      warn(
        `wos: ${path} logging.redactPrompts must be a boolean, got ${JSON.stringify(raw.redactPrompts)}; using ${out.redactPrompts}\n`,
      );
    }
  }

  if ("file" in raw && raw.file !== undefined && raw.file !== null) {
    if (typeof raw.file === "string" && raw.file.trim().length > 0) {
      out.file = raw.file;
    } else {
      warn(
        `wos: ${path} logging.file must be a non-empty string, got ${JSON.stringify(raw.file)}; using the default log path\n`,
      );
    }
  }

  if ("modules" in raw && raw.modules !== undefined && raw.modules !== null) {
    if (!isRecord(raw.modules)) {
      warn(
        `wos: ${path} logging.modules must be an object of module levels; ignoring module overrides\n`,
      );
    } else {
      for (const [name, level] of Object.entries(raw.modules)) {
        if (isLogLevel(level)) {
          out.modules[name] = level;
        } else {
          warn(
            `wos: ${path} logging.modules.${name} must be one of ${SUPPORTED_LOG_LEVELS.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(level)}; ignoring this override\n`,
          );
        }
      }
    }
  }

  if ("perf" in raw && raw.perf !== undefined && raw.perf !== null) {
    out.perf = parseLoggingPerf(raw.perf, out.perf, path, warn);
  }

  return out;
}

function parseLoggingPerf(
  raw: unknown,
  def: LoggingPerfConfig,
  path: string,
  warn: (text: string) => void,
): LoggingPerfConfig {
  if (!isRecord(raw)) {
    warn(`wos: ${path} logging.perf must be an object; using perf defaults\n`);
    return def;
  }
  const out: LoggingPerfConfig = {
    enabled: def.enabled,
    stuckWatchdog: def.stuckWatchdog,
    slowMs: { ...def.slowMs },
  };
  if ("enabled" in raw) {
    if (typeof raw.enabled === "boolean") {
      out.enabled = raw.enabled;
    } else {
      warn(
        `wos: ${path} logging.perf.enabled must be a boolean, got ${JSON.stringify(raw.enabled)}; using ${out.enabled}\n`,
      );
    }
  }
  if ("stuckWatchdog" in raw) {
    if (typeof raw.stuckWatchdog === "boolean") {
      out.stuckWatchdog = raw.stuckWatchdog;
    } else {
      warn(
        `wos: ${path} logging.perf.stuckWatchdog must be a boolean, got ${JSON.stringify(raw.stuckWatchdog)}; using ${out.stuckWatchdog}\n`,
      );
    }
  }
  if ("slowMs" in raw && raw.slowMs !== undefined && raw.slowMs !== null) {
    if (!isRecord(raw.slowMs)) {
      warn(
        `wos: ${path} logging.perf.slowMs must be an object of operation thresholds; using defaults\n`,
      );
    } else {
      for (const [op, value] of Object.entries(raw.slowMs)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          out.slowMs[op] = value;
        } else {
          warn(
            `wos: ${path} logging.perf.slowMs.${op} must be a non-negative number, got ${JSON.stringify(value)}; ignoring this threshold\n`,
          );
        }
      }
    }
  }
  return out;
}

function parseAiProviders(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): AiProviderConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn(`wos: ${path} aiProviders must be an array; ignoring AI providers\n`);
    return [];
  }
  const out: AiProviderConfig[] = [];
  raw.forEach((entry, index) => {
    const provider = parseAiProvider(entry, index, path, warn);
    if (provider) out.push(provider);
  });
  return out;
}

/**
 * Parse a single file-loaded AI provider entry. Returns `undefined` (and warns)
 * for any malformed entry so the caller skips it without dropping the rest of
 * the provider list.
 */
function parseAiProvider(
  raw: unknown,
  index: number,
  path: string,
  warn: (text: string) => void,
): AiProviderConfig | undefined {
  if (!isRecord(raw)) {
    warn(`wos: ${path} aiProviders[${index}] must be an object; skipping\n`);
    return undefined;
  }
  if (!isAiProviderType(raw.type)) {
    warn(
      `wos: ${path} aiProviders[${index}].type must be one of ${SUPPORTED_AI_PROVIDER_TYPES.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(raw.type)}; skipping\n`,
    );
    return undefined;
  }
  if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) {
    warn(
      `wos: ${path} aiProviders[${index}].apiKey must be a non-empty string; skipping\n`,
    );
    return undefined;
  }
  const provider: AiProviderConfig = { type: raw.type, apiKey: raw.apiKey };
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      warn(
        `wos: ${path} aiProviders[${index}].name must be a non-empty string when set; skipping\n`,
      );
      return undefined;
    }
    provider.name = raw.name;
  }
  if (raw.baseUrl !== undefined && raw.baseUrl !== null) {
    if (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0) {
      warn(
        `wos: ${path} aiProviders[${index}].baseUrl must be a non-empty string when set; skipping\n`,
      );
      return undefined;
    }
    provider.baseUrl = raw.baseUrl;
  }
  if (raw.models !== undefined && raw.models !== null) {
    if (!Array.isArray(raw.models)) {
      warn(
        `wos: ${path} aiProviders[${index}].models must be an array of non-empty strings when set; skipping\n`,
      );
      return undefined;
    }
    const models: string[] = [];
    for (const model of raw.models) {
      if (typeof model !== "string" || model.length === 0) {
        warn(
          `wos: ${path} aiProviders[${index}].models must contain only non-empty strings; skipping\n`,
        );
        return undefined;
      }
      models.push(model);
    }
    provider.models = models;
  }
  return provider;
}

/**
 * Parse the `commitMessages` default-provider block. `provider` must name one
 * of the configured `aiProviders`; an unknown provider warns and is dropped.
 * `model` is a free-form non-empty string. Malformed values warn and fall back
 * to unset without failing the load.
 */
function parseCommitMessages(
  raw: unknown,
  providers: AiProviderConfig[],
  path: string,
  warn: (text: string) => void,
): CommitMessagesConfig {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    warn(`wos: ${path} commitMessages must be an object; ignoring\n`);
    return {};
  }
  const out: CommitMessagesConfig = {};
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || raw.provider.length === 0) {
      warn(
        `wos: ${path} commitMessages.provider must be a non-empty string; ignoring\n`,
      );
    } else if (!providers.some((p) => p.name === raw.provider)) {
      warn(
        `wos: ${path} commitMessages.provider ${JSON.stringify(raw.provider)} does not name a configured AI provider; ignoring\n`,
      );
    } else {
      out.provider = raw.provider;
    }
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.length === 0) {
      warn(
        `wos: ${path} commitMessages.model must be a non-empty string; ignoring\n`,
      );
    } else {
      out.model = raw.model;
    }
  }
  return out;
}

function parseServiceBind(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    warn(
      `wos: ${path} serviceBind must be a non-empty string, got ${JSON.stringify(raw)}; ignoring\n`,
    );
    return undefined;
  }
  return raw;
}

function parseTerminalBackend(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): TerminalBackendId {
  if (raw === undefined) return DEFAULT_TERMINAL_BACKEND;
  if (isTerminalBackendId(raw)) return raw;
  warn(
    `wos: ${path} terminalBackend must be one of ${SUPPORTED_TERMINAL_BACKENDS.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(raw)}; using ${JSON.stringify(DEFAULT_TERMINAL_BACKEND)}\n`,
  );
  return DEFAULT_TERMINAL_BACKEND;
}

function parseEditorCommand(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    warn(
      `wos: ${path} editorCommand must be a string, got ${JSON.stringify(raw)}; ignoring\n`,
    );
    return undefined;
  }
  if (raw.length === 0) return undefined;
  return raw;
}

interface SslParseContext {
  publicHostname: string | undefined;
  tunnel: GlobalTunnelBaseConfig;
}

function parseSsl(
  raw: unknown,
  path: string,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  warn: (text: string) => void,
  ctx: SslParseContext,
): GlobalSslConfig {
  const disabled: GlobalSslConfig = { enabled: false };
  if (raw === undefined || raw === null) return disabled;
  if (!isRecord(raw)) {
    warn(`wos: ${path} ${fieldPrefix} must be an object; disabling SSL\n`);
    return disabled;
  }
  if (!("enabled" in raw)) return disabled;
  const enabledRaw = raw.enabled;
  if (typeof enabledRaw !== "boolean") {
    warn(
      `wos: ${path} ${fieldPrefix}.enabled must be a boolean, got ${JSON.stringify(enabledRaw)}; disabling SSL\n`,
    );
    return disabled;
  }
  if (!enabledRaw) return disabled;

  // Explicit source field, if present, gates the SSL mode. Omitted source
  // keeps backwards-compatible behavior (cert+key => files, otherwise self-signed).
  let source: SslCertificateSource | undefined;
  if ("source" in raw && raw.source !== undefined && raw.source !== null) {
    if (!isSslCertificateSource(raw.source)) {
      warn(
        `wos: ${path} ${fieldPrefix}.source must be one of ${SUPPORTED_SSL_SOURCES.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(raw.source)}; disabling SSL\n`,
      );
      return disabled;
    }
    source = raw.source;
  }

  const certRaw = "cert" in raw ? raw.cert : undefined;
  const keyRaw = "key" in raw ? raw.key : undefined;
  let cert: string | undefined;
  let key: string | undefined;
  if (certRaw !== undefined && certRaw !== null) {
    if (typeof certRaw !== "string" || certRaw.length === 0) {
      warn(
        `wos: ${path} ${fieldPrefix}.cert must be a non-empty string when set; disabling SSL\n`,
      );
      return disabled;
    }
    cert = certRaw;
  }
  if (keyRaw !== undefined && keyRaw !== null) {
    if (typeof keyRaw !== "string" || keyRaw.length === 0) {
      warn(
        `wos: ${path} ${fieldPrefix}.key must be a non-empty string when set; disabling SSL\n`,
      );
      return disabled;
    }
    key = keyRaw;
  }

  // Backward compatibility: omitted source with exactly one of cert/key set
  // was always an error and must remain so. Decide effective source from raw
  // presence so the legacy XOR check can fire before the source-specific
  // branches.
  const hasCertField = certRaw !== undefined && certRaw !== null;
  const hasKeyField = keyRaw !== undefined && keyRaw !== null;
  const legacyHasAnyPath = hasCertField || hasKeyField;
  const effectiveSource: SslCertificateSource =
    source ?? (legacyHasAnyPath ? "files" : "self-signed");

  if (effectiveSource === "files") {
    if (cert === undefined || key === undefined) {
      const missing = cert === undefined ? "cert" : "key";
      warn(
        `wos: ${path} ${fieldPrefix}.${missing} is required when the other certificate path is provided; disabling SSL\n`,
      );
      return disabled;
    }
    return { enabled: true, source: "files", cert, key };
  }

  if (effectiveSource === "self-signed") {
    return { enabled: true, source: "self-signed" };
  }

  // Let's Encrypt branch.
  const le = parseLetsEncrypt(raw.letsencrypt, path, fieldPrefix, warn);
  if (!le) return disabled;

  if (fieldPrefix === "web.ssl") {
    if (!ctx.publicHostname || !isPublicDnsHostname(ctx.publicHostname)) {
      warn(
        `wos: ${path} ${fieldPrefix}.source=letsencrypt requires a public Web UI hostname (tunnel.webUi.subdomain under tunnel.domain); disabling SSL\n`,
      );
      return disabled;
    }
  } else {
    if (!ctx.tunnel.enabled || !isPublicDnsHostname(ctx.tunnel.domain)) {
      warn(
        `wos: ${path} ${fieldPrefix}.source=letsencrypt requires an enabled tunnel with a public DNS domain; disabling SSL\n`,
      );
      return disabled;
    }
  }

  return { enabled: true, source: "letsencrypt", letsencrypt: le };
}

function parseLetsEncrypt(
  raw: unknown,
  path: string,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  warn: (text: string) => void,
): LetsEncryptConfig | undefined {
  if (!isRecord(raw)) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt must be an object when source=letsencrypt; disabling SSL\n`,
    );
    return undefined;
  }
  if (typeof raw.email !== "string" || raw.email.length === 0) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.email is required when source=letsencrypt; disabling SSL\n`,
    );
    return undefined;
  }
  if (raw.acceptTerms !== true) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.acceptTerms must be true to use Let's Encrypt; disabling SSL\n`,
    );
    return undefined;
  }
  let directory: LetsEncryptDirectory = DEFAULT_LETSENCRYPT_DIRECTORY;
  if ("directory" in raw && raw.directory !== undefined) {
    if (!isLetsEncryptDirectory(raw.directory)) {
      warn(
        `wos: ${path} ${fieldPrefix}.letsencrypt.directory must be "staging" or "production", got ${JSON.stringify(raw.directory)}; disabling SSL\n`,
      );
      return undefined;
    }
    directory = raw.directory;
  }
  const challenge = parseChallenge(raw.challenge, path, fieldPrefix, warn);
  if (!challenge) return undefined;
  return {
    email: raw.email,
    acceptTerms: true,
    directory,
    challenge,
  };
}

function parseChallenge(
  raw: unknown,
  path: string,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  warn: (text: string) => void,
): LetsEncryptChallenge | undefined {
  if (!isRecord(raw)) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge is required when source=letsencrypt; disabling SSL\n`,
    );
    return undefined;
  }
  if (raw.type !== "dns-01") {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.type must be "dns-01"; disabling SSL\n`,
    );
    return undefined;
  }
  if (!isLetsEncryptProvider(raw.provider)) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.provider must be one of ${SUPPORTED_LETSENCRYPT_PROVIDERS.map((v) => JSON.stringify(v)).join(", ")}; disabling SSL\n`,
    );
    return undefined;
  }
  if (raw.provider === "hook") {
    return parseHookChallenge(raw, path, fieldPrefix, warn);
  }
  return parseCloudflareChallenge(raw, path, fieldPrefix, warn);
}

function parseHookChallenge(
  raw: Record<string, unknown>,
  path: string,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  warn: (text: string) => void,
): LetsEncryptHookChallenge | undefined {
  if (typeof raw.createCommand !== "string" || raw.createCommand.length === 0) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.createCommand is required; disabling SSL\n`,
    );
    return undefined;
  }
  if (typeof raw.deleteCommand !== "string" || raw.deleteCommand.length === 0) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.deleteCommand is required; disabling SSL\n`,
    );
    return undefined;
  }
  const propagationSeconds = parsePropagationSeconds(raw, path, fieldPrefix, warn);
  if (propagationSeconds === undefined) return undefined;
  return {
    type: "dns-01",
    provider: "hook",
    createCommand: raw.createCommand,
    deleteCommand: raw.deleteCommand,
    propagationSeconds,
  };
}

function parseCloudflareChallenge(
  raw: Record<string, unknown>,
  path: string,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  warn: (text: string) => void,
): LetsEncryptCloudflareChallenge | undefined {
  let apiTokenEnv: string | undefined;
  if ("apiTokenEnv" in raw && raw.apiTokenEnv !== undefined && raw.apiTokenEnv !== null) {
    if (typeof raw.apiTokenEnv !== "string" || raw.apiTokenEnv.length === 0) {
      warn(
        `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.apiTokenEnv must be a non-empty string when set; disabling SSL\n`,
      );
      return undefined;
    }
    apiTokenEnv = raw.apiTokenEnv;
  }
  let apiToken: string | undefined;
  if ("apiToken" in raw && raw.apiToken !== undefined && raw.apiToken !== null) {
    if (typeof raw.apiToken !== "string" || raw.apiToken.length === 0) {
      warn(
        `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.apiToken must be a non-empty string when set; disabling SSL\n`,
      );
      return undefined;
    }
    apiToken = raw.apiToken;
  }
  if (!apiTokenEnv && !apiToken) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.apiTokenEnv or apiToken is required for the Cloudflare provider; disabling SSL\n`,
    );
    return undefined;
  }
  let zoneId: string | undefined;
  if ("zoneId" in raw && raw.zoneId !== undefined && raw.zoneId !== null) {
    if (typeof raw.zoneId !== "string" || raw.zoneId.length === 0) {
      warn(
        `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.zoneId must be a non-empty string when set; disabling SSL\n`,
      );
      return undefined;
    }
    zoneId = raw.zoneId;
  }
  const propagationSeconds = parsePropagationSeconds(raw, path, fieldPrefix, warn);
  if (propagationSeconds === undefined) return undefined;
  const challenge: LetsEncryptCloudflareChallenge = {
    type: "dns-01",
    provider: "cloudflare",
    propagationSeconds,
  };
  if (apiTokenEnv) challenge.apiTokenEnv = apiTokenEnv;
  if (apiToken && !apiTokenEnv) challenge.apiToken = apiToken;
  if (zoneId) challenge.zoneId = zoneId;
  return challenge;
}

function parsePropagationSeconds(
  raw: Record<string, unknown>,
  path: string,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  warn: (text: string) => void,
): number | undefined {
  if (!("propagationSeconds" in raw) || raw.propagationSeconds === undefined) {
    return 0;
  }
  const p = raw.propagationSeconds;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 0) {
    warn(
      `wos: ${path} ${fieldPrefix}.letsencrypt.challenge.propagationSeconds must be a non-negative integer; disabling SSL\n`,
    );
    return undefined;
  }
  return p;
}

function parseHealthcheckOverrides(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): GlobalHealthcheckConfig {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    warn(`wos: ${path} healthcheck must be an object; ignoring overrides\n`);
    return {};
  }
  const out: GlobalHealthcheckConfig = {};
  parseHealthcheckDuration(raw, "timeout", path, warn, (ms) => (out.timeoutMs = ms));
  parseHealthcheckDuration(raw, "start_period", path, warn, (ms) => (out.startPeriodMs = ms));
  parseHealthcheckDuration(raw, "interval", path, warn, (ms) => (out.intervalMs = ms));
  parseHealthcheckDuration(raw, "request_timeout", path, warn, (ms) => (out.requestTimeoutMs = ms));
  if ("retries" in raw) {
    try {
      out.retries = parseRetriesValue(raw.retries, "healthcheck.retries");
    } catch (e) {
      warn(`wos: ${path} ${(e as Error).message}; ignoring override\n`);
    }
  }
  return out;
}

function parseHealthcheckDuration(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  warn: (text: string) => void,
  assign: (ms: number) => void,
): void {
  if (!(key in raw)) return;
  try {
    assign(parseDurationValue(raw[key], `healthcheck.${key}`));
  } catch (e) {
    warn(`wos: ${path} ${(e as Error).message}; ignoring override\n`);
  }
}

type GlobalTunnelBaseConfig =
  | { enabled: false; port: number; publicPort?: number }
  | { enabled: true; port: number; publicPort?: number; domain: string };

/**
 * Parse tunnel base config (enabled/port/domain) without the SSL section, the
 * webUi block, or the serviceTunnels block. SSL and route blocks are resolved
 * by the top-level loader so they can cross-reference effective `tunnel.domain`.
 */
function parseTunnelWithoutSslOrRoutes(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): GlobalTunnelBaseConfig {
  const fallback: GlobalTunnelBaseConfig = {
    enabled: false,
    port: DEFAULT_TUNNEL_PORT,
  };
  if (raw === undefined || raw === null) return fallback;
  if (!isRecord(raw)) return fallback;

  let port = DEFAULT_TUNNEL_PORT;
  if ("port" in raw) {
    const portRaw = raw.port;
    if (
      typeof portRaw === "number" &&
      Number.isInteger(portRaw) &&
      portRaw >= 1 &&
      portRaw <= 65535
    ) {
      port = portRaw;
    } else {
      warn(
        `wos: ${path} tunnel.port must be an integer in [1, 65535], got ${JSON.stringify(portRaw)}; using ${DEFAULT_TUNNEL_PORT}\n`,
      );
    }
  }

  let publicPort: number | undefined;
  if ("publicPort" in raw) {
    const publicPortRaw = raw.publicPort;
    if (
      typeof publicPortRaw === "number" &&
      Number.isInteger(publicPortRaw) &&
      publicPortRaw >= 1 &&
      publicPortRaw <= 65535
    ) {
      publicPort = publicPortRaw;
    } else {
      warn(
        `wos: ${path} tunnel.publicPort must be an integer in [1, 65535], got ${JSON.stringify(publicPortRaw)}; falling back to tunnel.port\n`,
      );
    }
  }

  let enabledFlag = false;
  if ("enabled" in raw) {
    const enabledRaw = raw.enabled;
    if (typeof enabledRaw === "boolean") {
      enabledFlag = enabledRaw;
    } else {
      warn(
        `wos: ${path} tunnel.enabled must be a boolean, got ${JSON.stringify(enabledRaw)}; disabling tunnel\n`,
      );
      return { enabled: false, port, ...(publicPort !== undefined ? { publicPort } : {}) };
    }
  }

  if (!enabledFlag) {
    return { enabled: false, port, ...(publicPort !== undefined ? { publicPort } : {}) };
  }

  const domainRaw = raw.domain;
  if (typeof domainRaw !== "string" || domainRaw.length === 0) {
    warn(
      `wos: ${path} tunnel.domain is required when tunnel.enabled is true; disabling tunnel\n`,
    );
    return { enabled: false, port, ...(publicPort !== undefined ? { publicPort } : {}) };
  }

  return {
    enabled: true,
    port,
    ...(publicPort !== undefined ? { publicPort } : {}),
    domain: domainRaw,
  };
}

/**
 * Resolve the effective Web UI subdomain into a full hostname under the tunnel
 * domain. Accepts a single DNS label (`sample`) or a full hostname whose
 * suffix matches `tunnel.domain` (`sample.example.com`). Returns `undefined`
 * for invalid inputs.
 */
function resolveWebUiHostname(
  subdomain: string,
  tunnelDomain: string,
): string | undefined {
  const trimmed = subdomain.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const domainLower = tunnelDomain.toLowerCase();
  // Disallow leading/trailing dots, double dots, and whitespace.
  if (
    trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    trimmed.includes("..") ||
    /[^a-z0-9.-]/.test(trimmed)
  ) {
    return undefined;
  }
  if (trimmed.includes(".")) {
    // Full hostname form — must be a strict subdomain of tunnelDomain.
    if (trimmed === domainLower) return undefined;
    if (!trimmed.endsWith(`.${domainLower}`)) return undefined;
    return trimmed;
  }
  // Bare DNS label — must match the standard label syntax.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed)) return undefined;
  return `${trimmed}.${domainLower}`;
}

function parseTunnelWebUi(
  raw: unknown,
  tunnel: GlobalTunnelBaseConfig,
  path: string,
  warn: (text: string) => void,
): GlobalTunnelWebUiConfig {
  if (raw === undefined || raw === null) return { enabled: false };
  if (!isRecord(raw)) return { enabled: false };
  if (!("enabled" in raw)) return { enabled: false };
  const enabledRaw = raw.enabled;
  if (typeof enabledRaw !== "boolean") {
    warn(
      `wos: ${path} tunnel.webUi.enabled must be a boolean, got ${JSON.stringify(enabledRaw)}; disabling tunnel Web UI\n`,
    );
    return { enabled: false };
  }
  if (!enabledRaw) return { enabled: false };

  if (!tunnel.enabled) {
    warn(
      `wos: ${path} tunnel.webUi.enabled requires tunnel.enabled true with a domain; disabling tunnel Web UI\n`,
    );
    return { enabled: false };
  }

  const subdomainRaw = raw.subdomain;
  if (typeof subdomainRaw !== "string" || subdomainRaw.length === 0) {
    warn(
      `wos: ${path} tunnel.webUi.subdomain is required when tunnel.webUi.enabled is true; disabling tunnel Web UI\n`,
    );
    return { enabled: false };
  }
  const hostname = resolveWebUiHostname(subdomainRaw, tunnel.domain);
  if (!hostname) {
    warn(
      `wos: ${path} tunnel.webUi.subdomain must be a DNS label or a hostname under tunnel.domain, got ${JSON.stringify(subdomainRaw)}; disabling tunnel Web UI\n`,
    );
    return { enabled: false };
  }

  const secretRaw = raw.secret;
  if (typeof secretRaw !== "string" || secretRaw.length === 0) {
    warn(
      `wos: ${path} tunnel.webUi.secret is required when tunnel.webUi.enabled is true; disabling tunnel Web UI\n`,
    );
    return { enabled: false };
  }

  let terminalEnabled = false;
  if ("terminalEnabled" in raw && raw.terminalEnabled !== undefined) {
    const t = raw.terminalEnabled;
    if (typeof t === "boolean") {
      terminalEnabled = t;
    } else {
      warn(
        `wos: ${path} tunnel.webUi.terminalEnabled must be a boolean, got ${JSON.stringify(t)}; disabling public terminal access\n`,
      );
    }
  }

  const whitelist = parseWhitelistIps(
    "whitelistIps" in raw ? raw.whitelistIps : undefined,
    "tunnel.webUi.whitelistIps",
    path,
    warn,
  );
  if (whitelist.kind === "invalid") {
    return { enabled: false };
  }

  return {
    enabled: true,
    hostname,
    secret: secretRaw,
    terminalEnabled,
    whitelistIps: whitelist.list,
  };
}

function parseServiceTunnels(
  raw: unknown,
  path: string,
  warn: (text: string) => void,
): GlobalServiceTunnelsConfig {
  if (raw === undefined || raw === null) {
    return { enabled: false, whitelistIps: [] };
  }
  if (!isRecord(raw)) {
    return { enabled: false, whitelistIps: [] };
  }
  let enabled = false;
  if ("enabled" in raw && raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      warn(
        `wos: ${path} tunnel.serviceTunnels.enabled must be a boolean, got ${JSON.stringify(raw.enabled)}; disabling service tunnels\n`,
      );
      return { enabled: false, whitelistIps: [] };
    }
    enabled = raw.enabled;
  }
  const whitelist = parseWhitelistIps(
    "whitelistIps" in raw ? raw.whitelistIps : undefined,
    "tunnel.serviceTunnels.whitelistIps",
    path,
    warn,
  );
  if (whitelist.kind === "invalid") {
    return { enabled: false, whitelistIps: [] };
  }
  return { enabled, whitelistIps: whitelist.list };
}

type WhitelistParse =
  | { kind: "valid"; list: string[] }
  | { kind: "invalid" };

function parseWhitelistIps(
  raw: unknown,
  fieldPrefix: string,
  path: string,
  warn: (text: string) => void,
): WhitelistParse {
  if (raw === undefined || raw === null) return { kind: "valid", list: [] };
  if (!Array.isArray(raw)) {
    warn(
      `wos: ${path} ${fieldPrefix} must be an array of IP address strings; disabling the affected tunnel route\n`,
    );
    return { kind: "invalid" };
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !isValidIpAddress(entry)) {
      warn(
        `wos: ${path} ${fieldPrefix} contains an invalid IP address entry ${JSON.stringify(entry)}; disabling the affected tunnel route\n`,
      );
      return { kind: "invalid" };
    }
    out.push(entry);
  }
  return { kind: "valid", list: out };
}

/**
 * Loose validation for an IPv4 or IPv6 literal. Strict enough to reject empty
 * strings, hostnames, and obviously broken input; we leave full RFC compliance
 * to the proxy peer-address comparison.
 */
export function isValidIpAddress(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes(":")) {
    // IPv6 — at least one ":" and only hex digits, dots (for embedded v4), and colons.
    return /^[0-9a-fA-F:.]+$/.test(value) && value.split(":").length <= 8;
  }
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Draft of the supported global settings shaped exactly like the on-disk
 * `config.json`. Every field is optional so a snapshot may report a partial
 * file and a save submission may omit defaults.
 */
export interface LetsEncryptHookChallengeDraft {
  type?: "dns-01";
  provider?: "hook";
  createCommand?: string;
  deleteCommand?: string;
  propagationSeconds?: number;
}

export interface LetsEncryptCloudflareChallengeDraft {
  type?: "dns-01";
  provider?: "cloudflare";
  apiTokenEnv?: string;
  apiToken?: string;
  zoneId?: string;
  propagationSeconds?: number;
}

export type LetsEncryptChallengeDraft =
  | LetsEncryptHookChallengeDraft
  | LetsEncryptCloudflareChallengeDraft;

export interface LetsEncryptConfigDraft {
  email?: string;
  acceptTerms?: boolean;
  directory?: LetsEncryptDirectory;
  challenge?: LetsEncryptChallengeDraft;
}

export interface GlobalSslConfigDraft {
  enabled?: boolean;
  source?: SslCertificateSource;
  cert?: string;
  key?: string;
  letsencrypt?: LetsEncryptConfigDraft;
}

export interface GlobalTunnelWebUiDraft {
  enabled?: boolean;
  subdomain?: string;
  secret?: string;
  terminalEnabled?: boolean;
  whitelistIps?: string[];
}

export interface GlobalServiceTunnelsDraft {
  enabled?: boolean;
  whitelistIps?: string[];
}

export interface AiProviderDraft {
  type?: AiProviderType;
  apiKey?: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
}

export interface LoggingPerfDraft {
  enabled?: boolean;
  stuckWatchdog?: boolean;
  slowMs?: Record<string, number>;
}

export interface LoggingConfigDraft {
  enabled?: boolean;
  level?: LogLevel;
  modules?: Record<string, LogLevel>;
  file?: string;
  redactPrompts?: boolean;
  perf?: LoggingPerfDraft;
}

export interface GlobalConfigDraft {
  web?: {
    port?: number;
    host?: string;
    ssl?: GlobalSslConfigDraft;
  };
  tunnel?: {
    enabled?: boolean;
    port?: number;
    publicPort?: number;
    domain?: string;
    ssl?: GlobalSslConfigDraft;
    webUi?: GlobalTunnelWebUiDraft;
    serviceTunnels?: GlobalServiceTunnelsDraft;
  };
  healthcheck?: {
    timeout?: number | string;
    start_period?: number | string;
    interval?: number | string;
    request_timeout?: number | string;
    retries?: number;
  };
  terminalBackend?: TerminalBackendId;
  editorCommand?: string;
  serviceBind?: string;
  aiProviders?: AiProviderDraft[];
  commitMessages?: CommitMessagesDraft;
  autoInjectAgentPlugins?: boolean;
  logging?: LoggingConfigDraft;
  /**
   * Notification settings as surfaced in the management snapshot. The Telegram
   * bot token is redacted and push subscription targets are omitted; the block
   * is persisted through the dedicated notification endpoints, not this draft.
   */
  notifications?: NotificationsConfig;
}

export interface CommitMessagesDraft {
  provider?: string;
  model?: string;
}

export interface EffectiveSslSourceSnapshot {
  /** Effective certificate source resolved from raw config. */
  source: SslCertificateSource | "disabled";
}

export interface GlobalConfigManagementSnapshot {
  /** Absolute path to `<wos-home>/config.json`. */
  path: string;
  /** Whether the file currently exists on disk. */
  exists: boolean;
  /**
   * Raw supported settings extracted from the file. `null` when the file is
   * absent. Unknown top-level keys are dropped.
   */
  raw: GlobalConfigDraft | null;
  /** Effective parsed config, with defaults and validation fallbacks. */
  effective: GlobalConfig;
  /** Derived effective SSL certificate source per listener kind. */
  effectiveSsl: {
    web: EffectiveSslSourceSnapshot;
    tunnel: EffectiveSslSourceSnapshot;
  };
}

export interface GlobalConfigValidationError {
  /** Dot-path of the offending setting, e.g. `tunnel.webUi.subdomain`. */
  field: string;
  message: string;
}

export type GlobalConfigSaveValidation =
  | { ok: true; persistable: GlobalConfigDraft }
  | { ok: false; errors: GlobalConfigValidationError[] };

export async function buildManagementSnapshot(
  opts: LoadGlobalConfigOptions = {},
): Promise<GlobalConfigManagementSnapshot> {
  const env = opts.env ?? process.env;
  const path = globalConfigPath(env);
  const file = Bun.file(path);
  const exists = await file.exists();
  let raw: GlobalConfigDraft | null = null;
  if (exists) {
    try {
      const parsed = await file.json();
      if (isRecord(parsed)) raw = extractSupportedDraft(parsed);
    } catch {
      raw = null;
    }
  }
  const effective = await loadGlobalConfig(opts);
  return {
    path,
    exists,
    raw,
    effective,
    effectiveSsl: {
      web: { source: sslEffectiveSource(effective.web.ssl) },
      tunnel: { source: sslEffectiveSource(effective.tunnel.ssl) },
    },
  };
}

export function sslEffectiveSource(
  ssl: GlobalSslConfig,
): SslCertificateSource | "disabled" {
  if (!ssl.enabled) return "disabled";
  return ssl.source;
}

function extractLetsEncryptDraft(
  raw: unknown,
): LetsEncryptConfigDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: LetsEncryptConfigDraft = {};
  if (typeof raw.email === "string") out.email = raw.email;
  if (typeof raw.acceptTerms === "boolean") out.acceptTerms = raw.acceptTerms;
  if (isLetsEncryptDirectory(raw.directory)) out.directory = raw.directory;
  const ch = extractChallengeDraft(raw.challenge);
  if (ch) out.challenge = ch;
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractChallengeDraft(
  raw: unknown,
): LetsEncryptChallengeDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const provider = raw.provider;
  if (provider === "cloudflare") {
    const ch: LetsEncryptCloudflareChallengeDraft = { provider: "cloudflare" };
    if (raw.type === "dns-01") ch.type = "dns-01";
    if (typeof raw.apiTokenEnv === "string") ch.apiTokenEnv = raw.apiTokenEnv;
    if (typeof raw.apiToken === "string") ch.apiToken = raw.apiToken;
    if (typeof raw.zoneId === "string") ch.zoneId = raw.zoneId;
    if (typeof raw.propagationSeconds === "number") {
      ch.propagationSeconds = raw.propagationSeconds;
    }
    return ch;
  }
  const ch: LetsEncryptHookChallengeDraft = {};
  if (raw.type === "dns-01") ch.type = "dns-01";
  if (provider === "hook") ch.provider = "hook";
  if (typeof raw.createCommand === "string") ch.createCommand = raw.createCommand;
  if (typeof raw.deleteCommand === "string") ch.deleteCommand = raw.deleteCommand;
  if (typeof raw.propagationSeconds === "number") {
    ch.propagationSeconds = raw.propagationSeconds;
  }
  return Object.keys(ch).length > 0 ? ch : undefined;
}

function extractSslDraft(raw: unknown): GlobalSslConfigDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: GlobalSslConfigDraft = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (isSslCertificateSource(raw.source)) out.source = raw.source;
  if (typeof raw.cert === "string") out.cert = raw.cert;
  if (typeof raw.key === "string") out.key = raw.key;
  const le = extractLetsEncryptDraft(raw.letsencrypt);
  if (le) out.letsencrypt = le;
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractWebUiDraft(raw: unknown): GlobalTunnelWebUiDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: GlobalTunnelWebUiDraft = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.subdomain === "string") out.subdomain = raw.subdomain;
  if (typeof raw.secret === "string") out.secret = raw.secret;
  if (typeof raw.terminalEnabled === "boolean") {
    out.terminalEnabled = raw.terminalEnabled;
  }
  if (Array.isArray(raw.whitelistIps)) {
    const list: string[] = [];
    for (const entry of raw.whitelistIps) {
      if (typeof entry === "string") list.push(entry);
    }
    out.whitelistIps = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractServiceTunnelsDraft(
  raw: unknown,
): GlobalServiceTunnelsDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: GlobalServiceTunnelsDraft = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (Array.isArray(raw.whitelistIps)) {
    const list: string[] = [];
    for (const entry of raw.whitelistIps) {
      if (typeof entry === "string") list.push(entry);
    }
    out.whitelistIps = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractSupportedDraft(obj: Record<string, unknown>): GlobalConfigDraft {
  const draft: GlobalConfigDraft = {};
  if (isRecord(obj.web)) {
    const web: NonNullable<GlobalConfigDraft["web"]> = {};
    if ("port" in obj.web && typeof obj.web.port === "number") {
      web.port = obj.web.port;
    }
    if ("host" in obj.web && typeof obj.web.host === "string") {
      web.host = obj.web.host;
    }
    const webSsl = extractSslDraft(obj.web.ssl);
    if (webSsl) web.ssl = webSsl;
    if (Object.keys(web).length > 0) draft.web = web;
  }
  if (isRecord(obj.tunnel)) {
    const tunnel: NonNullable<GlobalConfigDraft["tunnel"]> = {};
    if (typeof obj.tunnel.enabled === "boolean") tunnel.enabled = obj.tunnel.enabled;
    if (typeof obj.tunnel.port === "number") tunnel.port = obj.tunnel.port;
    if (typeof obj.tunnel.publicPort === "number") tunnel.publicPort = obj.tunnel.publicPort;
    if (typeof obj.tunnel.domain === "string") tunnel.domain = obj.tunnel.domain;
    const tunnelSsl = extractSslDraft(obj.tunnel.ssl);
    if (tunnelSsl) tunnel.ssl = tunnelSsl;
    const webUi = extractWebUiDraft(obj.tunnel.webUi);
    if (webUi) tunnel.webUi = webUi;
    const serviceTunnels = extractServiceTunnelsDraft(obj.tunnel.serviceTunnels);
    if (serviceTunnels) tunnel.serviceTunnels = serviceTunnels;
    if (Object.keys(tunnel).length > 0) draft.tunnel = tunnel;
  }
  if (isRecord(obj.healthcheck)) {
    const hc: NonNullable<GlobalConfigDraft["healthcheck"]> = {};
    const passthroughDuration = (key: "timeout" | "start_period" | "interval" | "request_timeout") => {
      const v = obj.healthcheck![key as keyof typeof obj.healthcheck];
      if (typeof v === "number" || typeof v === "string") hc[key] = v;
    };
    passthroughDuration("timeout");
    passthroughDuration("start_period");
    passthroughDuration("interval");
    passthroughDuration("request_timeout");
    if (typeof obj.healthcheck.retries === "number") {
      hc.retries = obj.healthcheck.retries;
    }
    if (Object.keys(hc).length > 0) draft.healthcheck = hc;
  }
  if (isTerminalBackendId(obj.terminalBackend)) {
    draft.terminalBackend = obj.terminalBackend;
  }
  if (typeof obj.editorCommand === "string" && obj.editorCommand.length > 0) {
    draft.editorCommand = obj.editorCommand;
  }
  if (typeof obj.serviceBind === "string" && obj.serviceBind.length > 0) {
    draft.serviceBind = obj.serviceBind;
  }
  const aiProviders = extractAiProvidersDraft(obj.aiProviders);
  if (aiProviders) draft.aiProviders = aiProviders;
  const commitMessages = extractCommitMessagesDraft(obj.commitMessages);
  if (commitMessages) draft.commitMessages = commitMessages;
  if (typeof obj.autoInjectAgentPlugins === "boolean") {
    draft.autoInjectAgentPlugins = obj.autoInjectAgentPlugins;
  }
  const logging = extractLoggingDraft(obj.logging);
  if (logging) draft.logging = logging;
  const notifications = extractNotificationsDraft(obj.notifications);
  if (notifications) draft.notifications = notifications;
  return draft;
}

/**
 * Extract the `notifications` block for the management snapshot. The Telegram
 * bot token is redacted and push subscription targets are dropped so the
 * generic settings snapshot never carries secrets. Returns `undefined` when no
 * `notifications` block is present so the snapshot omits it.
 */
function extractNotificationsDraft(raw: unknown): NotificationsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = parseNotifications(raw, "", () => {});
  return redactNotificationsConfig(parsed);
}

/**
 * Extract the supported raw `logging` fields from a file value, keeping only
 * present, type-correct values so the management snapshot round-trips a
 * hand-edited block without inventing defaults.
 */
function extractLoggingDraft(raw: unknown): LoggingConfigDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: LoggingConfigDraft = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (isLogLevel(raw.level)) out.level = raw.level;
  if (typeof raw.redactPrompts === "boolean") out.redactPrompts = raw.redactPrompts;
  if (typeof raw.file === "string" && raw.file.length > 0) out.file = raw.file;
  if (isRecord(raw.modules)) {
    const modules: Record<string, LogLevel> = {};
    for (const [name, level] of Object.entries(raw.modules)) {
      if (isLogLevel(level)) modules[name] = level;
    }
    if (Object.keys(modules).length > 0) out.modules = modules;
  }
  const perf = extractLoggingPerfDraft(raw.perf);
  if (perf) out.perf = perf;
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractLoggingPerfDraft(raw: unknown): LoggingPerfDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: LoggingPerfDraft = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.stuckWatchdog === "boolean") out.stuckWatchdog = raw.stuckWatchdog;
  if (isRecord(raw.slowMs)) {
    const slowMs: Record<string, number> = {};
    for (const [op, value] of Object.entries(raw.slowMs)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        slowMs[op] = value;
      }
    }
    if (Object.keys(slowMs).length > 0) out.slowMs = slowMs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Extract the supported AI provider fields from a raw file value, preserving
 * each entry (and its present, type-correct fields) so the settings UI can
 * round-trip and correct partially-invalid entries.
 */
function extractCommitMessagesDraft(
  raw: unknown,
): CommitMessagesDraft | undefined {
  if (!isRecord(raw)) return undefined;
  const out: CommitMessagesDraft = {};
  if (typeof raw.provider === "string" && raw.provider.length > 0) {
    out.provider = raw.provider;
  }
  if (typeof raw.model === "string" && raw.model.length > 0) {
    out.model = raw.model;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractAiProvidersDraft(raw: unknown): AiProviderDraft[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AiProviderDraft[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const draft: AiProviderDraft = {};
    if (isAiProviderType(entry.type)) draft.type = entry.type;
    if (typeof entry.apiKey === "string") draft.apiKey = entry.apiKey;
    if (typeof entry.name === "string") draft.name = entry.name;
    if (typeof entry.baseUrl === "string") draft.baseUrl = entry.baseUrl;
    if (Array.isArray(entry.models)) {
      const models: string[] = [];
      for (const model of entry.models) {
        if (typeof model === "string") models.push(model);
      }
      draft.models = models;
    }
    out.push(draft);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate and normalize a submitted settings draft. Returns either the
 * persistable JSON object (subset of `GlobalConfigDraft`) or a list of
 * field-aware errors. Does not write the file.
 */
export function validateGlobalConfigSave(
  request: unknown,
): GlobalConfigSaveValidation {
  const errors: GlobalConfigValidationError[] = [];
  if (!isRecord(request)) {
    return { ok: false, errors: [{ field: "", message: "settings must be a JSON object" }] };
  }
  const persistable: GlobalConfigDraft = {};

  // ---- web ----
  const webRaw = request.web;
  const persistedWeb: NonNullable<GlobalConfigDraft["web"]> = {};
  if (webRaw !== undefined) {
    if (!isRecord(webRaw)) {
      errors.push({ field: "web", message: "web must be an object" });
    } else {
      if (webRaw.port !== undefined) {
        const port = webRaw.port;
        if (
          typeof port !== "number" ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535
        ) {
          errors.push({
            field: "web.port",
            message: "web.port must be an integer in [1, 65535]",
          });
        } else {
          persistedWeb.port = port;
        }
      }
      if (webRaw.host !== undefined) {
        const host = webRaw.host;
        if (host === null || (typeof host === "string" && host.trim().length === 0)) {
          // Explicit clear: omit so the effective host falls back to 127.0.0.1.
        } else if (typeof host !== "string") {
          errors.push({
            field: "web.host",
            message: "web.host must be a non-empty string",
          });
        } else {
          persistedWeb.host = host.trim();
        }
      }
      if ("public" in webRaw && webRaw.public !== undefined) {
        errors.push({
          field: "web.public",
          message:
            "web.public is no longer supported — configure tunnel.webUi.enabled, tunnel.webUi.subdomain, and tunnel.webUi.secret instead",
        });
      }
    }
  }

  // tunnel must be validated before tunnel.webUi so its hostname can be derived.
  const tunnelRaw = request.tunnel;
  const persistedTunnel: NonNullable<GlobalConfigDraft["tunnel"]> = {};
  let tunnelEnabled = false;
  let tunnelDomain: string | undefined;
  if (tunnelRaw !== undefined) {
    if (!isRecord(tunnelRaw)) {
      errors.push({ field: "tunnel", message: "tunnel must be an object" });
    } else {
      if (tunnelRaw.port !== undefined) {
        const p = tunnelRaw.port;
        if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
          errors.push({
            field: "tunnel.port",
            message: "tunnel.port must be an integer in [1, 65535]",
          });
        } else {
          persistedTunnel.port = p;
        }
      }
      if (tunnelRaw.publicPort !== undefined) {
        const pp = tunnelRaw.publicPort;
        if (typeof pp !== "number" || !Number.isInteger(pp) || pp < 1 || pp > 65535) {
          errors.push({
            field: "tunnel.publicPort",
            message: "tunnel.publicPort must be an integer in [1, 65535]",
          });
        } else {
          persistedTunnel.publicPort = pp;
        }
      }
      const enabledRaw = tunnelRaw.enabled;
      if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
        errors.push({
          field: "tunnel.enabled",
          message: "tunnel.enabled must be a boolean",
        });
      } else {
        tunnelEnabled = enabledRaw === true;
        persistedTunnel.enabled = tunnelEnabled;
      }
      if (tunnelEnabled) {
        const d = tunnelRaw.domain;
        if (typeof d !== "string" || d.length === 0) {
          errors.push({
            field: "tunnel.domain",
            message: "tunnel.domain is required when tunnel.enabled is true",
          });
        } else {
          tunnelDomain = d;
          persistedTunnel.domain = d;
        }
      } else if (typeof tunnelRaw.domain === "string" && tunnelRaw.domain.length > 0) {
        // Preserve a non-empty domain even when disabled so re-enabling is one click.
        persistedTunnel.domain = tunnelRaw.domain;
      }
    }
  }

  // ---- tunnel.webUi ----
  const tunnelObj = isRecord(tunnelRaw) ? tunnelRaw : undefined;
  const webUiRaw = tunnelObj?.webUi;
  const persistedWebUi: GlobalTunnelWebUiDraft = {};
  let webUiEnabled = false;
  let effectiveWebUiHostname: string | undefined;
  if (webUiRaw !== undefined) {
    if (!isRecord(webUiRaw)) {
      errors.push({ field: "tunnel.webUi", message: "tunnel.webUi must be an object" });
    } else {
      const enabledRaw = webUiRaw.enabled;
      if (enabledRaw !== undefined) {
        if (typeof enabledRaw !== "boolean") {
          errors.push({
            field: "tunnel.webUi.enabled",
            message: "tunnel.webUi.enabled must be a boolean",
          });
        } else {
          webUiEnabled = enabledRaw;
          persistedWebUi.enabled = enabledRaw;
        }
      }
      if (webUiRaw.subdomain !== undefined) {
        if (typeof webUiRaw.subdomain !== "string") {
          errors.push({
            field: "tunnel.webUi.subdomain",
            message: "tunnel.webUi.subdomain must be a string",
          });
        } else if (webUiRaw.subdomain.length > 0) {
          persistedWebUi.subdomain = webUiRaw.subdomain;
        }
      }
      if (webUiRaw.secret !== undefined) {
        if (typeof webUiRaw.secret !== "string") {
          errors.push({
            field: "tunnel.webUi.secret",
            message: "tunnel.webUi.secret must be a string",
          });
        } else if (webUiRaw.secret.length > 0) {
          persistedWebUi.secret = webUiRaw.secret;
        }
      }
      if (webUiRaw.terminalEnabled !== undefined) {
        if (typeof webUiRaw.terminalEnabled !== "boolean") {
          errors.push({
            field: "tunnel.webUi.terminalEnabled",
            message: "tunnel.webUi.terminalEnabled must be a boolean",
          });
        } else {
          persistedWebUi.terminalEnabled = webUiRaw.terminalEnabled;
        }
      }
      if (webUiRaw.whitelistIps !== undefined) {
        const wl = validateWhitelistIpsDraft(
          webUiRaw.whitelistIps,
          "tunnel.webUi.whitelistIps",
          errors,
        );
        if (wl) persistedWebUi.whitelistIps = wl;
      }
      if (webUiEnabled) {
        if (!tunnelEnabled || !tunnelDomain) {
          errors.push({
            field: "tunnel.enabled",
            message:
              "tunnel.webUi.enabled requires tunnel.enabled true with a domain",
          });
        }
        const subdomain = persistedWebUi.subdomain;
        if (!subdomain || subdomain.length === 0) {
          errors.push({
            field: "tunnel.webUi.subdomain",
            message: "tunnel.webUi.subdomain is required when tunnel.webUi.enabled is true",
          });
        } else if (tunnelDomain) {
          const resolved = resolveWebUiHostname(subdomain, tunnelDomain);
          if (!resolved) {
            errors.push({
              field: "tunnel.webUi.subdomain",
              message:
                "tunnel.webUi.subdomain must be a DNS label or a hostname under tunnel.domain",
            });
          } else {
            effectiveWebUiHostname = resolved;
          }
        }
        if (!persistedWebUi.secret || persistedWebUi.secret.length === 0) {
          errors.push({
            field: "tunnel.webUi.secret",
            message: "tunnel.webUi.secret is required when tunnel.webUi.enabled is true",
          });
        }
      }
    }
  }

  // ---- tunnel.serviceTunnels ----
  const serviceTunnelsRaw = tunnelObj?.serviceTunnels;
  const persistedServiceTunnels: GlobalServiceTunnelsDraft = {};
  if (serviceTunnelsRaw !== undefined) {
    if (!isRecord(serviceTunnelsRaw)) {
      errors.push({
        field: "tunnel.serviceTunnels",
        message: "tunnel.serviceTunnels must be an object",
      });
    } else {
      if (serviceTunnelsRaw.enabled !== undefined) {
        if (typeof serviceTunnelsRaw.enabled !== "boolean") {
          errors.push({
            field: "tunnel.serviceTunnels.enabled",
            message: "tunnel.serviceTunnels.enabled must be a boolean",
          });
        } else {
          persistedServiceTunnels.enabled = serviceTunnelsRaw.enabled;
        }
      }
      if (serviceTunnelsRaw.whitelistIps !== undefined) {
        const wl = validateWhitelistIpsDraft(
          serviceTunnelsRaw.whitelistIps,
          "tunnel.serviceTunnels.whitelistIps",
          errors,
        );
        if (wl) persistedServiceTunnels.whitelistIps = wl;
      }
    }
  }

  // ---- web.ssl ----
  const webSslRaw = isRecord(webRaw) ? webRaw.ssl : undefined;
  const persistedWebSsl = validateSslDraft(webSslRaw, "web.ssl", errors, {
    publicHostname: effectiveWebUiHostname,
    tunnelEnabled,
    tunnelDomain,
  });

  // ---- tunnel.ssl ----
  const tunnelSslRaw = tunnelObj?.ssl;
  const persistedTunnelSsl = validateSslDraft(tunnelSslRaw, "tunnel.ssl", errors, {
    publicHostname: effectiveWebUiHostname,
    tunnelEnabled,
    tunnelDomain,
  });

  // ---- healthcheck ----
  const persistedHealthcheck: NonNullable<GlobalConfigDraft["healthcheck"]> = {};
  const healthcheckRaw = request.healthcheck;
  if (healthcheckRaw !== undefined) {
    if (!isRecord(healthcheckRaw)) {
      errors.push({ field: "healthcheck", message: "healthcheck must be an object" });
    } else {
      const validateDuration = (key: "timeout" | "start_period" | "interval" | "request_timeout") => {
        if (!(key in healthcheckRaw)) return;
        const v = healthcheckRaw[key];
        if (v === null || v === undefined) return;
        try {
          parseDurationValue(v, `healthcheck.${key}`);
          if (typeof v === "number" || typeof v === "string") {
            persistedHealthcheck[key] = v;
          } else {
            errors.push({
              field: `healthcheck.${key}`,
              message: `healthcheck.${key} must be a number or duration string`,
            });
          }
        } catch (e) {
          errors.push({ field: `healthcheck.${key}`, message: (e as Error).message });
        }
      };
      validateDuration("timeout");
      validateDuration("start_period");
      validateDuration("interval");
      validateDuration("request_timeout");
      if ("retries" in healthcheckRaw && healthcheckRaw.retries !== undefined && healthcheckRaw.retries !== null) {
        try {
          parseRetriesValue(healthcheckRaw.retries, "healthcheck.retries");
          persistedHealthcheck.retries = healthcheckRaw.retries as number;
        } catch (e) {
          errors.push({ field: "healthcheck.retries", message: (e as Error).message });
        }
      }
    }
  }

  // ---- terminalBackend ----
  let persistedTerminalBackend: TerminalBackendId | undefined;
  if ("terminalBackend" in request && request.terminalBackend !== undefined) {
    const raw = request.terminalBackend;
    if (!isTerminalBackendId(raw)) {
      errors.push({
        field: "terminalBackend",
        message: `terminalBackend must be one of ${SUPPORTED_TERMINAL_BACKENDS.map((v) => JSON.stringify(v)).join(", ")}`,
      });
    } else {
      persistedTerminalBackend = raw;
    }
  }

  // ---- editorCommand ----
  let persistedEditorCommand: string | undefined;
  let clearEditorCommand = false;
  if ("editorCommand" in request && request.editorCommand !== undefined) {
    const raw = request.editorCommand;
    if (raw === null || (typeof raw === "string" && raw.length === 0)) {
      // Explicit clear: persist nothing for the field.
      clearEditorCommand = true;
    } else if (typeof raw !== "string") {
      errors.push({
        field: "editorCommand",
        message: "editorCommand must be a string",
      });
    } else {
      persistedEditorCommand = raw;
    }
  }

  // ---- serviceBind ----
  let persistedServiceBind: string | undefined;
  let clearServiceBind = false;
  if ("serviceBind" in request && request.serviceBind !== undefined) {
    const raw = request.serviceBind;
    if (raw === null || (typeof raw === "string" && raw.trim().length === 0)) {
      // Explicit clear: persist nothing for the field.
      clearServiceBind = true;
    } else if (typeof raw !== "string") {
      errors.push({
        field: "serviceBind",
        message: "serviceBind must be a non-empty string",
      });
    } else {
      persistedServiceBind = raw.trim();
    }
  }

  // ---- aiProviders ----
  let persistedAiProviders: AiProviderDraft[] | undefined;
  if ("aiProviders" in request && request.aiProviders !== undefined && request.aiProviders !== null) {
    const aiProvidersRaw = request.aiProviders;
    if (!Array.isArray(aiProvidersRaw)) {
      errors.push({ field: "aiProviders", message: "aiProviders must be an array" });
    } else {
      const collected: AiProviderDraft[] = [];
      aiProvidersRaw.forEach((entry, index) => {
        const provider = validateAiProviderDraft(entry, index, errors);
        if (provider) collected.push(provider);
      });
      if (collected.length > 0) persistedAiProviders = collected;
    }
  }

  // ---- commitMessages ----
  // An explicitly present (even empty) `commitMessages` object is authoritative
  // so the AI page can clear the default; an omitted key is preserved from disk
  // in `saveGlobalConfig`.
  let persistedCommitMessages: CommitMessagesDraft | undefined;
  if (
    "commitMessages" in request &&
    request.commitMessages !== undefined &&
    request.commitMessages !== null
  ) {
    const raw = request.commitMessages;
    if (!isRecord(raw)) {
      errors.push({
        field: "commitMessages",
        message: "commitMessages must be an object",
      });
    } else {
      const draft: CommitMessagesDraft = {};
      if (raw.provider !== undefined && raw.provider !== null && raw.provider !== "") {
        if (typeof raw.provider !== "string") {
          errors.push({
            field: "commitMessages.provider",
            message: "commitMessages.provider must be a string",
          });
        } else {
          draft.provider = raw.provider;
        }
      }
      if (raw.model !== undefined && raw.model !== null && raw.model !== "") {
        if (typeof raw.model !== "string") {
          errors.push({
            field: "commitMessages.model",
            message: "commitMessages.model must be a string",
          });
        } else {
          draft.model = raw.model;
        }
      }
      if (Object.keys(draft).length > 0) persistedCommitMessages = draft;
    }
  }

  // ---- autoInjectAgentPlugins ----
  let persistedAutoInject: boolean | undefined;
  if (
    "autoInjectAgentPlugins" in request &&
    request.autoInjectAgentPlugins !== undefined &&
    request.autoInjectAgentPlugins !== null
  ) {
    const raw = request.autoInjectAgentPlugins;
    if (typeof raw !== "boolean") {
      errors.push({
        field: "autoInjectAgentPlugins",
        message: "autoInjectAgentPlugins must be a boolean",
      });
    } else {
      persistedAutoInject = raw;
    }
  }

  // ---- logging (pass-through; no settings UI yet, so deep validation is
  // deferred — the supported raw fields are preserved verbatim). ----
  const persistedLogging =
    "logging" in request && request.logging !== undefined && request.logging !== null
      ? extractLoggingDraft(request.logging)
      : undefined;

  if (errors.length > 0) return { ok: false, errors };

  // Compose persistable payload. Omit empty sections so the file stays clean.
  if (persistedWebSsl && Object.keys(persistedWebSsl).length > 0) {
    persistedWeb.ssl = persistedWebSsl;
  }
  if (persistedTunnelSsl && Object.keys(persistedTunnelSsl).length > 0) {
    persistedTunnel.ssl = persistedTunnelSsl;
  }
  if (Object.keys(persistedWebUi).length > 0) {
    persistedTunnel.webUi = persistedWebUi;
  }
  if (Object.keys(persistedServiceTunnels).length > 0) {
    persistedTunnel.serviceTunnels = persistedServiceTunnels;
  }
  if (Object.keys(persistedWeb).length > 0) persistable.web = persistedWeb;
  if (Object.keys(persistedTunnel).length > 0) persistable.tunnel = persistedTunnel;
  if (Object.keys(persistedHealthcheck).length > 0) persistable.healthcheck = persistedHealthcheck;
  if (persistedTerminalBackend !== undefined) {
    persistable.terminalBackend = persistedTerminalBackend;
  }
  if (persistedEditorCommand !== undefined && !clearEditorCommand) {
    persistable.editorCommand = persistedEditorCommand;
  }
  if (persistedServiceBind !== undefined && !clearServiceBind) {
    persistable.serviceBind = persistedServiceBind;
  }
  if (persistedAiProviders !== undefined) {
    persistable.aiProviders = persistedAiProviders;
  }
  if (persistedCommitMessages !== undefined) {
    persistable.commitMessages = persistedCommitMessages;
  }
  if (persistedAutoInject !== undefined) {
    persistable.autoInjectAgentPlugins = persistedAutoInject;
  }
  if (persistedLogging !== undefined) {
    persistable.logging = persistedLogging;
  }
  return { ok: true, persistable };
}

/**
 * Validate one submitted AI provider draft. Pushes field-specific errors onto
 * `errors` and returns the normalized draft when the entry is valid, or
 * `undefined` when it is not.
 */
function validateAiProviderDraft(
  raw: unknown,
  index: number,
  errors: GlobalConfigValidationError[],
): AiProviderDraft | undefined {
  const fieldBase = `aiProviders.${index}`;
  if (!isRecord(raw)) {
    errors.push({ field: fieldBase, message: `${fieldBase} must be an object` });
    return undefined;
  }
  let ok = true;
  const draft: AiProviderDraft = {};
  if (!isAiProviderType(raw.type)) {
    errors.push({
      field: `${fieldBase}.type`,
      message: `${fieldBase}.type must be one of ${SUPPORTED_AI_PROVIDER_TYPES.map((v) => JSON.stringify(v)).join(", ")}`,
    });
    ok = false;
  } else {
    draft.type = raw.type;
  }
  if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) {
    errors.push({
      field: `${fieldBase}.apiKey`,
      message: `${fieldBase}.apiKey is required and must be a non-empty string`,
    });
    ok = false;
  } else {
    draft.apiKey = raw.apiKey;
  }
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      errors.push({
        field: `${fieldBase}.name`,
        message: `${fieldBase}.name must be a non-empty string when set`,
      });
      ok = false;
    } else {
      draft.name = raw.name;
    }
  }
  if (raw.baseUrl !== undefined && raw.baseUrl !== null) {
    if (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0) {
      errors.push({
        field: `${fieldBase}.baseUrl`,
        message: `${fieldBase}.baseUrl must be a non-empty string when set`,
      });
      ok = false;
    } else {
      draft.baseUrl = raw.baseUrl;
    }
  }
  if (raw.models !== undefined && raw.models !== null) {
    if (!Array.isArray(raw.models)) {
      errors.push({
        field: `${fieldBase}.models`,
        message: `${fieldBase}.models must be an array of non-empty strings`,
      });
      ok = false;
    } else {
      const models: string[] = [];
      raw.models.forEach((model, modelIndex) => {
        if (typeof model !== "string" || model.length === 0) {
          errors.push({
            field: `${fieldBase}.models.${modelIndex}`,
            message: `${fieldBase}.models.${modelIndex} must be a non-empty string`,
          });
          ok = false;
        } else {
          models.push(model);
        }
      });
      if (ok) draft.models = models;
    }
  }
  return ok ? draft : undefined;
}

function validateWhitelistIpsDraft(
  raw: unknown,
  fieldPrefix: string,
  errors: GlobalConfigValidationError[],
): string[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push({
      field: fieldPrefix,
      message: `${fieldPrefix} must be an array of IP address strings`,
    });
    return undefined;
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !isValidIpAddress(entry)) {
      errors.push({
        field: fieldPrefix,
        message: `${fieldPrefix} contains an invalid IP address entry ${JSON.stringify(entry)}`,
      });
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

interface SslValidateContext {
  publicHostname: string | undefined;
  tunnelEnabled: boolean;
  tunnelDomain: string | undefined;
}

function validateSslDraft(
  raw: unknown,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  errors: GlobalConfigValidationError[],
  ctx: SslValidateContext,
): GlobalSslConfigDraft | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push({ field: fieldPrefix, message: `${fieldPrefix} must be an object` });
    return undefined;
  }
  const out: GlobalSslConfigDraft = {};
  let enabled = false;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      errors.push({
        field: `${fieldPrefix}.enabled`,
        message: `${fieldPrefix}.enabled must be a boolean`,
      });
    } else {
      enabled = raw.enabled;
      out.enabled = raw.enabled;
    }
  }
  let source: SslCertificateSource | undefined;
  if (raw.source !== undefined && raw.source !== null) {
    if (!isSslCertificateSource(raw.source)) {
      errors.push({
        field: `${fieldPrefix}.source`,
        message: `${fieldPrefix}.source must be one of ${SUPPORTED_SSL_SOURCES.map((v) => JSON.stringify(v)).join(", ")}`,
      });
    } else {
      source = raw.source;
      out.source = raw.source;
    }
  }
  let cert: string | undefined;
  if (raw.cert !== undefined && raw.cert !== null) {
    if (typeof raw.cert !== "string") {
      errors.push({
        field: `${fieldPrefix}.cert`,
        message: `${fieldPrefix}.cert must be a string`,
      });
    } else if (raw.cert.length > 0) {
      cert = raw.cert;
      out.cert = raw.cert;
    }
  }
  let key: string | undefined;
  if (raw.key !== undefined && raw.key !== null) {
    if (typeof raw.key !== "string") {
      errors.push({
        field: `${fieldPrefix}.key`,
        message: `${fieldPrefix}.key must be a string`,
      });
    } else if (raw.key.length > 0) {
      key = raw.key;
      out.key = raw.key;
    }
  }

  // Determine effective source for save-time validation. If user omitted
  // source, fall back to legacy cert+key inference matching loadGlobalConfig:
  // any cert/key value forces the "files" source so the XOR check fires.
  const legacyHasAnyPath =
    (raw.cert !== undefined && raw.cert !== null) ||
    (raw.key !== undefined && raw.key !== null);
  const effectiveSource: SslCertificateSource | undefined =
    source ?? (enabled ? (legacyHasAnyPath ? "files" : "self-signed") : undefined);

  if (enabled && effectiveSource === "files") {
    if ((cert !== undefined) !== (key !== undefined)) {
      const missing = cert === undefined ? "cert" : "key";
      errors.push({
        field: `${fieldPrefix}.${missing}`,
        message: `${fieldPrefix}.${missing} is required when the other certificate path is provided`,
      });
    }
  }

  // Let's Encrypt draft fields persist regardless, but validation enforces
  // shape only when source=letsencrypt.
  let leDraft: LetsEncryptConfigDraft | undefined;
  if (isRecord(raw.letsencrypt)) {
    leDraft = collectLetsEncryptDraft(raw.letsencrypt);
  }
  if (enabled && effectiveSource === "letsencrypt") {
    if (!isRecord(raw.letsencrypt)) {
      errors.push({
        field: `${fieldPrefix}.letsencrypt`,
        message: `${fieldPrefix}.letsencrypt is required when ${fieldPrefix}.source is "letsencrypt"`,
      });
    } else {
      const le = raw.letsencrypt;
      if (typeof le.email !== "string" || le.email.length === 0) {
        errors.push({
          field: `${fieldPrefix}.letsencrypt.email`,
          message: `${fieldPrefix}.letsencrypt.email is required when source is "letsencrypt"`,
        });
      }
      if (le.acceptTerms !== true) {
        errors.push({
          field: `${fieldPrefix}.letsencrypt.acceptTerms`,
          message: `${fieldPrefix}.letsencrypt.acceptTerms must be true to use Let's Encrypt`,
        });
      }
      if (le.directory !== undefined && !isLetsEncryptDirectory(le.directory)) {
        errors.push({
          field: `${fieldPrefix}.letsencrypt.directory`,
          message: `${fieldPrefix}.letsencrypt.directory must be "staging" or "production"`,
        });
      }
      if (!isRecord(le.challenge)) {
        errors.push({
          field: `${fieldPrefix}.letsencrypt.challenge`,
          message: `${fieldPrefix}.letsencrypt.challenge is required when source is "letsencrypt"`,
        });
      } else {
        validateChallengeDraft(le.challenge, fieldPrefix, errors);
      }

      if (fieldPrefix === "web.ssl") {
        if (!ctx.publicHostname || !isPublicDnsHostname(ctx.publicHostname)) {
          errors.push({
            field: "tunnel.webUi.subdomain",
            message:
              "web.ssl.source=letsencrypt requires a public Web UI hostname (tunnel.webUi.subdomain under tunnel.domain)",
          });
        }
      } else {
        if (!ctx.tunnelEnabled || !ctx.tunnelDomain || !isPublicDnsHostname(ctx.tunnelDomain)) {
          errors.push({
            field: "tunnel.domain",
            message:
              "tunnel.ssl.source=letsencrypt requires an enabled tunnel with a public DNS domain",
          });
        }
      }
    }
  }
  if (leDraft) out.letsencrypt = leDraft;
  return out;
}

function collectLetsEncryptDraft(
  raw: Record<string, unknown>,
): LetsEncryptConfigDraft {
  const out: LetsEncryptConfigDraft = {};
  if (typeof raw.email === "string") out.email = raw.email;
  if (typeof raw.acceptTerms === "boolean") out.acceptTerms = raw.acceptTerms;
  if (isLetsEncryptDirectory(raw.directory)) out.directory = raw.directory;
  const ch = extractChallengeDraft(raw.challenge);
  if (ch) out.challenge = ch;
  return out;
}

function validateChallengeDraft(
  ch: Record<string, unknown>,
  fieldPrefix: "web.ssl" | "tunnel.ssl",
  errors: GlobalConfigValidationError[],
): void {
  const challengePath = `${fieldPrefix}.letsencrypt.challenge`;
  if (ch.type !== "dns-01") {
    errors.push({
      field: `${challengePath}.type`,
      message: `${challengePath}.type must be "dns-01"`,
    });
  }
  if (!isLetsEncryptProvider(ch.provider)) {
    errors.push({
      field: `${challengePath}.provider`,
      message: `${challengePath}.provider must be one of ${SUPPORTED_LETSENCRYPT_PROVIDERS.map((v) => JSON.stringify(v)).join(", ")}`,
    });
    return;
  }
  if (ch.provider === "hook") {
    if (typeof ch.createCommand !== "string" || ch.createCommand.length === 0) {
      errors.push({
        field: `${challengePath}.createCommand`,
        message: `${challengePath}.createCommand is required`,
      });
    }
    if (typeof ch.deleteCommand !== "string" || ch.deleteCommand.length === 0) {
      errors.push({
        field: `${challengePath}.deleteCommand`,
        message: `${challengePath}.deleteCommand is required`,
      });
    }
  } else {
    const apiTokenEnv =
      typeof ch.apiTokenEnv === "string" && ch.apiTokenEnv.length > 0
        ? ch.apiTokenEnv
        : undefined;
    if (
      ch.apiTokenEnv !== undefined &&
      apiTokenEnv === undefined
    ) {
      errors.push({
        field: `${challengePath}.apiTokenEnv`,
        message: `${challengePath}.apiTokenEnv must be a non-empty string when set`,
      });
    }
    const apiToken =
      typeof ch.apiToken === "string" && ch.apiToken.length > 0
        ? ch.apiToken
        : undefined;
    if (
      ch.apiToken !== undefined &&
      apiToken === undefined
    ) {
      errors.push({
        field: `${challengePath}.apiToken`,
        message: `${challengePath}.apiToken must be a non-empty string when set`,
      });
    }
    if (!apiTokenEnv && !apiToken) {
      errors.push({
        field: `${challengePath}.apiTokenEnv`,
        message: `${challengePath}.apiTokenEnv or ${challengePath}.apiToken is required for the Cloudflare provider`,
      });
    }
    if (
      ch.zoneId !== undefined &&
      (typeof ch.zoneId !== "string" || ch.zoneId.length === 0)
    ) {
      errors.push({
        field: `${challengePath}.zoneId`,
        message: `${challengePath}.zoneId must be a non-empty string when set`,
      });
    }
  }
  if (
    ch.propagationSeconds !== undefined &&
    (typeof ch.propagationSeconds !== "number" ||
      !Number.isInteger(ch.propagationSeconds) ||
      ch.propagationSeconds < 0)
  ) {
    errors.push({
      field: `${challengePath}.propagationSeconds`,
      message: `${challengePath}.propagationSeconds must be a non-negative integer`,
    });
  }
}

/**
 * Read the supported raw `logging` draft from the on-disk config, or undefined
 * when the file is absent, unreadable, or carries no logging block. Used by the
 * save flow to preserve a hand-edited logging section.
 */
async function readExistingLoggingDraft(
  path: string,
): Promise<LoggingConfigDraft | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    const parsed = await file.json();
    if (!isRecord(parsed)) return undefined;
    return extractLoggingDraft(parsed.logging);
  } catch {
    return undefined;
  }
}

async function readExistingCommitMessagesDraft(
  path: string,
): Promise<CommitMessagesDraft | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    const parsed = await file.json();
    if (!isRecord(parsed)) return undefined;
    return extractCommitMessagesDraft(parsed.commitMessages);
  } catch {
    return undefined;
  }
}

/**
 * Read the full (non-redacted) `notifications` block from the on-disk config,
 * or undefined when absent/unreadable. Used by the generic save flow to
 * preserve the notification settings — including the real Telegram token and
 * stored subscriptions — since those persist through the dedicated endpoints,
 * not the generic settings draft.
 */
async function readExistingNotifications(
  path: string,
): Promise<NotificationsConfig | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    const parsed = await file.json();
    if (!isRecord(parsed) || parsed.notifications === undefined) return undefined;
    return parseNotifications(parsed.notifications, path, () => {});
  } catch {
    return undefined;
  }
}

/**
 * Persist the `notifications` block in-place, preserving every other key in the
 * existing `config.json` (including ones this build does not recognize). Used
 * by the dedicated notification endpoints so saving channel config never
 * clobbers unrelated settings. The file is written with owner-only permissions
 * because it now holds the Telegram token and push subscriptions.
 */
export async function writeNotificationsConfig(
  notifications: NotificationsConfig,
  opts: LoadGlobalConfigOptions = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const path = globalConfigPath(env);
  let parsed: Record<string, unknown> = {};
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const json = await file.json();
      if (isRecord(json)) parsed = json;
    } catch {
      parsed = {};
    }
  }
  parsed.notifications = notifications;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) ignore POSIX perms.
  }
}

export interface SaveGlobalConfigOptions extends LoadGlobalConfigOptions {}

/**
 * Validate and persist supported global settings to `<wos-home>/config.json`.
 * Returns the refreshed management snapshot when the write succeeds, or a
 * validation result when validation fails (the file is not touched).
 */
export async function saveGlobalConfig(
  request: unknown,
  opts: SaveGlobalConfigOptions = {},
): Promise<
  | { ok: true; snapshot: GlobalConfigManagementSnapshot }
  | { ok: false; errors: GlobalConfigValidationError[] }
> {
  const result = validateGlobalConfigSave(request);
  if (!result.ok) return result;
  const env = opts.env ?? process.env;
  const path = globalConfigPath(env);
  // Preserve a hand-edited `logging` block when the save request omits one:
  // there is no settings UI for logging, so an ordinary settings save must not
  // clobber it. A request that does carry `logging` wins.
  if (result.persistable.logging === undefined) {
    const existing = await readExistingLoggingDraft(path);
    if (existing) result.persistable.logging = existing;
  }
  // Preserve an existing `commitMessages` block when the save request omits the
  // key entirely (e.g. a save from a settings page other than AI providers). An
  // explicitly present `commitMessages` (including a cleared/empty one) is
  // authoritative and is honored as-is.
  if (
    result.persistable.commitMessages === undefined &&
    !(isRecord(request) && "commitMessages" in request)
  ) {
    const existing = await readExistingCommitMessagesDraft(path);
    if (existing) result.persistable.commitMessages = existing;
  }
  // Preserve the `notifications` block on every generic save: it is managed by
  // the dedicated notification endpoints and never travels in the settings
  // draft, so an ordinary save must not drop it (or its secrets).
  if (result.persistable.notifications === undefined) {
    const existing = await readExistingNotifications(path);
    if (existing) result.persistable.notifications = existing;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result.persistable, null, 2) + "\n", "utf8");
  const snapshot = await buildManagementSnapshot(opts);
  return { ok: true, snapshot };
}
