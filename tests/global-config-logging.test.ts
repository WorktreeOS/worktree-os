import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildManagementSnapshot,
  defaultGlobalConfig,
  defaultLoggingConfig,
  globalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
} from "@worktreeos/core/global-config";

let tmpHome: string;
let warnings: string[];
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;
const warn = (s: string) => {
  warnings.push(s);
};

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-logging-cfg-"));
  warnings = [];
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("global config logging settings", () => {
  test("default global config has logging disabled", () => {
    const cfg = defaultGlobalConfig();
    expect(cfg.logging.enabled).toBe(false);
    expect(cfg.logging.level).toBe("info");
    expect(cfg.logging.modules).toEqual({});
    expect(cfg.logging.redactPrompts).toBe(true);
    expect(cfg.logging.perf).toEqual({
      enabled: true,
      stuckWatchdog: true,
      slowMs: { default: 1000 },
    });
  });

  test("loads a valid logging section", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        logging: {
          enabled: true,
          level: "debug",
          modules: { "agent-activity": "trace", terminal: "off" },
          file: "/var/log/wos/daemon.log",
          redactPrompts: false,
          perf: {
            enabled: true,
            stuckWatchdog: false,
            slowMs: { git: 250, default: 800 },
          },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(warnings).toEqual([]);
    expect(cfg.logging.enabled).toBe(true);
    expect(cfg.logging.level).toBe("debug");
    expect(cfg.logging.modules).toEqual({
      "agent-activity": "trace",
      terminal: "off",
    });
    expect(cfg.logging.file).toBe("/var/log/wos/daemon.log");
    expect(cfg.logging.redactPrompts).toBe(false);
    expect(cfg.logging.perf.enabled).toBe(true);
    expect(cfg.logging.perf.stuckWatchdog).toBe(false);
    // A user slowMs map merges over the default (which is preserved).
    expect(cfg.logging.perf.slowMs).toEqual({ git: 250, default: 800 });
  });

  test("warns and falls back for invalid logging fields", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        logging: {
          enabled: true,
          level: "loud",
          modules: { terminal: "verbose" },
          perf: { slowMs: { git: -5, attach: "soon" } },
        },
      }),
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    // enabled is valid and applied; the rest reverts to defaults.
    expect(cfg.logging.enabled).toBe(true);
    expect(cfg.logging.level).toBe("info");
    expect(cfg.logging.modules).toEqual({});
    expect(cfg.logging.perf.slowMs).toEqual({ default: 1000 });
    expect(warnings.some((w) => w.includes("logging.level"))).toBe(true);
    expect(warnings.some((w) => w.includes("logging.modules.terminal"))).toBe(true);
    expect(warnings.some((w) => w.includes("logging.perf.slowMs.git"))).toBe(true);
    expect(warnings.some((w) => w.includes("logging.perf.slowMs.attach"))).toBe(true);
  });

  test("management snapshot includes raw + effective logging", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        logging: { enabled: true, level: "trace", perf: { enabled: false } },
      }),
    );
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: warn });
    expect(snap.raw?.logging).toEqual({
      enabled: true,
      level: "trace",
      perf: { enabled: false },
    });
    expect(snap.effective.logging.enabled).toBe(true);
    expect(snap.effective.logging.level).toBe("trace");
    expect(snap.effective.logging.perf.enabled).toBe(false);
  });

  test("settings save preserves a hand-edited logging block", async () => {
    // Hand-edited config carrying a logging block.
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({
        web: { port: 4949 },
        logging: { enabled: true, level: "debug" },
      }),
    );
    // A settings save that does NOT include a logging section (no UI for it).
    const result = await saveGlobalConfig(
      { web: { port: 5000 } },
      { env: env(), stderrWrite: warn },
    );
    expect(result.ok).toBe(true);

    // The persisted file still carries the logging block.
    const raw = JSON.parse(await readFile(globalConfigPath(env()), "utf8"));
    expect(raw.logging).toEqual({ enabled: true, level: "debug" });
    expect(raw.web.port).toBe(5000);

    // And a fresh load resolves it as effective config.
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.logging.enabled).toBe(true);
    expect(cfg.logging.level).toBe("debug");
  });

  test("a submitted logging block round-trips and wins over disk", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ logging: { enabled: false, level: "info" } }),
    );
    const result = await saveGlobalConfig(
      { logging: { enabled: true, level: "trace" } },
      { env: env(), stderrWrite: warn },
    );
    expect(result.ok).toBe(true);
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.logging.enabled).toBe(true);
    expect(cfg.logging.level).toBe("trace");
  });

  test("matches the default logging config helper", () => {
    expect(defaultGlobalConfig().logging).toEqual(defaultLoggingConfig());
  });
});
