import { describe, expect, test } from "bun:test";
import type { WosConfig } from "@worktreeos/core/config";
import { DEFAULT_HOST_PORT_RANGE } from "@worktreeos/core/config";
import {
  resolveServiceSelection,
  ServiceSelectionError,
} from "@worktreeos/compose/service-selection";

function makeConfig(
  partial: Partial<WosConfig> & {
    services?: Record<string, { dependencies?: string[] }>;
    deps?: Record<string, { image: string; ports?: number[] }>;
    targets?: Record<string, string[]>;
  } = {},
): WosConfig {
  const services: Record<string, any> = {};
  for (const [name, svc] of Object.entries(partial.services ?? {})) {
    services[name] = {
      image: null,
      ports: [],
      script: [],
      cwd: null,
      envFile: null,
      environment: {},
      volumes: [],
      initScript: [],
      dependencies: svc.dependencies ?? [],
    };
  }
  const deps: Record<string, any> = {};
  for (const [name, dep] of Object.entries(partial.deps ?? {})) {
    deps[name] = {
      image: dep.image,
      ports: dep.ports ?? [],
      environment: {},
      volumes: [],
    };
  }
  return {
    mode: "generated",
    cloneVolumes: [],
    app: {
      image: "node:22",
      initScript: [],
      services,
    },
    deps,
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    cache: [],
    targets: partial.targets ?? {},
  };
}

describe("resolveServiceSelection", () => {
  test("all selection includes every configured service", () => {
    const cfg = makeConfig({
      services: { app: {}, api: {} },
      deps: { db: { image: "postgres:13" } },
    });
    const res = resolveServiceSelection(cfg, { kind: "all" });
    expect(res.isFull).toBe(true);
    expect(res.services.sort()).toEqual(["api", "app", "db"]);
  });

  test("explicit selection includes only requested services", () => {
    const cfg = makeConfig({
      services: { app: {}, api: {}, admin: {} },
    });
    const res = resolveServiceSelection(cfg, {
      kind: "services",
      services: ["app"],
    });
    expect(res.isFull).toBe(false);
    expect(res.services).toEqual(["app"]);
  });

  test("explicit selection expands transitive dependencies", () => {
    const cfg = makeConfig({
      services: {
        app: { dependencies: ["api"] },
        api: { dependencies: ["db"] },
        admin: {},
      },
      deps: { db: { image: "postgres:13" } },
    });
    const res = resolveServiceSelection(cfg, {
      kind: "services",
      services: ["app"],
    });
    expect(res.services).toEqual(["db", "api", "app"]);
    expect(res.isFull).toBe(false);
  });

  test("target selection expands transitive dependencies", () => {
    const cfg = makeConfig({
      services: { app: { dependencies: ["api"] }, api: {}, admin: {} },
      targets: { app: ["app"] },
    });
    const res = resolveServiceSelection(cfg, { kind: "target", target: "app" });
    expect(res.services).toEqual(["api", "app"]);
  });

  test("target with multiple entries deduplicates", () => {
    const cfg = makeConfig({
      services: { app: { dependencies: ["api"] }, api: {} },
      targets: { app: ["app", "api"] },
    });
    const res = resolveServiceSelection(cfg, { kind: "target", target: "app" });
    expect(res.services).toEqual(["api", "app"]);
  });

  test("rejects unknown explicit service", () => {
    const cfg = makeConfig({ services: { app: {} } });
    expect(() =>
      resolveServiceSelection(cfg, { kind: "services", services: ["nope"] }),
    ).toThrow(ServiceSelectionError);
  });

  test("rejects unknown target", () => {
    const cfg = makeConfig({ services: { app: {} } });
    expect(() =>
      resolveServiceSelection(cfg, { kind: "target", target: "nope" }),
    ).toThrow(/unknown target/);
  });

  test("rejects empty service selection", () => {
    const cfg = makeConfig({ services: { app: {} } });
    expect(() =>
      resolveServiceSelection(cfg, { kind: "services", services: [] }),
    ).toThrow(/must not be empty/);
  });

  test("rejects dependency cycle", () => {
    const cfg = makeConfig({
      services: {
        app: { dependencies: ["api"] },
        api: { dependencies: ["app"] },
      },
    });
    expect(() =>
      resolveServiceSelection(cfg, { kind: "services", services: ["app"] }),
    ).toThrow(/dependency cycle/);
  });
});
