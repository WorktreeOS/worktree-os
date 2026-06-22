import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildComposeCommandEnvironment,
  ComposeEnvError,
  loadComposeEnvFiles,
  parseEnvFileContents,
  resolveComposeEnvFilePath,
  resolveComposeEnvironment,
} from "@worktreeos/compose/compose-env";

async function makeTmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "wos-env-"));
}

describe("parseEnvFileContents", () => {
  test("ignores blank lines and comments", () => {
    const parsed = parseEnvFileContents(
      ["", "# a comment", "  ", "  # indented comment", "FOO=bar", ""].join("\n"),
      "/path/to/.env",
    );
    expect(parsed).toEqual({ FOO: "bar" });
  });

  test("trims surrounding double or single quotes", () => {
    const parsed = parseEnvFileContents(
      [`A="quoted"`, `B='single'`, `C=plain`].join("\n"),
      "/path/.env",
    );
    expect(parsed).toEqual({ A: "quoted", B: "single", C: "plain" });
  });

  test("rejects malformed line with file and line number", () => {
    expect(() =>
      parseEnvFileContents(["FOO=bar", "broken-line"].join("\n"), "/file/.env"),
    ).toThrow(/\/file\/\.env.*line 2/);
  });

  test("rejects invalid key", () => {
    expect(() => parseEnvFileContents("9FOO=bar", "/x/.env")).toThrow(
      ComposeEnvError,
    );
  });
});

describe("resolveComposeEnvFilePath", () => {
  test("returns absolute path unchanged", () => {
    expect(resolveComposeEnvFilePath("/etc/.env", "/tmp/wt")).toBe("/etc/.env");
  });

  test("resolves relative path against worktree root", () => {
    expect(resolveComposeEnvFilePath(".env.compose", "/tmp/wt")).toBe(
      "/tmp/wt/.env.compose",
    );
  });
});

describe("loadComposeEnvFiles", () => {
  test("later files override earlier files", async () => {
    const dir = await makeTmp();
    try {
      await writeFile(resolve(dir, ".env.base"), "TEST=from-base\nA=base\n");
      await writeFile(resolve(dir, ".env.local"), "TEST=from-local\nB=local\n");
      const merged = await loadComposeEnvFiles(
        [".env.base", ".env.local"],
        dir,
      );
      expect(merged).toEqual({ TEST: "from-local", A: "base", B: "local" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing file raises actionable error", async () => {
    const dir = await makeTmp();
    try {
      await expect(
        loadComposeEnvFiles([".env.missing"], dir),
      ).rejects.toThrow(/compose env-file not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns empty map when no env files configured", async () => {
    const dir = await makeTmp();
    try {
      expect(await loadComposeEnvFiles([], dir)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildComposeCommandEnvironment", () => {
  test("inline environment overrides env file values", async () => {
    const dir = await makeTmp();
    try {
      await writeFile(resolve(dir, ".env.compose"), "TEST=from-file\nFROM_FILE=1\n");
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [".env.compose"],
          environment: { TEST: "from-inline" },
        },
        worktreeRoot: dir,
        processEnv: { BASE: "process" },
      });
      expect(env.TEST).toBe("from-inline");
      expect(env.FROM_FILE).toBe("1");
      expect(env.BASE).toBe("process");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("multiple env files merge in listed order before inline", async () => {
    const dir = await makeTmp();
    try {
      await writeFile(resolve(dir, ".env.base"), "TEST=from-base\nA=base\n");
      await writeFile(resolve(dir, ".env.local"), "TEST=from-local\nB=local\n");
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [".env.base", ".env.local"],
          environment: {},
        },
        worktreeRoot: dir,
        processEnv: {},
      });
      expect(env.TEST).toBe("from-local");
      expect(env.A).toBe("base");
      expect(env.B).toBe("local");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inline-only environment merges over process env without files", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { OVERRIDE: "yes" },
        },
        worktreeRoot: dir,
        processEnv: { PATH: "/usr/bin", OVERRIDE: "no" },
      });
      expect(env.PATH).toBe("/usr/bin");
      expect(env.OVERRIDE).toBe("yes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves expose hostPort templates with assignments", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_HOST_PORT: "${expose.api.hostPort[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
      });
      expect(env.API_HOST_PORT).toBe("21432");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hostname template resolves to active tunnel hostname when provided", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_HOSTNAME: "${expose.api.hostname[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
        tunnelHostnames: { api: { "3000": "preview-api.loca.lt" } },
      });
      expect(env.API_HOSTNAME).toBe("preview-api.loca.lt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hostname template falls back to localhost when no tunnel is active", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_HOSTNAME: "${expose.api.hostname[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
      });
      expect(env.API_HOSTNAME).toBe("localhost");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("url template resolves to active tunnel url when provided", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_URL: "${expose.api.url[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
        tunnelHostnames: { api: { "3000": "preview-api.loca.lt" } },
        tunnelUrls: { api: { "3000": "https://preview-api.loca.lt" } },
      });
      expect(env.API_URL).toBe("https://preview-api.loca.lt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("url template falls back to http://localhost:<hostPort> when no tunnel is active", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_URL: "${expose.api.url[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
      });
      expect(env.API_URL).toBe("http://localhost:21432");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hostname template falls back to serviceBind when no tunnel is active", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_HOSTNAME: "${expose.api.hostname[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
        serviceBind: "192.168.1.18",
      });
      expect(env.API_HOSTNAME).toBe("192.168.1.18");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("url template falls back to http://<serviceBind>:<hostPort> when no tunnel is active", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_URL: "${expose.api.url[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
        serviceBind: "192.168.1.18",
      });
      expect(env.API_URL).toBe("http://192.168.1.18:21432");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("active tunnel url wins over serviceBind", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_URL: "${expose.api.url[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
        tunnelUrls: { api: { "3000": "https://preview-api.loca.lt" } },
        serviceBind: "192.168.1.18",
      });
      expect(env.API_URL).toBe("https://preview-api.loca.lt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("url template brackets an IPv6 serviceBind", async () => {
    const dir = await makeTmp();
    try {
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [],
          environment: { API_URL: "${expose.api.url[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
        serviceBind: "fd00::1",
      });
      expect(env.API_URL).toBe("http://[fd00::1]:21432");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inline templates override env-file value with resolved port", async () => {
    const dir = await makeTmp();
    try {
      await writeFile(resolve(dir, ".env.compose"), "API_HOST_PORT=from-file\n");
      const env = await buildComposeCommandEnvironment({
        config: {
          config: "docker-compose.yaml",
          expose: [{ service: "api", port: 3000 }],
          envFile: [".env.compose"],
          environment: { API_HOST_PORT: "${expose.api.hostPort[3000]}" },
        },
        worktreeRoot: dir,
        processEnv: {},
        assignments: { api: { "3000": 21432 } },
      });
      expect(env.API_HOST_PORT).toBe("21432");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveComposeEnvironment", () => {
  test("rejects template referencing unknown expose service", () => {
    expect(() =>
      resolveComposeEnvironment(
        { X: "${expose.unknown.hostPort[3000]}" },
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        {},
        {},
      ),
    ).toThrow(/unknown compose\.expose service "unknown"/);
  });

  test("rejects template referencing unconfigured port", () => {
    expect(() =>
      resolveComposeEnvironment(
        { X: "${expose.api.hostPort[9999]}" },
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        {},
        {},
      ),
    ).toThrow(/unconfigured container port 9999/);
  });

  test("rejects unsupported template expression", () => {
    expect(() =>
      resolveComposeEnvironment(
        { X: "${app.services.api.hostPort[3000]}" },
        [{ service: "api", port: 3000 }],
        { api: { "3000": 21432 } },
        {},
        {},
      ),
    ).toThrow(ComposeEnvError);
  });

  test("passes literal values through unchanged", () => {
    const out = resolveComposeEnvironment(
      { LIT: "plain-string", N: "1234" },
      [{ service: "api", port: 3000 }],
      { api: { "3000": 21432 } },
      {},
      {},
    );
    expect(out).toEqual({ LIT: "plain-string", N: "1234" });
  });
});
