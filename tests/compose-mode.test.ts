import { describe, expect, test } from "bun:test";
import {
  buildComposeOverlayYaml,
  collectComposeExposeBindings,
  ComposeModeError,
  resolveComposeConfigPath,
  sanitizeComposeYamlText,
  uniqueExposeServices,
} from "@worktreeos/compose/compose-mode";
import { composeArgs, type ComposeContext } from "@worktreeos/compose/compose";
import {
  WOS_ENV_HOSTNAME,
  tunnelEnvHostnameKey,
} from "@worktreeos/core/tunnel-metadata";

describe("collectComposeExposeBindings", () => {
  test("maps every expose entry to an app binding", () => {
    const bindings = collectComposeExposeBindings([
      { service: "api", port: 3000 },
      { service: "api", port: 4000 },
      { service: "web", port: 5000 },
    ]);
    expect(bindings).toEqual([
      { kind: "app", service: "api", containerPort: 3000 },
      { kind: "app", service: "api", containerPort: 4000 },
      { kind: "app", service: "web", containerPort: 5000 },
    ]);
  });
});

describe("uniqueExposeServices", () => {
  test("returns unique services in first-seen order", () => {
    expect(
      uniqueExposeServices([
        { service: "api", port: 3000 },
        { service: "web", port: 5000 },
        { service: "api", port: 4000 },
      ]),
    ).toEqual(["api", "web"]);
  });
});

describe("resolveComposeConfigPath", () => {
  test("returns absolute path unchanged", () => {
    expect(resolveComposeConfigPath("/etc/docker-compose.yaml", "/tmp/wt")).toBe(
      "/etc/docker-compose.yaml",
    );
  });
  test("resolves relative paths against the worktree root", () => {
    expect(resolveComposeConfigPath("docker-compose.yaml", "/tmp/wt")).toBe(
      "/tmp/wt/docker-compose.yaml",
    );
  });
});

describe("sanitizeComposeYamlText", () => {
  test("removes services.*.ports while preserving other keys", () => {
    const input = [
      "services:",
      "  api:",
      "    image: api",
      "    ports:",
      "      - \"3000:3000\"",
      "      - \"4000:4000\"",
      "  db:",
      "    image: postgres",
      "    ports:",
      "      - \"5432:5432\"",
      "    environment:",
      "      POSTGRES_USER: postgres",
      "",
    ].join("\n");
    const out = sanitizeComposeYamlText(input);
    expect(out).not.toContain("3000:3000");
    expect(out).not.toContain("5432:5432");
    expect(out).toContain("image");
    expect(out).toContain("api");
    expect(out).toContain("db");
    expect(out).toContain("POSTGRES_USER");
  });

  test("handles services with no ports", () => {
    const input = "services:\n  api:\n    image: api\n";
    const out = sanitizeComposeYamlText(input);
    expect(out).toContain("api");
    expect(out).not.toMatch(/ports/);
  });

  test("rejects non-mapping root", () => {
    expect(() => sanitizeComposeYamlText("- 1\n- 2\n")).toThrow(ComposeModeError);
  });

  test("rejects mapping where services is not a mapping", () => {
    expect(() => sanitizeComposeYamlText("services:\n  - api\n")).toThrow(
      ComposeModeError,
    );
  });

  test("handles top-level non-services keys (version, networks)", () => {
    const input = [
      "version: \"3.9\"",
      "networks:",
      "  default:",
      "    driver: bridge",
      "services:",
      "  api:",
      "    image: api",
      "    ports:",
      "      - \"3000:3000\"",
      "",
    ].join("\n");
    const out = sanitizeComposeYamlText(input);
    expect(out).toContain("networks");
    expect(out).toContain("default");
    expect(out).toContain("api");
    expect(out).not.toContain("3000:3000");
  });
});

describe("buildComposeOverlayYaml", () => {
  test("emits ports only for exposed entries with assignments", () => {
    const yaml = buildComposeOverlayYaml(
      [
        { service: "api", port: 3000 },
        { service: "api", port: 4000 },
      ],
      { api: { "3000": 21432, "4000": 21888 } },
    );
    expect(yaml).toContain("services");
    expect(yaml).toContain("api");
    expect(yaml).toContain("21432:3000");
    expect(yaml).toContain("21888:4000");
  });

  test("groups multiple ports per service", () => {
    const yaml = buildComposeOverlayYaml(
      [
        { service: "api", port: 3000 },
        { service: "web", port: 5000 },
        { service: "api", port: 4000 },
      ],
      {
        api: { "3000": 21000, "4000": 22000 },
        web: { "5000": 25000 },
      },
    );
    expect(yaml.match(/api:/g)?.length).toBe(1);
    expect(yaml.match(/web:/g)?.length).toBe(1);
    expect(yaml).toContain("21000:3000");
    expect(yaml).toContain("22000:4000");
    expect(yaml).toContain("25000:5000");
  });

  test("throws when an assignment is missing", () => {
    expect(() =>
      buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        {},
      ),
    ).toThrow(ComposeModeError);
  });
});

describe("composeArgs with multi-file context", () => {
  test("emits -f for each composeFiles entry in order", () => {
    const ctx: ComposeContext = {
      projectName: "p",
      composeFile: "/sess/compose-base.yaml",
      composeFiles: [
        "/sess/compose-base.yaml",
        "/sess/compose-overlay.yaml",
      ],
    };
    expect(composeArgs(ctx, ["up", "-d"])).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/sess/compose-base.yaml",
      "-f",
      "/sess/compose-overlay.yaml",
      "up",
      "-d",
    ]);
  });

  test("falls back to single composeFile when composeFiles is omitted", () => {
    const ctx: ComposeContext = {
      projectName: "p",
      composeFile: "/c.yaml",
    };
    expect(composeArgs(ctx, ["ps"])).toEqual([
      "compose",
      "-p",
      "p",
      "-f",
      "/c.yaml",
      "ps",
    ]);
  });
});

describe("compose-mode overlay tunnel restore metadata", () => {
  const WORKTREE = "/repo/wt";
  const PROJECT = "wos-proj";

  test("overlay includes restore labels for tunneled expose port", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        {
          tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
          worktreeRoot: WORKTREE,
          projectName: PROJECT,
          deploymentId: "deploy-xyz",
        },
      );
      expect(yaml).toContain("21432:3000");
      expect(yaml).toContain("dev.wos.managed");
      expect(yaml).toContain("true");
      expect(yaml).toContain("feature-api.example.com");
      expect(yaml).toContain("deploy-xyz");
      expect(yaml).toContain('mode: "compose"');
      // Should contain labels section
      expect(yaml).toContain("dev.wos.schema");
      expect(yaml).toContain('"1"');
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("hostname environment is exposed for single-port overlay service", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        {
          tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
          worktreeRoot: WORKTREE,
          projectName: PROJECT,
          deploymentId: "deploy-xyz",
        },
      );
      expect(yaml).toContain(WOS_ENV_HOSTNAME);
      expect(yaml).toContain("feature-api.example.com");
      expect(yaml).toContain(tunnelEnvHostnameKey(3000));
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("hostname environment is port-specific for multi-port overlay service", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [
          { service: "web", port: 4200 },
          { service: "web", port: 4210 },
        ],
        { web: { "4200": 21002, "4210": 21003 } },
        {
          tunnelHostnames: {
            web: { "4200": "web-4200.example.com", "4210": "web-4210.example.com" },
          },
          worktreeRoot: WORKTREE,
          projectName: PROJECT,
          deploymentId: "deploy-xyz",
        },
      );
      expect(yaml).toContain(tunnelEnvHostnameKey(4200));
      expect(yaml).toContain(tunnelEnvHostnameKey(4210));
      expect(yaml).toContain("web-4200.example.com");
      expect(yaml).toContain("web-4210.example.com");
      // No ambiguous WOS_SERVICE_HOSTNAME for multi-port
      const lines = yaml.split("\n");
      const envLines = lines.filter((l) => l.includes(WOS_ENV_HOSTNAME));
      // Should only have the port-specific ones, not the generic one
      const genericLines = lines.filter(
        (l) => l.trim().startsWith(WOS_ENV_HOSTNAME + ":") && !l.includes("_"),
      );
      expect(genericLines.length).toBe(0);
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("overlay without tunnel hostnames omits labels and environment when worktreeRoot is absent", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
      );
      expect(yaml).toContain("21432:3000");
      expect(yaml).not.toContain("dev.wos.managed");
      expect(yaml).not.toContain(WOS_ENV_HOSTNAME);
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("overlay emits identity labels for exposed services without tunnels when worktreeRoot is supplied", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        { worktreeRoot: "/repo/wt", projectName: "proj", deploymentId: "deploy-1" },
      );
      expect(yaml).toContain("21432:3000");
      expect(yaml).toContain("dev.wos.managed");
      expect(yaml).toContain("dev.wos.mode");
      expect(yaml).toContain("compose");
      expect(yaml).toContain("dev.wos.service");
      expect(yaml).toContain("dev.wos.deployment-id");
      // No tunnel-specific labels without active hostnames
      expect(yaml).not.toContain("dev.wos.tunnel.3000.hostname");
      // The first-exposed-port convenience pair is still injected, falling back
      // to localhost when no tunnel hostname is active.
      expect(yaml).toContain('WOS_SERVICE_PORT: "21432"');
      expect(yaml).toContain('WOS_SERVICE_HOSTNAME: "localhost"');
    } finally {
      delete process.env.WOS_HOME;
    }
  });
});

describe("compose-mode overlay first-exposed-port environment", () => {
  const WORKTREE = "/repo/wt";
  const PROJECT = "wos-proj";

  test("injects the host port for the exposed service", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        { worktreeRoot: WORKTREE, projectName: PROJECT },
      );
      expect(yaml).toContain('WOS_SERVICE_PORT: "21432"');
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("uses the active tunnel hostname for the first exposed port", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        {
          tunnelHostnames: { api: { "3000": "feature-api.example.com" } },
          worktreeRoot: WORKTREE,
          projectName: PROJECT,
        },
      );
      expect(yaml).toContain('WOS_SERVICE_HOSTNAME: "feature-api.example.com"');
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("selects the first exposed port in declaration order", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [
          { service: "api", port: 4000 },
          { service: "api", port: 3000 },
        ],
        { api: { "3000": 21000, "4000": 21500 } },
        { worktreeRoot: WORKTREE, projectName: PROJECT },
      );
      // 4000 is declared first, so the pair describes 4000.
      expect(yaml).toContain('WOS_SERVICE_PORT: "21500"');
      expect(yaml).not.toContain('WOS_SERVICE_PORT: "21000"');
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("emits the authoritative wos value so overlay precedence wins", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      // The overlay is merged after the user-owned base, so the wos-owned value
      // here is what Docker Compose resolves regardless of any user value.
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        { worktreeRoot: WORKTREE, projectName: PROJECT },
      );
      expect(yaml).toContain('WOS_SERVICE_PORT: "21432"');
      expect(yaml).toContain('WOS_SERVICE_HOSTNAME: "localhost"');
    } finally {
      delete process.env.WOS_HOME;
    }
  });

  test("omits services that are not exposed", () => {
    process.env.WOS_HOME = "/tmp/test-wos-home";
    try {
      const yaml = buildComposeOverlayYaml(
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 }, web: { "5000": 25000 } },
        { worktreeRoot: WORKTREE, projectName: PROJECT },
      );
      expect(yaml).toContain("api:");
      expect(yaml).not.toContain("web:");
    } finally {
      delete process.env.WOS_HOME;
    }
  });
});
