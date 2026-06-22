import type { WosConfig } from "@worktreeos/core/config";

/**
 * Selection input from the CLI/daemon/UI layer. `all` is the default
 * full-deployment behavior. `services` selects an explicit list. `target`
 * selects via a configured target alias. Exactly one of services/target
 * may be set; mixing them is rejected by validation.
 */
export type ServiceSelectionInput =
  | { kind: "all" }
  | { kind: "services"; services: string[] }
  | { kind: "target"; target: string };

export interface ResolvedServiceSelection {
  /**
   * Resolved app+deps services in dependency-first order. For `all`, the
   * order is `deps` (sorted) then `app.services` (sorted). For explicit or
   * target selection, each requested entry expands through its transitive
   * dependencies in dependency-first order; deduplicated across selections.
   */
  services: string[];
  /** True when the selection covers every configured generated service. */
  isFull: boolean;
}

export class ServiceSelectionError extends Error {}

/**
 * Resolve a startup selection against a generated-compose config. Validates
 * unknown service/target names, mixed selection, empty selection, and
 * dependency cycles before returning the resolved set.
 */
export function resolveServiceSelection(
  config: WosConfig,
  input: ServiceSelectionInput,
): ResolvedServiceSelection {
  const appServiceNames = Object.keys(config.app.services).sort();
  const depNames = Object.keys(config.deps).sort();
  const knownServices = new Set<string>([...appServiceNames, ...depNames]);

  if (input.kind === "all") {
    const all = [...depNames, ...appServiceNames];
    return { services: dependencyFirstOrder(all, config), isFull: true };
  }

  let seeds: string[];
  if (input.kind === "services") {
    if (input.services.length === 0) {
      throw new ServiceSelectionError("service selection must not be empty");
    }
    for (const name of input.services) {
      if (!knownServices.has(name)) {
        throw new ServiceSelectionError(
          `unknown service "${name}" in selection`,
        );
      }
    }
    seeds = input.services;
  } else {
    const targets = config.targets ?? {};
    if (input.target.length === 0) {
      throw new ServiceSelectionError("target name must not be empty");
    }
    const entries = targets[input.target];
    if (entries === undefined) {
      throw new ServiceSelectionError(`unknown target "${input.target}"`);
    }
    seeds = entries;
  }

  const closure = closeWithDependencies(seeds, config);
  const ordered = dependencyFirstOrder(closure, config);
  const isFull =
    ordered.length === knownServices.size &&
    ordered.every((s) => knownServices.has(s));
  return { services: ordered, isFull };
}

function closeWithDependencies(seeds: string[], config: WosConfig): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const stack: string[] = [...seeds];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    result.push(name);
    const svc = config.app.services[name];
    if (svc) {
      for (const dep of svc.dependencies ?? []) {
        if (!visited.has(dep)) stack.push(dep);
      }
    }
  }
  return result;
}

function dependencyFirstOrder(
  names: string[],
  config: WosConfig,
): string[] {
  const nameSet = new Set(names);
  const ordered: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (name: string): void => {
    const cur = state.get(name);
    if (cur === "done") return;
    if (cur === "visiting") {
      const idx = stack.indexOf(name);
      const cycle = stack.slice(idx).concat(name).join(" -> ");
      throw new ServiceSelectionError(`dependency cycle: ${cycle}`);
    }
    state.set(name, "visiting");
    stack.push(name);
    const svc = config.app.services[name];
    if (svc) {
      const deps = (svc.dependencies ?? []).filter((d) => nameSet.has(d));
      for (const d of deps) visit(d);
    }
    stack.pop();
    state.set(name, "done");
    ordered.push(name);
  };

  const sorted = [...names].sort();
  for (const name of sorted) {
    if (!state.has(name)) visit(name);
  }
  return ordered;
}
