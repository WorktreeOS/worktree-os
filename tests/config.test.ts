import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  appPortFromNumber,
  cloneVolume,
  ConfigError,
  DEFAULT_HOST_PORT_RANGE,
  loadConfig,
  validateConfig,
} from "@worktreeos/core/config";

async function makeTmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "wos-test-"));
}

describe("validateConfig", () => {
  test("empty config returns defaults", () => {
    const cfg = validateConfig(null);
    expect(cfg).toEqual({
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
    });
  });

  test("parses example-shaped config", () => {
    const cfg = validateConfig({
      clone_volumes: [".data", ".env.local"],
      app: {
        image: "node:22",
        init_script: ["bun install"],
        connect_npm_cache: true,
        connect_yarn_cache: "/tmp/yarn-cache",
        connect_bun_cache: "~/bun-cache",
        services: {
          api: { ports: [3000], script: ["bun dev"] },
          web: { ports: [4200, 4210], script: ["bun dev"] },
        },
      },
      deps: {
        db: {
          image: "postgres:13",
          ports: [5432],
          environment: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "111111" },
          volumes: ["./.data/postgres:/var/lib/postgresql/data"],
        },
      },
    });
    expect(cfg.cloneVolumes).toEqual([cloneVolume(".data"), cloneVolume(".env.local")]);
    expect(cfg.app.image).toBe("node:22");
    expect(cfg.app.initScript).toEqual(["bun install"]);
    expect(cfg.app.connectNpmCache).toBe(true);
    expect(cfg.app.connectYarnCache).toBe("/tmp/yarn-cache");
    expect(cfg.app.connectBunCache).toBe("~/bun-cache");
    expect(cfg.app.services).toEqual({
      api: {
        image: null,
        ports: [appPortFromNumber(3000)],
        script: ["bun dev"],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
        initScript: [],
        dependencies: [],
      },
      web: {
        image: null,
        ports: [appPortFromNumber(4200), appPortFromNumber(4210)],
        script: ["bun dev"],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
        initScript: [],
        dependencies: [],
      },
    });
    expect(cfg.hostPorts).toEqual({ ...DEFAULT_HOST_PORT_RANGE });
    expect(cfg.deps.db).toEqual({
      image: "postgres:13",
      ports: [5432],
      environment: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "111111" },
      volumes: ["./.data/postgres:/var/lib/postgresql/data"],
    });
  });

  test("coerces env values that are numbers or booleans to strings", () => {
    const cfg = validateConfig({
      deps: {
        db: { image: "postgres:13", environment: { PORT: 5432, ENABLED: true } },
      },
    });
    expect(cfg.deps.db!.environment).toEqual({ PORT: "5432", ENABLED: "true" });
  });

  test("rejects non-mapping root", () => {
    expect(() => validateConfig(["x"])).toThrow(ConfigError);
  });

  test("rejects non-string clone_volumes entry", () => {
    expect(() => validateConfig({ clone_volumes: [123] })).toThrow(ConfigError);
  });

  test("parses single-path clone_volumes entries as source=destination", () => {
    const cfg = validateConfig({ clone_volumes: [".data"] });
    expect(cfg.cloneVolumes).toEqual([cloneVolume(".data")]);
  });

  test("parses mapped clone_volumes entries", () => {
    const cfg = validateConfig({ clone_volumes: [".env.local:.env"] });
    expect(cfg.cloneVolumes).toEqual([cloneVolume(".env.local", ".env")]);
  });

  test("parses absolute source and destination in clone_volumes", () => {
    const cfg = validateConfig({ clone_volumes: ["/shared/secrets:.env"] });
    expect(cfg.cloneVolumes[0]!.source).toBe("/shared/secrets");
    expect(cfg.cloneVolumes[0]!.destination).toBe(".env");
  });

  test("rejects clone_volumes mapped entry with empty source", () => {
    expect(() => validateConfig({ clone_volumes: [":.env"] })).toThrow(/empty source/);
  });

  test("rejects clone_volumes mapped entry with empty destination", () => {
    expect(() => validateConfig({ clone_volumes: [".env.local:"] })).toThrow(/empty destination/);
  });

  test("rejects empty string clone_volumes entry", () => {
    expect(() => validateConfig({ clone_volumes: [""] })).toThrow(ConfigError);
  });

  test("treats Windows single-path clone_volumes entry as one path", () => {
    const cfg = validateConfig({ clone_volumes: ["C:\\shared\\.env"] });
    expect(cfg.cloneVolumes[0]!.source).toBe("C:\\shared\\.env");
    expect(cfg.cloneVolumes[0]!.destination).toBe("C:\\shared\\.env");
  });

  test("splits Windows mapped clone_volumes entry at the mapping separator", () => {
    const cfg = validateConfig({ clone_volumes: ["C:\\shared\\.env:D:\\worktree\\.env"] });
    expect(cfg.cloneVolumes[0]!.source).toBe("C:\\shared\\.env");
    expect(cfg.cloneVolumes[0]!.destination).toBe("D:\\worktree\\.env");
  });

  test("splits Windows source mapped to relative destination", () => {
    const cfg = validateConfig({ clone_volumes: ["C:/shared/.env:.env"] });
    expect(cfg.cloneVolumes[0]!.source).toBe("C:/shared/.env");
    expect(cfg.cloneVolumes[0]!.destination).toBe(".env");
  });

  test("parses object clone_volumes entries", () => {
    const cfg = validateConfig({
      clone_volumes: [{ source: "C:\\shared\\.env", destination: ".env" }],
    });
    expect(cfg.cloneVolumes[0]!.source).toBe("C:\\shared\\.env");
    expect(cfg.cloneVolumes[0]!.destination).toBe(".env");
    expect(cfg.cloneVolumes[0]!.displayPath).toBe("C:\\shared\\.env:.env");
  });

  test("rejects object clone_volumes entry without source", () => {
    expect(() => validateConfig({ clone_volumes: [{ destination: ".env" }] })).toThrow(
      /clone_volumes\[0\].*source/,
    );
  });

  test("rejects object clone_volumes entry without destination", () => {
    expect(() => validateConfig({ clone_volumes: [{ source: ".env" }] })).toThrow(
      /clone_volumes\[0\].*destination/,
    );
  });

  test("rejects object clone_volumes entry with empty source", () => {
    expect(() =>
      validateConfig({ clone_volumes: [{ source: "", destination: ".env" }] }),
    ).toThrow(ConfigError);
  });

  test("rejects non-list app.init_script", () => {
    expect(() => validateConfig({ app: { image: "node:22", init_script: "bun install" } })).toThrow(
      ConfigError,
    );
  });

  test("rejects invalid package manager cache connector values", () => {
    expect(() =>
      validateConfig({ app: { connect_npm_cache: 1 } }),
    ).toThrow(/app\.connect_npm_cache/);
    expect(() =>
      validateConfig({ app: { connect_yarn_cache: "" } }),
    ).toThrow(/app\.connect_yarn_cache/);
    expect(() =>
      validateConfig({ app: { connect_bun_cache: "relative/cache" } }),
    ).toThrow(/app\.connect_bun_cache/);
  });

  test("rejects empty string app.image", () => {
    expect(() => validateConfig({ app: { image: "" } })).toThrow(ConfigError);
  });

  test("accepts app.services when each service has its own image and app.image is absent", () => {
    const cfg = validateConfig({
      app: {
        services: {
          api: { image: "node:22", ports: [3000], script: ["bun dev"] },
          worker: { image: "python:3.12", script: ["python worker.py"] },
        },
      },
    });
    expect(cfg.app.image).toBeNull();
    expect(cfg.app.services.api!.image).toBe("node:22");
    expect(cfg.app.services.worker!.image).toBe("python:3.12");
  });

  test("inherits app.image when service.image is not set", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: { api: { ports: [3000], script: ["bun dev"] } },
      },
    });
    expect(cfg.app.image).toBe("node:22");
    expect(cfg.app.services.api!.image).toBeNull();
  });

  test("parses explicit service.image override", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          worker: { image: "python:3.12", script: ["python worker.py"] },
        },
      },
    });
    expect(cfg.app.services.worker!.image).toBe("python:3.12");
  });

  test("rejects app.services.<name>.image as empty string", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: { image: "", ports: [3000] } } },
      }),
    ).toThrow(ConfigError);
  });

  test("rejects app.services without effective image", () => {
    expect(() =>
      validateConfig({
        app: {
          services: {
            api: { image: "node:22" },
            worker: { script: ["python worker.py"] },
          },
        },
      }),
    ).toThrow(/app\.services\.worker\.image is required/);
  });

  test("rejects app.init_script without app.image", () => {
    expect(() => validateConfig({ app: { init_script: ["bun install"] } })).toThrow(ConfigError);
  });

  test("rejects app.services.* port out of range", () => {
    expect(() =>
      validateConfig({ app: { image: "node:22", services: { api: { ports: [0] } } } }),
    ).toThrow(ConfigError);
    expect(() =>
      validateConfig({ app: { image: "node:22", services: { api: { ports: [70000] } } } }),
    ).toThrow(ConfigError);
  });

  test("numeric app port defaults to enabled healthcheck", () => {
    const cfg = validateConfig({
      app: { image: "node:22", services: { api: { ports: [3000] } } },
    });
    expect(cfg.app.services.api!.ports).toEqual([
      {
        containerPort: 3000,
        allowFailure: false,
        healthcheck: {
          enabled: true,
          url: "/",
        },
      },
    ]);
  });

  test("app port object with healthcheck: false disables healthcheck", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: { api: { ports: [{ port: 3000, healthcheck: false }] } },
      },
    });
    expect(cfg.app.services.api!.ports).toEqual([
      {
        containerPort: 3000,
        allowFailure: false,
        healthcheck: { enabled: false },
      },
    ]);
  });

  test("app port object with custom healthcheck settings", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          api: {
            ports: [
              {
                port: 3000,
                healthcheck: {
                  url: "/health/check",
                  status: 204,
                  timeout: "45s",
                  start_period: "5s",
                  interval: "2.5s",
                  retries: 5,
                },
              },
            ],
          },
        },
      },
    });
    expect(cfg.app.services.api!.ports[0]).toEqual({
      containerPort: 3000,
      allowFailure: false,
      healthcheck: {
        enabled: true,
        url: "/health/check",
        expectedStatus: 204,
        timeoutMs: 45000,
        startPeriodMs: 5000,
        intervalMs: 2500,
        retries: 5,
      },
    });
  });

  test("app port with allow_failure: true", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: { api: { ports: [{ port: 3000, allow_failure: true }] } },
      },
    });
    expect(cfg.app.services.api!.ports[0]?.allowFailure).toBe(true);
    expect(cfg.app.services.api!.ports[0]?.healthcheck).toEqual({
      enabled: true,
      url: "/",
    });
  });

  test("rejects app port object without port field", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: { ports: [{ healthcheck: false }] } } },
      }),
    ).toThrow(/app\.services\.api\.ports\[0\]\.port is required/);
  });

  test("rejects non-absolute healthcheck url", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: {
            api: { ports: [{ port: 3000, healthcheck: { url: "health" } }] },
          },
        },
      }),
    ).toThrow(/absolute path/);
  });

  test("rejects invalid healthcheck expected status", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: {
            api: { ports: [{ port: 3000, healthcheck: { status: 99 } }] },
          },
        },
      }),
    ).toThrow(/100\.\.599/);
  });

  test("rejects non-positive healthcheck timeout", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: {
            api: { ports: [{ port: 3000, healthcheck: { timeout: 0 } }] },
          },
        },
      }),
    ).toThrow(/positive duration/);
  });

  test("rejects invalid healthcheck timing settings", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: {
            api: { ports: [{ port: 3000, healthcheck: { start_period: "soon" } }] },
          },
        },
      }),
    ).toThrow(/positive duration/);

    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: {
            api: { ports: [{ port: 3000, healthcheck: { interval: 0 } }] },
          },
        },
      }),
    ).toThrow(/positive duration/);

    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: {
            api: { ports: [{ port: 3000, healthcheck: { retries: 0 } }] },
          },
        },
      }),
    ).toThrow(/positive integer/);
  });

  test("app port tunnel field is rejected with migration guidance", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { ports: [{ port: 3000, tunnel: true }] } },
        },
      }),
    ).toThrow(/tunnel is no longer supported.*config\.json.*--no-tunnel/s);
  });

  test("app port without tunnel field validates cleanly", () => {
    const cfg = validateConfig({
      app: { image: "node:22", services: { api: { ports: [{ port: 3000 }] } } },
    });
    expect(cfg.app.services.api!.ports[0]?.containerPort).toBe(3000);
    expect((cfg.app.services.api!.ports[0] as unknown as Record<string, unknown>).tunnel).toBeUndefined();
  });

  test("rejects healthcheck shaped entry on deps ports", () => {
    expect(() =>
      validateConfig({
        deps: {
          db: {
            image: "postgres:13",
            ports: [{ port: 5432, healthcheck: false }],
          },
        },
      }),
    ).toThrow(ConfigError);
  });

  test("rejects deps.* without image", () => {
    expect(() => validateConfig({ deps: { db: { ports: [5432] } } })).toThrow(ConfigError);
  });

  test("rejects deps.* environment that is not a mapping", () => {
    expect(() =>
      validateConfig({ deps: { db: { image: "postgres:13", environment: ["FOO=bar"] } } }),
    ).toThrow(ConfigError);
  });

  test("rejects deps.* port out of range", () => {
    expect(() =>
      validateConfig({ deps: { db: { image: "postgres:13", ports: [99999] } } }),
    ).toThrow(ConfigError);
  });

  test("rejects removed compose field with migration hint", () => {
    expect(() => validateConfig({ compose: "docker-compose.yaml" })).toThrow(
      /no longer supported/,
    );
  });

  test("rejects misspelled cloned_volumes field", () => {
    expect(() => validateConfig({ cloned_volumes: [".data"] })).toThrow(
      /cloned_volumes.*clone_volumes/,
    );
  });

  test("accepts mode: compose with compose.config and string compose.expose entries", () => {
    const cfg = validateConfig({
      mode: "compose",
      compose: {
        config: "docker-compose.yaml",
        expose: ["api:3000"],
      },
    });
    expect(cfg.mode).toBe("compose");
    expect(cfg.compose).toEqual({
      config: "docker-compose.yaml",
      expose: [{ service: "api", port: 3000 }],
      envFile: [],
      environment: {},
    });
    expect(cfg.app.services).toEqual({});
    expect(cfg.deps).toEqual({});
  });

  test("accepts multiple ports for the same service via service:port strings", () => {
    const cfg = validateConfig({
      mode: "compose",
      compose: {
        config: "docker-compose.yaml",
        expose: ["api:3000", "api:4000"],
      },
    });
    expect(cfg.compose?.expose).toEqual([
      { service: "api", port: 3000 },
      { service: "api", port: 4000 },
    ]);
  });

  test("rejects compose.expose object entry with tunnel field", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: {
          config: "docker-compose.yaml",
          expose: [{ name: "api", port: 3000, tunnel: true }],
        },
      }),
    ).toThrow(/tunnel is no longer supported.*config\.json.*--no-tunnel/s);
  });

  test("accepts mode: compose with env_file (string) and environment", () => {
    const cfg = validateConfig({
      mode: "compose",
      compose: {
        config: "docker-compose.yaml",
        expose: ["api:3000", "worker:5000"],
        env_file: ".env.compose",
        environment: { TEST: "from-inline", PORT: 3000, FLAG: true },
      },
    });
    expect(cfg.compose?.envFile).toEqual([".env.compose"]);
    expect(cfg.compose?.environment).toEqual({
      TEST: "from-inline",
      PORT: "3000",
      FLAG: "true",
    });
  });

  test("accepts mode: compose with env_file as a list", () => {
    const cfg = validateConfig({
      mode: "compose",
      compose: {
        config: "docker-compose.yaml",
        expose: ["api:3000"],
        env_file: [".env.base", ".env.local"],
      },
    });
    expect(cfg.compose?.envFile).toEqual([".env.base", ".env.local"]);
  });

  test("accepts mode: compose with clone_volumes and cache", () => {
    const cfg = validateConfig({
      mode: "compose",
      clone_volumes: [".env.local"],
      cache: [{ key: "v1", paths: ["node_modules"] }],
      compose: {
        config: "docker-compose.yaml",
        expose: ["api:3000"],
      },
    });
    expect(cfg.cloneVolumes.map((v) => v.displayPath)).toEqual([".env.local"]);
    expect(cfg.cache[0]?.paths).toEqual(["node_modules"]);
  });

  test("accepts mode: compose with host_ports range", () => {
    const cfg = validateConfig({
      mode: "compose",
      host_ports: { range: { start: 30000, end: 30100 } },
      compose: {
        config: "docker-compose.yaml",
        expose: ["api:3000"],
      },
    });
    expect(cfg.hostPorts).toEqual({ start: 30000, end: 30100 });
  });

  test("rejects mode: compose without compose mapping", () => {
    expect(() => validateConfig({ mode: "compose" })).toThrow(
      /mode: compose.*requires.*compose/,
    );
  });

  test("rejects mode: compose without compose.config", () => {
    expect(() =>
      validateConfig({ mode: "compose", compose: { expose: ["api:3000"] } }),
    ).toThrow(/compose\.config/);
  });

  test("rejects mode: compose with empty compose.config", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "", expose: ["api:3000"] },
      }),
    ).toThrow(/compose\.config/);
  });

  test("rejects mode: compose without compose.expose", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml" },
      }),
    ).toThrow(/compose\.expose/);
  });

  test("rejects mode: compose with empty compose.expose list", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: [] },
      }),
    ).toThrow(/compose\.expose/);
  });

  test("rejects mode: compose with plain service-name expose entry", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: ["api"] },
      }),
    ).toThrow(/service:port/);
  });

  test("rejects mode: compose with non-string compose.expose entry", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: [123] },
      }),
    ).toThrow(/compose\.expose\[0\]/);
  });

  test("rejects mode: compose with out-of-range port in expose string", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: ["api:99999"] },
      }),
    ).toThrow(/compose\.expose\[0\].*1\.\.65535/);
  });

  test("rejects mode: compose with object expose entry missing port", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: {
          config: "docker-compose.yaml",
          expose: [{ name: "api" }],
        },
      }),
    ).toThrow(/compose\.expose\[0\]\.port/);
  });

  test("rejects mode: compose with object expose entry missing name", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: {
          config: "docker-compose.yaml",
          expose: [{ port: 3000 }],
        },
      }),
    ).toThrow(/compose\.expose\[0\]\.name/);
  });

  test("rejects mode: compose with app field present", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: ["api:3000"] },
        app: { image: "node:22" },
      }),
    ).toThrow(/"app".*generated-compose/);
  });

  test("rejects mode: compose with deps field present", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: ["api:3000"] },
        deps: { db: { image: "postgres:13" } },
      }),
    ).toThrow(/"deps".*generated-compose/);
  });

  test("rejects mode: compose with bad env_file shape", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: {
          config: "docker-compose.yaml",
          expose: ["api:3000"],
          env_file: [""],
        },
      }),
    ).toThrow(/compose\.env_file/);
  });

  test("rejects unknown mode value", () => {
    expect(() => validateConfig({ mode: "hybrid" })).toThrow(/mode must be/);
  });

  test("rejects removed volumes field", () => {
    expect(() => validateConfig({ volumes: [".data"] })).toThrow(ConfigError);
  });

  test("rejects removed init-script field", () => {
    expect(() => validateConfig({ "init-script": ["bun install"] })).toThrow(ConfigError);
  });

  test("rejects removed publish field", () => {
    expect(() => validateConfig({ publish: { app: [3000] } })).toThrow(ConfigError);
  });

  test("uses configured host_ports range", () => {
    const cfg = validateConfig({ host_ports: { range: { start: 30000, end: 31000 } } });
    expect(cfg.hostPorts).toEqual({ start: 30000, end: 31000 });
  });

  test("uses default range when host_ports.range is omitted", () => {
    const cfg = validateConfig({ host_ports: {} });
    expect(cfg.hostPorts).toEqual({ ...DEFAULT_HOST_PORT_RANGE });
  });

  test("rejects host_ports.range when start greater than end", () => {
    expect(() =>
      validateConfig({ host_ports: { range: { start: 31000, end: 30000 } } }),
    ).toThrow(/host_ports\.range\.start/);
  });

  test("defaults to empty cache when no cache field is set", () => {
    const cfg = validateConfig({ app: { image: "node:22" } });
    expect(cfg.cache).toEqual([]);
  });

  test("parses cache entry with key.files", () => {
    const cfg = validateConfig({
      cache: [
        { key: { files: ["yarn.lock", "packages/api/yarn.lock"] }, paths: ["node_modules"] },
      ],
    });
    expect(cfg.cache).toEqual([
      {
        key: { kind: "files", files: ["yarn.lock", "packages/api/yarn.lock"] },
        paths: ["node_modules"],
      },
    ]);
  });

  test("parses cache entry with explicit string key", () => {
    const cfg = validateConfig({
      cache: [{ key: "ruby-bundle-v1", paths: ["vendor/bundle"] }],
    });
    expect(cfg.cache).toEqual([
      { key: { kind: "literal", literal: "ruby-bundle-v1" }, paths: ["vendor/bundle"] },
    ]);
  });

  test("rejects cache that is not a list", () => {
    expect(() => validateConfig({ cache: { key: "x", paths: ["node_modules"] } })).toThrow(
      /cache must be a list/,
    );
  });

  test("rejects cache entry without key", () => {
    expect(() => validateConfig({ cache: [{ paths: ["node_modules"] }] })).toThrow(
      /cache\[0\]\.key is required/,
    );
  });

  test("rejects cache entry without paths", () => {
    expect(() => validateConfig({ cache: [{ key: "x" }] })).toThrow(
      /cache\[0\]\.paths is required/,
    );
  });

  test("rejects cache entry with empty paths list", () => {
    expect(() => validateConfig({ cache: [{ key: "x", paths: [] }] })).toThrow(
      /cache\[0\]\.paths must not be empty/,
    );
  });

  test("rejects cache entry with non-string path", () => {
    expect(() => validateConfig({ cache: [{ key: "x", paths: [123] }] })).toThrow(
      /cache\[0\]\.paths\[0\] must be a non-empty string/,
    );
  });

  test("rejects cache entry with empty string path", () => {
    expect(() => validateConfig({ cache: [{ key: "x", paths: [""] }] })).toThrow(
      /cache\[0\]\.paths\[0\] must be a non-empty string/,
    );
  });

  test("rejects cache entry with empty string key", () => {
    expect(() => validateConfig({ cache: [{ key: "", paths: ["node_modules"] }] })).toThrow(
      /cache\[0\]\.key must be a non-empty string/,
    );
  });

  test("rejects cache entry with empty files list", () => {
    expect(() =>
      validateConfig({ cache: [{ key: { files: [] }, paths: ["node_modules"] }] }),
    ).toThrow(/cache\[0\]\.key\.files must not be empty/);
  });

  test("rejects cache entry with key.files missing", () => {
    expect(() =>
      validateConfig({ cache: [{ key: {}, paths: ["node_modules"] }] }),
    ).toThrow(/cache\[0\]\.key\.files is required/);
  });

  test("rejects cache entry with absolute path", () => {
    expect(() =>
      validateConfig({ cache: [{ key: "x", paths: ["/etc/passwd"] }] }),
    ).toThrow(/must be a relative path/);
  });

  test("rejects cache entry with path that escapes the worktree", () => {
    expect(() =>
      validateConfig({ cache: [{ key: "x", paths: ["../escape"] }] }),
    ).toThrow(/must resolve strictly inside the worktree/);
  });

  test("rejects cache entry with absolute key file", () => {
    expect(() =>
      validateConfig({
        cache: [{ key: { files: ["/abs/yarn.lock"] }, paths: ["node_modules"] }],
      }),
    ).toThrow(/must be a relative path/);
  });

  test("rejects cache entry with key file that escapes the worktree", () => {
    expect(() =>
      validateConfig({
        cache: [{ key: { files: ["../yarn.lock"] }, paths: ["node_modules"] }],
      }),
    ).toThrow(/must resolve strictly inside the worktree/);
  });

  test("rejects cache entry that is not a mapping", () => {
    expect(() => validateConfig({ cache: ["yarn.lock"] })).toThrow(
      /cache\[0\] must be a mapping/,
    );
  });

  test("accepts wildcard cache paths", () => {
    const cfg = validateConfig({
      cache: [{ key: "v1", paths: ["packages/*/node_modules"] }],
    });
    expect(cfg.cache[0]!.paths).toEqual(["packages/*/node_modules"]);
  });

  test("rejects absolute wildcard cache paths", () => {
    expect(() =>
      validateConfig({ cache: [{ key: "v1", paths: ["/tmp/*/node_modules"] }] }),
    ).toThrow(/must be a relative path/);
  });

  test("rejects escaping wildcard cache paths", () => {
    expect(() =>
      validateConfig({ cache: [{ key: "v1", paths: ["../*/node_modules"] }] }),
    ).toThrow(/must resolve strictly inside the worktree/);
  });

  test("rejects renamed init_cache field with migration hint", () => {
    expect(() =>
      validateConfig({ init_cache: [{ key: "x", paths: ["node_modules"] }] }),
    ).toThrow(/init_cache.*renamed.*cache/);
  });

  test("rejects host_ports.range with out-of-range values", () => {
    expect(() =>
      validateConfig({ host_ports: { range: { start: 0, end: 100 } } }),
    ).toThrow(ConfigError);
    expect(() =>
      validateConfig({ host_ports: { range: { start: 100, end: 70000 } } }),
    ).toThrow(ConfigError);
  });

  test("parses app.services.<name>.cwd as optional string", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          api: { ports: [3000], script: ["bun dev"], cwd: "packages/api" },
          web: { ports: [4200], script: ["bun dev"] },
        },
      },
    });
    expect(cfg.app.services.api!.cwd).toBe("packages/api");
    expect(cfg.app.services.web!.cwd).toBeNull();
  });

  test("rejects app.services.<name>.cwd that is empty string", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: { ports: [3000], cwd: "" } } },
      }),
    ).toThrow(/app\.services\.api\.cwd must be a non-empty string/);
  });

  test("parses app.services environment with string/number/boolean coercion", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          api: {
            ports: [3000],
            script: ["bun dev"],
            environment: { NODE_ENV: "development", PORT: 3000, DEBUG: true },
          },
        },
      },
    });
    expect(cfg.app.services.api!.environment).toEqual({
      NODE_ENV: "development",
      PORT: "3000",
      DEBUG: "true",
    });
  });

  test("rejects app.services environment that is not a mapping", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { ports: [3000], environment: ["NODE_ENV=dev"] } },
        },
      }),
    ).toThrow(ConfigError);
  });

  test("parses app.services.<name>.volumes as string list", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          api: {
            ports: [3000],
            volumes: ["./.data/uploads:/workspace/uploads", "api-cache:/cache"],
          },
        },
      },
    });
    expect(cfg.app.services.api!.volumes).toEqual([
      "./.data/uploads:/workspace/uploads",
      "api-cache:/cache",
    ]);
  });

  test("defaults app.services.<name>.volumes to empty list when omitted", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: { api: { ports: [3000] } },
      },
    });
    expect(cfg.app.services.api!.volumes).toEqual([]);
  });

  test("rejects app.services.<name>.volumes that is not a list", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { volumes: "/data:/data" } },
        },
      }),
    ).toThrow(/app\.services\.api\.volumes must be a list/);
  });

  test("rejects app.services.<name>.volumes with empty string entry", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { volumes: [""] } },
        },
      }),
    ).toThrow(/app\.services\.api\.volumes\[0\] must be a non-empty string/);
  });

  test("rejects app.services.<name>.volumes with non-string entry", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { volumes: [123] } },
        },
      }),
    ).toThrow(/app\.services\.api\.volumes\[0\] must be a non-empty string/);
  });

  test("parses app.services.<name>.env_file as optional string", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          api: { ports: [3000], script: ["bun dev"], env_file: ".env" },
        },
      },
    });
    expect(cfg.app.services.api!.envFile).toBe(".env");
  });

  test("accepts absolute path for app.services.<name>.env_file", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          api: { ports: [3000], env_file: "/secrets/.env.api" },
        },
      },
    });
    expect(cfg.app.services.api!.envFile).toBe("/secrets/.env.api");
  });

  test("defaults app.services.<name>.env_file to null when omitted", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: { api: { ports: [3000] } },
      },
    });
    expect(cfg.app.services.api!.envFile).toBeNull();
  });

  test("rejects app.services.<name>.env_file that is empty string", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: { env_file: "" } } },
      }),
    ).toThrow(/app\.services\.api\.env_file must be a non-empty string/);
  });

  test("rejects app.services.<name>.env_file that is not a string", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: { env_file: 123 } } },
      }),
    ).toThrow(/app\.services\.api\.env_file must be a non-empty string/);
  });

  test("parses targets as non-empty string lists", () => {
    const cfg = validateConfig({
      app: { image: "node:22", services: { api: {}, app: {} } },
      targets: {
        app: ["app"],
        dev: ["app", "api"],
      },
    });
    expect(cfg.targets).toEqual({ app: ["app"], dev: ["app", "api"] });
  });

  test("rejects targets that is not a mapping", () => {
    expect(() =>
      validateConfig({ app: { image: "node:22", services: { api: {} } }, targets: ["app"] }),
    ).toThrow(/targets must be a mapping/);
  });

  test("rejects targets with empty entry list", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        targets: { app: [] },
      }),
    ).toThrow(/targets\.app must be a non-empty list/);
  });

  test("rejects targets entry that is not a string", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        targets: { app: [123] },
      }),
    ).toThrow(/targets\.app\[0\] must be a non-empty string/);
  });

  test("rejects targets referencing unknown service", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        targets: { app: ["nope"] },
      }),
    ).toThrow(/targets\.app\[0\] references unknown service "nope"/);
  });

  test("parses runtime arguments as a unique string list", () => {
    const cfg = validateConfig({
      app: { image: "node:22", services: { api: {} } },
      arguments: ["API_URL", "FEATURE_FLAG"],
    });
    expect(cfg.arguments).toEqual(["API_URL", "FEATURE_FLAG"]);
  });

  test("runtime arguments default to empty list when omitted", () => {
    const cfg = validateConfig({
      app: { image: "node:22", services: { api: {} } },
    });
    expect(cfg.arguments).toEqual([]);
  });

  test("rejects runtime arguments that is not a list", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        arguments: "API_URL",
      }),
    ).toThrow(/arguments must be a list/);
  });

  test("rejects empty string runtime argument entry", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        arguments: [""],
      }),
    ).toThrow(/arguments\[0\] must be a non-empty string/);
  });

  test("rejects runtime argument with invalid identifier", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        arguments: ["bad-name"],
      }),
    ).toThrow(/arguments\[0\].*identifier/);
  });

  test("rejects duplicate runtime argument names", () => {
    expect(() =>
      validateConfig({
        app: { image: "node:22", services: { api: {} } },
        arguments: ["API_URL", "API_URL"],
      }),
    ).toThrow(/arguments\[1\] duplicates runtime argument "API_URL"/);
  });

  test("rejects runtime arguments in compose mode", () => {
    expect(() =>
      validateConfig({
        mode: "compose",
        compose: { config: "docker-compose.yaml", expose: ["api:3000"] },
        arguments: ["API_URL"],
      }),
    ).toThrow(/"arguments".*generated-compose/);
  });

  test("accepts service dependencies referencing app and deps", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: {
          app: { dependencies: ["api"] },
          api: { dependencies: ["db"] },
        },
      },
      deps: { db: { image: "postgres:13" } },
    });
    expect(cfg.app.services.app!.dependencies).toEqual(["api"]);
    expect(cfg.app.services.api!.dependencies).toEqual(["db"]);
  });

  test("rejects service dependency referencing unknown service", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { dependencies: ["nope"] } },
        },
      }),
    ).toThrow(/app\.services\.api\.dependencies\[0\] references unknown service "nope"/);
  });

  test("rejects service depending on itself", () => {
    expect(() =>
      validateConfig({
        app: {
          image: "node:22",
          services: { api: { dependencies: ["api"] } },
        },
      }),
    ).toThrow(/cannot reference itself/);
  });

  test("parses app.services.<name>.init_script", () => {
    const cfg = validateConfig({
      app: {
        image: "node:22",
        services: { api: { init_script: ["bun install"] } },
      },
    });
    expect(cfg.app.services.api!.initScript).toEqual(["bun install"]);
  });

  test("rejects service init_script without app.image", () => {
    expect(() =>
      validateConfig({
        app: {
          services: { api: { image: "node:22", init_script: ["bun install"] } },
        },
      }),
    ).toThrow(/app\.image is required when app\.services\.api\.init_script/);
  });
});

describe("loadConfig", () => {
  const GENERATED_YAML = `clone_volumes:\n  - .data\napp:\n  image: node:22\n  services:\n    api:\n      ports:\n        - 3000\n      script:\n        - bun dev\n`;

  test("loads .wos/deploy.yaml for the source worktree", async () => {
    const dir = await makeTmp();
    try {
      await Bun.write(resolve(dir, ".wos", "deploy.yaml"), GENERATED_YAML);
      // current worktree === source worktree → root deploy config
      const cfg = await loadConfig(dir, dir);
      expect(cfg.cloneVolumes).toEqual([cloneVolume(".data")]);
      expect(cfg.app.image).toBe("node:22");
      expect(cfg.app.services.api).toEqual({
        image: null,
        ports: [appPortFromNumber(3000)],
        script: ["bun dev"],
        cwd: null,
        envFile: null,
        environment: {},
        volumes: [],
        initScript: [],
        dependencies: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads .wos/deploy.worktree.yaml for a secondary worktree", async () => {
    const source = await makeTmp();
    const current = await makeTmp();
    try {
      await Bun.write(
        resolve(source, ".wos", "deploy.worktree.yaml"),
        GENERATED_YAML,
      );
      // current worktree !== source worktree → worktree deploy config
      const cfg = await loadConfig(source, current);
      expect(cfg.app.image).toBe("node:22");
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(current, { recursive: true, force: true });
    }
  });

  test("ignores .wos/deploy.worktree.yaml when resolving the source worktree", async () => {
    const dir = await makeTmp();
    try {
      await Bun.write(
        resolve(dir, ".wos", "deploy.worktree.yaml"),
        GENERATED_YAML,
      );
      await expect(loadConfig(dir, dir)).rejects.toThrow(
        /deploy config not found.*deploy\.yaml/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails with actionable error naming deploy.yaml when source config missing", async () => {
    const dir = await makeTmp();
    try {
      await expect(loadConfig(dir, dir)).rejects.toThrow(
        /deploy config not found.*\.wos.*deploy\.yaml/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails with actionable error naming deploy.worktree.yaml when secondary config missing", async () => {
    const source = await makeTmp();
    const current = await makeTmp();
    try {
      await expect(loadConfig(source, current)).rejects.toThrow(
        /deploy config not found.*deploy\.worktree\.yaml/,
      );
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(current, { recursive: true, force: true });
    }
  });

  test("fails with actionable error on invalid YAML", async () => {
    const dir = await makeTmp();
    try {
      await Bun.write(resolve(dir, ".wos", "deploy.yaml"), "app: [unclosed\n");
      await expect(loadConfig(dir, dir)).rejects.toThrow(/failed to parse/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dynamic_ports defaults to true and parses false", async () => {
    const dir = await makeTmp();
    try {
      await Bun.write(resolve(dir, ".wos", "deploy.yaml"), GENERATED_YAML);
      const dyn = await loadConfig(dir, dir);
      expect(dyn.dynamicPorts).toBe(true);
      await Bun.write(
        resolve(dir, ".wos", "deploy.yaml"),
        `dynamic_ports: false\n${GENERATED_YAML}`,
      );
      const stat = await loadConfig(dir, dir);
      expect(stat.dynamicPorts).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("source uses shell static config; secondary uses Docker dynamic config (same repo)", async () => {
    const source = await makeTmp();
    const secondary = await makeTmp();
    try {
      // Root/source worktree: host shell processes on fixed ports.
      await Bun.write(
        resolve(source, ".wos", "deploy.yaml"),
        `mode: shell\ndynamic_ports: false\napp:\n  services:\n    web:\n      ports:\n        - 3000\n      script:\n        - bun dev\n`,
      );
      // Secondary worktrees: Docker with generated (dynamic) ports.
      await Bun.write(
        resolve(source, ".wos", "deploy.worktree.yaml"),
        `app:\n  image: node:22\n  services:\n    api:\n      ports:\n        - 3000\n      script:\n        - bun dev\n`,
      );

      const rootCfg = await loadConfig(source, source);
      expect(rootCfg.mode).toBe("shell");
      expect(rootCfg.dynamicPorts).toBe(false);

      const worktreeCfg = await loadConfig(source, secondary);
      expect(worktreeCfg.mode).toBe("generated");
      expect(worktreeCfg.dynamicPorts).toBe(true);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(secondary, { recursive: true, force: true });
    }
  });
});
