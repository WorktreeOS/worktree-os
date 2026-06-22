import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  INIT_SERVICE_NAME,
  INTERNAL_PROFILE,
  TemplateError,
  buildGeneratedCompose,
  generatedComposePath,
  resolveVolumeHost,
  serializeGeneratedCompose,
  serviceContainerName,
  writeGeneratedCompose,
} from "@worktreeos/compose/generated-compose";
import { sessionComposePath } from "@worktreeos/core/paths";
import {
  appPortFromNumber,
  cloneVolume,
  DEFAULT_HOST_PORT_RANGE,
  type WosConfig,
} from "@worktreeos/core/config";
import type { PortAssignments } from "@worktreeos/core/state";
import {
  WOS_LABEL_MANAGED,
  WOS_LABEL_SCHEMA,
  WOS_LABEL_HOME_HASH,
  WOS_LABEL_SESSION,
  WOS_LABEL_PROJECT,
  WOS_LABEL_MODE,
  WOS_LABEL_SERVICE,
  WOS_LABEL_DEPLOYMENT_ID,
  WOS_LABEL_TUNNEL_PORTS,
  WOS_ENV_HOSTNAME,
  stableWosHomeHash,
  tunnelEnvHostnameKey,
  tunnelHostnameLabelKey,
  tunnelHostPortLabelKey,
} from "@worktreeos/core/tunnel-metadata";
import { sessionNameForWorktree } from "@worktreeos/core/paths";

// Tests that assert POSIX-resolved host paths from a POSIX worktree root
// (`/repo/wt`). `resolve()` drive-prefixes those on Windows, so the strings
// legitimately differ there — the Windows host-path behavior is covered by the
// drive-letter `resolveVolumeHost` cases below.
const posixOnly = process.platform === "win32" ? test.skip : test;

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;
afterEach(() => {
  if (ORIGINAL_WOS_HOME === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = ORIGINAL_WOS_HOME;
});

const PROJECT = "wos-repo-abcd1234";

function exampleConfig(): WosConfig {
  return {
    cloneVolumes: [cloneVolume(".data")],
    app: {
      image: "node:22",
      initScript: ["bun install"],
      services: {
        api: {
          image: null,
          ports: [appPortFromNumber(3000)],
          script: ["bun dev"],
          cwd: null,
          envFile: null,
          environment: {
            NODE_ENV: "development",
            DATABASE_URL: "postgres://postgres:111111@${deps.db.containerName}:5432/api",
            DB_HOST_PORT: "${deps.db.hostPort[5432]}",
            SELF_HOST: "${app.services.api.containerName}:${app.services.api.hostPort[3000]}",
          },
          volumes: [],
        },
        web: {
          image: null,
          ports: [appPortFromNumber(4200), appPortFromNumber(4210)],
          script: ["bun install", "bun dev"],
          cwd: null,
          envFile: null,
          environment: {},
          volumes: [],
        },
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
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    cache: [],
  };
}

function identityLabels(
  serviceName: string,
  opts?: { deploymentId?: string },
): Record<string, string> {
  const labels: Record<string, string> = {
    "dev.wos.managed": "true",
    "dev.wos.schema": "1",
    "dev.wos.home-hash": stableWosHomeHash(),
    "dev.wos.session": sessionNameForWorktree("/repo/wt"),
    "dev.wos.project": PROJECT,
    "dev.wos.mode": "generated",
    "dev.wos.service": serviceName,
  };
  if (opts?.deploymentId) labels["dev.wos.deployment-id"] = opts.deploymentId;
  return labels;
}

function exampleAssignments(): PortAssignments {
  return {
    api: { "3000": 21001 },
    web: { "4200": 21002, "4210": 21003 },
    db: { "5432": 21004 },
  };
}

describe("buildGeneratedCompose", () => {
  test("creates app services with container_name, host:container ports and resolved templates", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api).toEqual({
      image: "node:22",
      container_name: `${PROJECT}-api`,
      working_dir: "/workspace",
      volumes: ["/repo/wt:/workspace"],
      command: ["sh", "-c", "bun dev"],
      ports: ["21001:3000"],
      environment: {
        DATABASE_URL: `postgres://postgres:111111@${PROJECT}-db:5432/api`,
        DB_HOST_PORT: "21004",
        NODE_ENV: "development",
        SELF_HOST: `${PROJECT}-api:21001`,
        WOS_SERVICE_PORT: "21001",
        WOS_SERVICE_HOSTNAME: "localhost",
      },
      labels: identityLabels("api"),
    });
    expect(compose.services.web).toEqual({
      image: "node:22",
      container_name: `${PROJECT}-web`,
      working_dir: "/workspace",
      volumes: ["/repo/wt:/workspace"],
      command: ["sh", "-c", "bun install && bun dev"],
      ports: ["21002:4200", "21003:4210"],
      environment: {
        WOS_SERVICE_PORT: "21002",
        WOS_SERVICE_HOSTNAME: "localhost",
      },
      labels: identityLabels("web"),
    });
  });

  test("publishes a bare single mapping when serviceBind is unset", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.ports).toEqual(["21001:3000"]);
    expect(compose.services.web!.ports).toEqual(["21002:4200", "21003:4210"]);
  });

  test("publishes loopback and serviceBind mappings when serviceBind is set", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      serviceBind: "192.168.1.18",
    });
    expect(compose.services.api!.ports).toEqual([
      "127.0.0.1:21001:3000",
      "192.168.1.18:21001:3000",
    ]);
    expect(compose.services.web!.ports).toEqual([
      "127.0.0.1:21002:4200",
      "192.168.1.18:21002:4200",
      "127.0.0.1:21003:4210",
      "192.168.1.18:21003:4210",
    ]);
  });

  test("collapses to a single mapping when serviceBind is loopback", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      serviceBind: "127.0.0.1",
    });
    expect(compose.services.api!.ports).toEqual(["127.0.0.1:21001:3000"]);
  });

  test("brackets an IPv6 serviceBind in the published mapping", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      serviceBind: "fd00::1",
    });
    expect(compose.services.api!.ports).toEqual([
      "127.0.0.1:21001:3000",
      "[fd00::1]:21001:3000",
    ]);
  });

  posixOnly("creates dep services with container_name, explicit host port and resolved env", () => {
    const cfg = exampleConfig();
    cfg.deps.db!.environment = {
      POSTGRES_USER: "postgres",
      SELF_API: "http://${app.services.api.containerName}:${app.services.api.hostPort[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.db).toEqual({
      image: "postgres:13",
      container_name: `${PROJECT}-db`,
      ports: ["21004:5432"],
      environment: {
        POSTGRES_USER: "postgres",
        SELF_API: `http://${PROJECT}-api:21001`,
      },
      volumes: ["/repo/wt/.data/postgres:/var/lib/postgresql/data"],
      labels: identityLabels("db"),
    });
  });

  test("emits internal init service with container_name based on project and init service name", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services[INIT_SERVICE_NAME]).toEqual({
      image: "node:22",
      container_name: serviceContainerName(PROJECT, INIT_SERVICE_NAME),
      working_dir: "/workspace",
      volumes: ["/repo/wt:/workspace"],
      profiles: [INTERNAL_PROFILE],
    });
  });

  test("mounts connected package-manager caches into the internal init service", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      packageManagerCaches: [
        {
          kind: "npm",
          hostPath: "/host/npm-cache",
          containerPath: "/wos-cache/npm",
          envName: "NPM_CONFIG_CACHE",
        },
        {
          kind: "bun",
          hostPath: "/host/bun-cache",
          containerPath: "/wos-cache/bun",
          envName: "BUN_INSTALL_CACHE_DIR",
        },
      ],
    });
    expect(compose.services[INIT_SERVICE_NAME]).toEqual({
      image: "node:22",
      container_name: serviceContainerName(PROJECT, INIT_SERVICE_NAME),
      working_dir: "/workspace",
      volumes: [
        "/repo/wt:/workspace",
        "/host/npm-cache:/wos-cache/npm",
        "/host/bun-cache:/wos-cache/bun",
      ],
      profiles: [INTERNAL_PROFILE],
      environment: {
        BUN_INSTALL_CACHE_DIR: "/wos-cache/bun",
        NPM_CONFIG_CACHE: "/wos-cache/npm",
      },
    });
  });

  test("uses app.image for app services that inherit it", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.image).toBe("node:22");
    expect(compose.services.web!.image).toBe("node:22");
  });

  test("overrides app.image with per-service image when configured", () => {
    const cfg = exampleConfig();
    cfg.app.services.web!.image = "nginx:1.27";
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.image).toBe("node:22");
    expect(compose.services.web!.image).toBe("nginx:1.27");
  });

  test("generates compose when every service has its own image and app.image is absent", () => {
    const cfg: WosConfig = {
      cloneVolumes: [],
      app: {
        image: null,
        initScript: [],
        services: {
          api: { image: "node:22", ports: [appPortFromNumber(3000)], script: ["bun dev"], cwd: null, envFile: null, environment: {}, volumes: [] },
          worker: { image: "python:3.12", ports: [], script: ["python worker.py"], cwd: null, envFile: null, environment: {}, volumes: [] },
        },
      },
      deps: {},
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: { api: { "3000": 21001 } },
    });
    expect(compose.services.api!.image).toBe("node:22");
    expect(compose.services.worker!.image).toBe("python:3.12");
    expect(compose.services[INIT_SERVICE_NAME]).toBeUndefined();
  });

  test("omits internal init service when app.init_script is empty", () => {
    const cfg = exampleConfig();
    cfg.app.initScript = [];
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services[INIT_SERVICE_NAME]).toBeUndefined();
  });

  test("uses default working_dir /workspace when cwd is null", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.working_dir).toBe("/workspace");
  });

  test("resolves relative cwd inside /workspace", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.cwd = "packages/api";
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.working_dir).toBe("/workspace/packages/api");
  });

  test("uses absolute cwd as-is", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.cwd = "/app";
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.working_dir).toBe("/app");
  });

  test("preserves absolute and named-volume hosts unchanged", () => {
    const cfg: WosConfig = {
      cloneVolumes: [],
      app: { image: null, initScript: [], services: {} },
      deps: {
        a: { image: "redis:7", ports: [], environment: {}, volumes: ["/abs/path:/data"] },
        b: { image: "redis:7", ports: [], environment: {}, volumes: ["named-volume:/data"] },
      },
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: {},
    });
    expect(compose.services.a!.volumes).toEqual(["/abs/path:/data"]);
    expect(compose.services.b!.volumes).toEqual(["named-volume:/data"]);
  });

  test("rejects template referencing unknown service", () => {
    const cfg: WosConfig = {
      cloneVolumes: [],
      app: { image: null, initScript: [], services: {} },
      deps: {
        a: {
          image: "redis:7",
          ports: [],
          environment: { LINK: "${deps.unknown.containerName}" },
          volumes: [],
        },
      },
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    };
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: {},
      }),
    ).toThrow(TemplateError);
  });

  test("rejects template referencing unconfigured container port", () => {
    const cfg: WosConfig = {
      cloneVolumes: [],
      app: { image: null, initScript: [], services: {} },
      deps: {
        a: {
          image: "redis:7",
          ports: [6379],
          environment: { LINK: "${deps.a.hostPort[1234]}" },
          volumes: [],
        },
      },
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    };
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: { a: { "6379": 21000 } },
      }),
    ).toThrow(TemplateError);
  });

  posixOnly("includes configured app service volumes after the worktree mount", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.volumes = ["./.data/uploads:/workspace/uploads", "api-cache:/cache"];
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.volumes).toEqual([
      "/repo/wt:/workspace",
      "/repo/wt/.data/uploads:/workspace/uploads",
      "api-cache:/cache",
    ]);
  });

  posixOnly("resolves relative host paths in app service volumes against worktree", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.volumes = ["./cache:/tmp/cache"];
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.volumes).toEqual([
      "/repo/wt:/workspace",
      "/repo/wt/cache:/tmp/cache",
    ]);
  });

  test("preserves absolute and named-volume hosts in app service volumes", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.volumes = ["/abs/path:/data", "named-vol:/cache"];
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.volumes).toEqual([
      "/repo/wt:/workspace",
      "/abs/path:/data",
      "named-vol:/cache",
    ]);
  });

  test("app service without volumes only has the worktree mount", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.volumes).toEqual(["/repo/wt:/workspace"]);
    expect(compose.services.web!.volumes).toEqual(["/repo/wt:/workspace"]);
  });

  posixOnly("resolves relative env_file path against worktree", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.envFile = ".env";
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.env_file).toBe("/repo/wt/.env");
  });

  test("preserves absolute env_file path unchanged", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.envFile = "/secrets/.env.api";
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.env_file).toBe("/secrets/.env.api");
  });

  test("omits env_file when envFile is null", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.env_file).toBeUndefined();
  });

  posixOnly("emits both env_file and environment when both configured", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.envFile = ".env";
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.env_file).toBe("/repo/wt/.env");
    expect(compose.services.api!.environment).toBeDefined();
    expect(Object.keys(compose.services.api!.environment!).length).toBeGreaterThan(0);
  });

  test("resolves hostname template to active tunnel hostname", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      PUBLIC_HOST: "${app.services.api.hostname[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      tunnelHostnames: { api: { "3000": "preview-api.loca.lt" } },
    });
    expect(compose.services.api!.environment!.PUBLIC_HOST).toBe("preview-api.loca.lt");
  });

  test("resolves hostname template to localhost when no tunnel is open", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      PUBLIC_HOST: "${app.services.api.hostname[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.environment!.PUBLIC_HOST).toBe("localhost");
  });

  test("hostname template falls back to localhost when tunnel is missing for that port", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      PUBLIC_HOST: "${app.services.api.hostname[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      tunnelHostnames: { api: {} },
    });
    expect(compose.services.api!.environment!.PUBLIC_HOST).toBe("localhost");
  });

  test("resolves url template to active tunnel url", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      PUBLIC_URL: "${app.services.api.url[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      tunnelUrls: { api: { "3000": "https://preview-api.loca.lt" } },
    });
    expect(compose.services.api!.environment!.PUBLIC_URL).toBe(
      "https://preview-api.loca.lt",
    );
  });

  test("resolves url template to http://localhost:<hostPort> when no tunnel is open", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      PUBLIC_URL: "${app.services.api.url[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.environment!.PUBLIC_URL).toBe(
      "http://localhost:21001",
    );
  });

  test("url template falls back to localhost when tunnel is missing for that port", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      PUBLIC_URL: "${app.services.api.url[3000]}",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      tunnelUrls: { api: {} },
    });
    expect(compose.services.api!.environment!.PUBLIC_URL).toBe(
      "http://localhost:21001",
    );
  });

  test("rejects url template for unconfigured app port", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      BAD: "${app.services.api.url[9999]}",
    };
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
      }),
    ).toThrow(TemplateError);
  });

  test("rejects hostname template for unconfigured app port", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      BAD: "${app.services.api.hostname[9999]}",
    };
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
      }),
    ).toThrow(TemplateError);
  });

  test("rejects hostname template referencing dep service", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      BAD: "${deps.db.hostname[5432]}",
    };
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
      }),
    ).toThrow(TemplateError);
  });

  test("rejects malformed template expressions", () => {
    const cfg: WosConfig = {
      cloneVolumes: [],
      app: { image: null, initScript: [], services: {} },
      deps: {
        a: {
          image: "redis:7",
          ports: [],
          environment: { LINK: "${something.weird}" },
          volumes: [],
        },
      },
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
    };
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: {},
      }),
    ).toThrow(TemplateError);
  });

  test("selective build emits only selected services and depends_on", () => {
    const cfg = simpleSelectiveConfig();
    cfg.app.services.app!.dependencies = ["api"];
    cfg.app.services.api!.dependencies = ["db"];
    const selected = new Set(["app", "api", "db"]);
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: { app: { "3000": 21001 }, api: { "3001": 21002 }, db: { "5432": 21004 } },
      selectedServices: selected,
    });
    expect(Object.keys(compose.services).sort()).toEqual([
      "api",
      "app",
      "db",
    ]);
    expect(compose.services.app!.depends_on).toEqual(["api"]);
    expect(compose.services.api!.depends_on).toEqual(["db"]);
  });

  test("selective build omits unselected services", () => {
    const cfg = simpleSelectiveConfig();
    const selected = new Set(["api", "db"]);
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: { api: { "3001": 21002 }, db: { "5432": 21004 } },
      selectedServices: selected,
    });
    expect(compose.services.app).toBeUndefined();
    expect(compose.services.api).toBeDefined();
    expect(compose.services.db).toBeDefined();
  });

  test("selective build drops depends_on entries that are unselected", () => {
    const cfg = simpleSelectiveConfig();
    cfg.app.services.app!.dependencies = ["api"];
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: { app: { "3000": 21001 } },
      selectedServices: new Set(["app"]),
    });
    expect(compose.services.app!.depends_on).toBeUndefined();
  });
});

function simpleSelectiveConfig(): WosConfig {
  return {
    cloneVolumes: [],
    app: {
      image: "node:22",
      initScript: [],
      services: {
        app: {
          image: null,
          ports: [appPortFromNumber(3000)],
          script: ["bun dev"],
          cwd: null,
          envFile: null,
          environment: {},
          volumes: [],
        },
        api: {
          image: null,
          ports: [appPortFromNumber(3001)],
          script: ["bun dev"],
          cwd: null,
          envFile: null,
          environment: {},
          volumes: [],
        },
      },
    },
    deps: {
      db: { image: "postgres:13", ports: [5432], environment: {}, volumes: [] },
    },
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    cache: [],
  };
}

describe("runtime arguments", () => {
  function argsConfig(env: Record<string, string>, args: string[]): WosConfig {
    return {
      mode: "generated",
      cloneVolumes: [],
      app: {
        image: "node:22",
        initScript: [],
        services: {
          api: {
            image: null,
            ports: [appPortFromNumber(3000)],
            script: ["bun dev"],
            cwd: null,
            envFile: null,
            environment: env,
            volumes: [],
            initScript: [],
            dependencies: [],
          },
        },
      },
      deps: {
        db: { image: "postgres:13", ports: [5432], environment: {}, volumes: [] },
      },
      hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
      cache: [],
      targets: {},
      arguments: args,
    };
  }
  const assigns: PortAssignments = { api: { "3000": 21000 }, db: { "5432": 21001 } };

  test("resolves declared runtime argument from submitted value", () => {
    const cfg = argsConfig({ EMPL_API_URL: "${API_URL}" }, ["API_URL"]);
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: assigns,
      runtimeArguments: { API_URL: "https://empl-stage.test-wa.ru" },
    });
    expect(compose.services.api!.environment).toEqual({
      EMPL_API_URL: "https://empl-stage.test-wa.ru",
      WOS_SERVICE_PORT: "21000",
      WOS_SERVICE_HOSTNAME: "localhost",
    });
  });

  test("uses default value when submitted runtime argument is missing", () => {
    const cfg = argsConfig(
      { EMPL_API_URL: "${API_URL:-https://empl-dev.test-wa.ru}" },
      ["API_URL"],
    );
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: assigns,
    });
    expect(compose.services.api!.environment).toEqual({
      EMPL_API_URL: "https://empl-dev.test-wa.ru",
      WOS_SERVICE_PORT: "21000",
      WOS_SERVICE_HOSTNAME: "localhost",
    });
  });

  test("uses default value when submitted runtime argument is empty string", () => {
    const cfg = argsConfig(
      { EMPL_API_URL: "${API_URL:-https://empl-dev.test-wa.ru}" },
      ["API_URL"],
    );
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: assigns,
      runtimeArguments: { API_URL: "" },
    });
    expect(compose.services.api!.environment).toEqual({
      EMPL_API_URL: "https://empl-dev.test-wa.ru",
      WOS_SERVICE_PORT: "21000",
      WOS_SERVICE_HOSTNAME: "localhost",
    });
  });

  test("preserves surrounding text around runtime argument expression", () => {
    const cfg = argsConfig(
      { EMPL_API_URL: "prefix-${API_URL:-default}-suffix" },
      ["API_URL"],
    );
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: assigns,
      runtimeArguments: { API_URL: "value" },
    });
    expect(compose.services.api!.environment).toEqual({
      EMPL_API_URL: "prefix-value-suffix",
      WOS_SERVICE_PORT: "21000",
      WOS_SERVICE_HOSTNAME: "localhost",
    });
  });

  test("resolves runtime argument template alongside wos template", () => {
    const cfg = argsConfig(
      {
        EMPL_API_URL: "${API_URL:-https://empl-dev.test-wa.ru}",
        DATABASE_URL: "postgres://${deps.db.containerName}:5432/api",
      },
      ["API_URL"],
    );
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: assigns,
    });
    expect(compose.services.api!.environment).toEqual({
      DATABASE_URL: `postgres://${PROJECT}-db:5432/api`,
      EMPL_API_URL: "https://empl-dev.test-wa.ru",
      WOS_SERVICE_PORT: "21000",
      WOS_SERVICE_HOSTNAME: "localhost",
    });
  });

  test("rejects template referencing undeclared runtime argument", () => {
    const cfg = argsConfig({ EMPL_API_URL: "${API_URL:-default}" }, []);
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: assigns,
      }),
    ).toThrow(/undeclared runtime argument "API_URL"/);
  });

  test("rejects required template when no value is provided", () => {
    const cfg = argsConfig({ EMPL_API_URL: "${API_URL}" }, ["API_URL"]);
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: assigns,
      }),
    ).toThrow(/requires runtime argument "API_URL"/);
  });

  test("rejects required template when submitted value is empty", () => {
    const cfg = argsConfig({ EMPL_API_URL: "${API_URL}" }, ["API_URL"]);
    expect(() =>
      buildGeneratedCompose({
        config: cfg,
        worktreeRoot: "/repo/wt",
        projectName: PROJECT,
        portAssignments: assigns,
        runtimeArguments: { API_URL: "" },
      }),
    ).toThrow(/requires runtime argument "API_URL"/);
  });
});

describe("resolveVolumeHost", () => {
  posixOnly("resolves relative host paths against the worktree root", () => {
    expect(resolveVolumeHost("./.data/pg:/var/lib/pg", "/repo/wt")).toBe(
      "/repo/wt/.data/pg:/var/lib/pg",
    );
  });

  test("leaves absolute POSIX hosts and named volumes unchanged", () => {
    expect(resolveVolumeHost("/abs/path:/data", "/repo/wt")).toBe("/abs/path:/data");
    expect(resolveVolumeHost("named-volume:/data", "/repo/wt")).toBe("named-volume:/data");
  });

  test("does not split a Windows host path at the drive-letter colon", () => {
    expect(resolveVolumeHost("C:\\cache:/cache", "/repo/wt")).toBe("C:\\cache:/cache");
    expect(resolveVolumeHost("C:/cache:/cache", "/repo/wt")).toBe("C:/cache:/cache");
  });

  test("treats a bare Windows path as a single-path volume", () => {
    expect(resolveVolumeHost("C:\\cache", "/repo/wt")).toBe("C:\\cache");
  });
});

describe("serializeGeneratedCompose", () => {
  test("is deterministic and emits host:container port strings", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    const a = serializeGeneratedCompose(compose);
    const b = serializeGeneratedCompose(compose);
    expect(a).toBe(b);
    expect(a).toContain('"21001:3000"');
    expect(a).toContain('"21004:5432"');
    expect(a).toContain(`"${PROJECT}-api"`);
    expect(a).toContain(`"${PROJECT}-db"`);
    expect(a.startsWith("services:")).toBe(true);
  });

  test("orders services and environment keys alphabetically", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    const out = serializeGeneratedCompose(compose);
    const apiIdx = out.indexOf("\n  api:");
    const dbIdx = out.indexOf("\n  db:");
    const initIdx = out.indexOf(`\n  ${INIT_SERVICE_NAME}:`);
    const webIdx = out.indexOf("\n  web:");
    expect(apiIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(apiIdx);
    expect(webIdx).toBeGreaterThan(dbIdx);
    expect(initIdx).toBeGreaterThan(webIdx);
  });
});

describe("writeGeneratedCompose", () => {
  test("writes compose under the worktree's wos session directory", async () => {
    const worktree = await mkdtemp(resolve(tmpdir(), "wos-gen-wt-"));
    const wosHome = await mkdtemp(resolve(tmpdir(), "wos-gen-home-"));
    process.env.WOS_HOME = wosHome;
    try {
      const path = await writeGeneratedCompose({
        config: exampleConfig(),
        worktreeRoot: worktree,
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
      });
      expect(path).toBe(generatedComposePath(worktree));
      expect(path).toBe(sessionComposePath(worktree));
      const text = await Bun.file(path).text();
      expect(text).toContain("services:");
      expect(text).toContain('"node:22"');
      expect(text).toContain('"postgres:13"');
      expect(text).toContain('"21001:3000"');
      expect(text).toContain(`"${PROJECT}-api"`);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(wosHome, { recursive: true, force: true });
    }
  });
});

describe("tunnel restore labels", () => {
  const WORKTREE = "/repo/wt";
  const DEPLOYMENT_ID = "deploy-abc-123";

  function tunnelHostnames(): Record<string, Record<string, string>> {
    return {
      api: { "3000": "feature-api.example.com" },
    };
  }

  test("generated compose includes restore labels for tunneled app port", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const compose = buildGeneratedCompose({
        config: exampleConfig(),
        worktreeRoot: WORKTREE,
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
        tunnelHostnames: tunnelHostnames(),
        deploymentId: DEPLOYMENT_ID,
      });

      const api = compose.services.api!;
      expect(api.labels).toBeDefined();
      const labels = api.labels!;
      expect(labels[WOS_LABEL_MANAGED]).toBe("true");
      expect(labels[WOS_LABEL_SCHEMA]).toBe("1");
      expect(labels[WOS_LABEL_HOME_HASH]).toBe(stableWosHomeHash());
      expect(labels[WOS_LABEL_SESSION]).toBe(sessionNameForWorktree(WORKTREE));
      expect(labels[WOS_LABEL_PROJECT]).toBe(PROJECT);
      expect(labels[WOS_LABEL_MODE]).toBe("generated");
      expect(labels[WOS_LABEL_SERVICE]).toBe("api");
      expect(labels[WOS_LABEL_DEPLOYMENT_ID]).toBe(DEPLOYMENT_ID);
      expect(labels[WOS_LABEL_TUNNEL_PORTS]).toBe("3000");
      expect(labels[tunnelHostnameLabelKey(3000)]).toBe("feature-api.example.com");
      expect(labels[tunnelHostPortLabelKey(3000)]).toBe("21001");
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("hostname environment is exposed for single-port service", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const compose = buildGeneratedCompose({
        config: exampleConfig(),
        worktreeRoot: WORKTREE,
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
        tunnelHostnames: tunnelHostnames(),
        deploymentId: DEPLOYMENT_ID,
      });

      const api = compose.services.api!;
      expect(api.environment).toBeDefined();
      expect(api.environment![WOS_ENV_HOSTNAME]).toBe("feature-api.example.com");
      expect(api.environment![tunnelEnvHostnameKey(3000)]).toBe("feature-api.example.com");
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("hostname environment is port-specific for multi-port service", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const hostnames: Record<string, Record<string, string>> = {
        web: { "4200": "web-4200.example.com", "4210": "web-4210.example.com" },
      };
      const compose = buildGeneratedCompose({
        config: exampleConfig(),
        worktreeRoot: WORKTREE,
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
        tunnelHostnames: hostnames,
        deploymentId: DEPLOYMENT_ID,
      });

      const web = compose.services.web!;
      expect(web.environment![tunnelEnvHostnameKey(4200)]).toBe("web-4200.example.com");
      expect(web.environment![tunnelEnvHostnameKey(4210)]).toBe("web-4210.example.com");
      // The first-port convenience pair describes the first configured port
      // (4200); secondary ports remain addressable via per-port keys.
      expect(web.environment![WOS_ENV_HOSTNAME]).toBe("web-4200.example.com");
      expect(web.environment!["WOS_SERVICE_PORT"]).toBe("21002");

      expect(web.labels![WOS_LABEL_TUNNEL_PORTS]).toBe("4200,4210");
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("services without active tunnel hostnames omit tunnel metadata", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const compose = buildGeneratedCompose({
        config: exampleConfig(),
        worktreeRoot: WORKTREE,
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
        tunnelHostnames: {},
        deploymentId: DEPLOYMENT_ID,
      });

      const api = compose.services.api!;
      // Identity labels are always present; only tunnel-specific labels are omitted.
      expect(api.labels).toBeDefined();
      expect(api.labels![WOS_LABEL_TUNNEL_PORTS]).toBeUndefined();
      expect(api.labels![tunnelHostnameLabelKey(4200)]).toBeUndefined();
      expect(api.environment).toBeDefined();
      // User env should still be present
      expect(api.environment!["NODE_ENV"]).toBeDefined();
      // Per-port tunnel env vars must not appear without active hostnames, but
      // the first-port convenience pair falls back to localhost.
      expect(api.environment![tunnelEnvHostnameKey(3000)]).toBeUndefined();
      expect(api.environment![WOS_ENV_HOSTNAME]).toBe("localhost");
      expect(api.environment!["WOS_SERVICE_PORT"]).toBe("21001");
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("no deploymentId omits deployment id label", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const compose = buildGeneratedCompose({
        config: exampleConfig(),
        worktreeRoot: WORKTREE,
        projectName: PROJECT,
        portAssignments: exampleAssignments(),
        tunnelHostnames: tunnelHostnames(),
      });

      const api = compose.services.api!;
      expect(api.labels![WOS_LABEL_DEPLOYMENT_ID]).toBeUndefined();
    } finally {
      delete process.env.WOS_HOME;
    }
  });
});

describe("first-port service environment", () => {
  test("injects WOS_SERVICE_PORT from the first configured host port", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.environment!["WOS_SERVICE_PORT"]).toBe("21001");
  });

  test("falls back to localhost when no tunnel hostname is active", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      tunnelHostnames: {},
    });
    expect(compose.services.api!.environment![WOS_ENV_HOSTNAME]).toBe("localhost");
  });

  test("uses the active tunnel hostname for the first port", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
      tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
    });
    expect(compose.services.api!.environment![WOS_ENV_HOSTNAME]).toBe(
      "feature-api.example.com",
    );
  });

  test("automatic values override user-supplied values for the same keys", () => {
    const cfg = exampleConfig();
    cfg.app.services.api!.environment = {
      ...cfg.app.services.api!.environment,
      WOS_SERVICE_PORT: "9999",
      WOS_SERVICE_HOSTNAME: "user-supplied.example.com",
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.api!.environment!["WOS_SERVICE_PORT"]).toBe("21001");
    expect(compose.services.api!.environment![WOS_ENV_HOSTNAME]).toBe("localhost");
  });

  test("multi-port service uses the first declared port for the pair", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    // web declares ports 4200 then 4210; the pair describes 4200.
    expect(compose.services.web!.environment!["WOS_SERVICE_PORT"]).toBe("21002");
  });

  test("omits the pair for app services without configured ports", () => {
    const cfg = exampleConfig();
    cfg.app.services.worker = {
      image: null,
      ports: [],
      script: ["python worker.py"],
      cwd: null,
      envFile: null,
      environment: {},
      volumes: [],
    };
    const compose = buildGeneratedCompose({
      config: cfg,
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    expect(compose.services.worker!.environment).toBeUndefined();
  });

  test("omits the pair for dependency containers", () => {
    const compose = buildGeneratedCompose({
      config: exampleConfig(),
      worktreeRoot: "/repo/wt",
      projectName: PROJECT,
      portAssignments: exampleAssignments(),
    });
    const db = compose.services.db!;
    expect(db.environment?.["WOS_SERVICE_PORT"]).toBeUndefined();
    expect(db.environment?.[WOS_ENV_HOSTNAME]).toBeUndefined();
  });
});
