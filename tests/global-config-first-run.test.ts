import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildManagementSnapshot,
  firstRunSetupRequired,
  globalConfigPath,
  loadGlobalConfig,
  markFirstRunCompleted,
  saveGlobalConfig,
  validateGlobalConfigSave,
} from "@worktreeos/core/global-config";

let tmpHome: string;
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;
const opts = () => ({ env: env(), stderrWrite: () => {} });

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-firstrun-"));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("firstRunSetupRequired", () => {
  test("required only for a genuinely fresh install", () => {
    expect(
      firstRunSetupRequired({ markerPresent: false, configExists: false, projectCount: 0 }),
    ).toBe(true);
  });

  test("marker present completes setup", () => {
    expect(
      firstRunSetupRequired({ markerPresent: true, configExists: false, projectCount: 0 }),
    ).toBe(false);
  });

  test("existing config completes setup (back-compat)", () => {
    expect(
      firstRunSetupRequired({ markerPresent: false, configExists: true, projectCount: 0 }),
    ).toBe(false);
  });

  test("existing project completes setup (back-compat)", () => {
    expect(
      firstRunSetupRequired({ markerPresent: false, configExists: false, projectCount: 3 }),
    ).toBe(false);
  });
});

describe("firstRunCompleted marker persistence", () => {
  test("loadGlobalConfig parses a stored marker", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ firstRunCompleted: "2026-01-02T03:04:05.000Z" }),
    );
    const config = await loadGlobalConfig(opts());
    expect(config.firstRunCompleted).toBe("2026-01-02T03:04:05.000Z");
  });

  test("loadGlobalConfig ignores a non-string marker", async () => {
    await writeFile(
      globalConfigPath(env()),
      JSON.stringify({ firstRunCompleted: true }),
    );
    const config = await loadGlobalConfig(opts());
    expect(config.firstRunCompleted).toBeUndefined();
  });

  test("defaults have no marker", async () => {
    const config = await loadGlobalConfig(opts());
    expect(config.firstRunCompleted).toBeUndefined();
  });

  test("saveGlobalConfig persists the marker and it round-trips", async () => {
    const saved = await saveGlobalConfig(
      { firstRunCompleted: "2026-06-01T00:00:00.000Z", web: { port: 5000 } },
      opts(),
    );
    expect(saved.ok).toBe(true);
    const config = await loadGlobalConfig(opts());
    expect(config.firstRunCompleted).toBe("2026-06-01T00:00:00.000Z");
    const raw = JSON.parse(await readFile(globalConfigPath(env()), "utf8"));
    expect(raw.firstRunCompleted).toBe("2026-06-01T00:00:00.000Z");
  });

  test("a later save that omits the marker preserves it", async () => {
    await saveGlobalConfig(
      { firstRunCompleted: "2026-06-01T00:00:00.000Z" },
      opts(),
    );
    // A settings save from a page that does not carry the marker must not drop it.
    const second = await saveGlobalConfig({ web: { port: 6000 } }, opts());
    expect(second.ok).toBe(true);
    const config = await loadGlobalConfig(opts());
    expect(config.firstRunCompleted).toBe("2026-06-01T00:00:00.000Z");
    expect(config.web.port).toBe(6000);
  });

  test("management snapshot raw includes the marker", async () => {
    await saveGlobalConfig(
      { firstRunCompleted: "2026-06-01T00:00:00.000Z" },
      opts(),
    );
    const snap = await buildManagementSnapshot(opts());
    expect(snap.raw?.firstRunCompleted).toBe("2026-06-01T00:00:00.000Z");
    expect(snap.effective.firstRunCompleted).toBe("2026-06-01T00:00:00.000Z");
  });

  test("validateGlobalConfigSave rejects an empty marker", () => {
    const result = validateGlobalConfigSave({ firstRunCompleted: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.field).toBe("firstRunCompleted");
  });
});

describe("markFirstRunCompleted", () => {
  test("stamps a marker onto a fresh install without a config file", async () => {
    const result = await markFirstRunCompleted(opts(), "2026-07-01T12:00:00.000Z");
    expect(result.ok).toBe(true);
    const config = await loadGlobalConfig(opts());
    expect(config.firstRunCompleted).toBe("2026-07-01T12:00:00.000Z");
  });

  test("preserves existing settings while stamping the marker", async () => {
    await saveGlobalConfig({ web: { port: 7000 } }, opts());
    await markFirstRunCompleted(opts(), "2026-07-01T12:00:00.000Z");
    const config = await loadGlobalConfig(opts());
    expect(config.web.port).toBe(7000);
    expect(config.firstRunCompleted).toBe("2026-07-01T12:00:00.000Z");
  });
});
