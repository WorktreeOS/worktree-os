import { createHash } from "node:crypto";
import { wosHome } from "./paths";

export const WOS_LABEL_MANAGED = "dev.wos.managed";
export const WOS_LABEL_SCHEMA = "dev.wos.schema";
export const WOS_LABEL_HOME_HASH = "dev.wos.home-hash";
export const WOS_LABEL_SESSION = "dev.wos.session";
export const WOS_LABEL_PROJECT = "dev.wos.project";
export const WOS_LABEL_MODE = "dev.wos.mode";
export const WOS_LABEL_SERVICE = "dev.wos.service";
export const WOS_LABEL_DEPLOYMENT_ID = "dev.wos.deployment-id";
export const WOS_LABEL_TUNNEL_PORTS = "dev.wos.tunnel.ports";
export const WOS_LABEL_TUNNEL_HOSTNAME_PREFIX = "dev.wos.tunnel";
export const WOS_LABEL_TUNNEL_HOST_PORT_PREFIX = "dev.wos.tunnel";

export const WOS_ENV_HOSTNAME_PREFIX = "WOS_SERVICE_HOSTNAME";
export const WOS_ENV_HOSTNAME = "WOS_SERVICE_HOSTNAME";
export const WOS_ENV_PORT = "WOS_SERVICE_PORT";

export const WOS_LABEL_SCHEMA_VALUE = "1";

export type WosMode = "generated" | "compose";

export function tunnelHostnameLabelKey(containerPort: number): string {
  return `${WOS_LABEL_TUNNEL_HOSTNAME_PREFIX}.${containerPort}.hostname`;
}

export function tunnelHostPortLabelKey(containerPort: number): string {
  return `${WOS_LABEL_TUNNEL_HOST_PORT_PREFIX}.${containerPort}.host-port`;
}

export function tunnelEnvHostnameKey(containerPort: number): string {
  return `${WOS_ENV_HOSTNAME_PREFIX}_${containerPort}`;
}

/**
 * Derive the cross-mode convenience environment pair (`WOS_SERVICE_PORT` /
 * `WOS_SERVICE_HOSTNAME`) describing the first wos-managed service port. Both
 * Docker-backed modes and shell mode share this contract: the first configured
 * port resolves to its allocated host port and active tunnel hostname, falling
 * back to `localhost` when no tunnel hostname is active.
 *
 * Returns an empty object when the service has no managed port or the first
 * port has no host-port assignment, so callers can omit the variables for
 * no-port services.
 */
export function firstManagedPortServiceEnv(input: {
  /** Container ports in declaration order. */
  containerPorts: readonly number[];
  /** Allocated host ports keyed by container-port string. */
  hostPorts: Record<string, number> | undefined;
  /** Active tunnel hostnames keyed by container-port string. */
  tunnelHostnames: Record<string, string> | undefined;
}): Record<string, string> {
  const firstPort = input.containerPorts[0];
  if (firstPort === undefined) return {};
  const host = input.hostPorts?.[String(firstPort)];
  if (typeof host !== "number") return {};
  return {
    [WOS_ENV_PORT]: String(host),
    [WOS_ENV_HOSTNAME]: input.tunnelHostnames?.[String(firstPort)] ?? "localhost",
  };
}

export function generateDeploymentId(): string {
  return crypto.randomUUID();
}

export function stableWosHomeHash(env?: NodeJS.ProcessEnv): string {
  const home = wosHome(env);
  return createHash("sha256").update(home).digest("hex").slice(0, 16);
}

/**
 * Identity labels written to every wos-managed service container.
 * Tunnel hostname/port labels are additive and applied separately.
 */
export interface WosIdentityLabelInput {
  homeHash: string;
  sessionName: string;
  projectName: string;
  mode: WosMode;
  serviceName: string;
  deploymentId?: string;
}

export function buildWosIdentityLabels(
  input: WosIdentityLabelInput,
): Record<string, string> {
  const labels: Record<string, string> = {
    [WOS_LABEL_MANAGED]: "true",
    [WOS_LABEL_SCHEMA]: WOS_LABEL_SCHEMA_VALUE,
    [WOS_LABEL_HOME_HASH]: input.homeHash,
    [WOS_LABEL_SESSION]: input.sessionName,
    [WOS_LABEL_PROJECT]: input.projectName,
    [WOS_LABEL_MODE]: input.mode,
    [WOS_LABEL_SERVICE]: input.serviceName,
  };
  if (input.deploymentId) {
    labels[WOS_LABEL_DEPLOYMENT_ID] = input.deploymentId;
  }
  return labels;
}
