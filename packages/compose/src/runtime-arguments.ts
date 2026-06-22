import type { WosConfig } from "@worktreeos/core/config";

/**
 * Submitted runtime argument values keyed by declared argument name. Empty
 * string values are treated as "unset" so `${KEY:-default}` template
 * expansions can still apply their defaults.
 */
export type RuntimeArgumentMap = Record<string, string>;

export class RuntimeArgumentError extends Error {}

/**
 * Validate that every submitted runtime argument is declared by the resolved
 * generated-compose config. Throws `RuntimeArgumentError` on the first
 * unknown key so callers can map it to a deterministic validation message.
 */
export function validateRuntimeArguments(
  config: WosConfig,
  submitted: RuntimeArgumentMap | undefined,
): void {
  if (!submitted) return;
  const declared = new Set(config.arguments ?? []);
  for (const key of Object.keys(submitted)) {
    if (!declared.has(key)) {
      throw new RuntimeArgumentError(
        `runtime argument "${key}" is not declared in the deploy config "arguments" list`,
      );
    }
  }
}
