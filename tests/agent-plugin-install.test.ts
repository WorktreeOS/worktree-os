import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  bundledClaudePluginVersion,
  bundledCodexPluginVersion,
  claudePluginRegistryPath,
  claudeSettingsPath,
  codexPluginStatus,
  ensureClaudePluginInstalled,
  getAgentPluginStatus,
  injectOpencodePlugin,
  isAgentPluginInstalled,
  opencodeConfigPath,
  opencodePluginEntry,
  reinstallClaudePlugin,
  removeLegacyClaudeHooks,
  resetAgentPluginInstallCache,
} from "@worktreeos/daemon/agent-plugin-install";
import type { ClaudeCliRunner } from "@worktreeos/daemon/claude-plugin-cli";
import {
  addCodexMarketplace,
  type CodexCliRunner,
  installCodexPluginCli,
  parseCodexPluginList,
  uninstallCodexPluginCli,
} from "@worktreeos/daemon/codex-plugin-cli";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "wos-plugin-install-"));
  env = {
    CLAUDE_CONFIG_DIR: resolve(home, ".claude"),
    XDG_CONFIG_HOME: resolve(home, ".config"),
  };
  resetAgentPluginInstallCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetAgentPluginInstallCache();
});

/** Write a v2-shaped plugin registry with a wos entry at `version`. */
function writeRegistry(version: string | null) {
  const path = claudePluginRegistryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      plugins: version
        ? {
            "wos@worktreeos": [
              { scope: "user", version, installPath: "/cache/wos" },
            ],
          }
        : {},
    }),
  );
}

const LEGACY_ENTRY = {
  hooks: [
    {
      type: "command",
      command: "/repo/packages/plugin-claude/scripts/on-stop.sh",
    },
  ],
};

describe("plugin install detection", () => {
  test("reports missing plugins on a clean home", () => {
    expect(isAgentPluginInstalled("claude", env)).toBe(false);
    resetAgentPluginInstallCache();
    expect(isAgentPluginInstalled("opencode", env)).toBe(false);
  });

  test("detects the installed claude plugin from the registry", () => {
    writeRegistry(bundledClaudePluginVersion());
    const status = getAgentPluginStatus("claude", env);
    expect(status.installed).toBe(true);
    expect(status.outdated).toBe(false);
  });

  test("flags an outdated claude plugin", () => {
    writeRegistry("0.0.1");
    const status = getAgentPluginStatus("claude", env);
    expect(status.installed).toBe(true);
    expect(status.outdated).toBe(true);
  });

  test("legacy injected hooks do not count as installed", () => {
    const path = claudeSettingsPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [LEGACY_ENTRY] } }));
    expect(isAgentPluginInstalled("claude", env)).toBe(false);
  });

  test("an unrecognizable registry degrades to not installed", () => {
    const path = claudePluginRegistryPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json at all");
    expect(isAgentPluginInstalled("claude", env)).toBe(false);
  });

  test("detects installed opencode plugin", () => {
    injectOpencodePlugin(env);
    resetAgentPluginInstallCache();
    expect(isAgentPluginInstalled("opencode", env)).toBe(true);
  });

  test("reflects a registry change without a cache reset", () => {
    // Detection must read the registry on every call: no time-based cache can
    // serve a stale result between two detections of the same agent.
    expect(getAgentPluginStatus("claude", env).installed).toBe(false);
    writeRegistry(bundledClaudePluginVersion());
    expect(getAgentPluginStatus("claude", env).installed).toBe(true);
    writeRegistry(null);
    expect(getAgentPluginStatus("claude", env).installed).toBe(false);
  });
});

describe("codex plugin detection", () => {
  /** Build a `codex plugin list --json` fixture with the wos entry at `version`. */
  function listJson(version: string | null): string {
    return JSON.stringify({
      installed: version === null ? [] : [{ name: "wos", version }],
      available: [],
    });
  }

  function statusFor(version: string | null) {
    return codexPluginStatus(parseCodexPluginList(listJson(version)));
  }

  test("a fresh semver below the bundled version is outdated", () => {
    const status = statusFor("0.0.1");
    expect(status.installed).toBe(true);
    expect(status.outdated).toBe(true);
  });

  test("the bundled semver is installed and current", () => {
    const status = statusFor(bundledCodexPluginVersion());
    expect(status.installed).toBe(true);
    expect(status.outdated).toBe(false);
  });

  test("a local (non-semver) install omits the outdated indicator", () => {
    const status = codexPluginStatus(
      parseCodexPluginList(
        JSON.stringify({ installed: [{ name: "wos", version: "local" }] }),
      ),
    );
    expect(status.installed).toBe(true);
    expect(status.outdated).toBeUndefined();
  });

  test("no wos entry reads as not installed", () => {
    expect(statusFor(null).installed).toBe(false);
  });

  test("unparseable list output degrades to not installed", () => {
    const status = codexPluginStatus(parseCodexPluginList("not json at all"));
    expect(status.installed).toBe(false);
  });

  test("getAgentPluginStatus('codex') reports not installed when codex is absent", () => {
    // The `codex` CLI is not on PATH in CI: a spawn ENOENT degrades to a clean
    // not-installed status rather than throwing.
    const status = getAgentPluginStatus("codex", { ...env, PATH: "" });
    expect(status.installed).toBe(false);
  });
});

describe("codex plugin CLI verbs", () => {
  // Pins the exact `codex plugin` verbs against codex-cli 0.141.0: install is
  // `add` (not `install`) and removal is `remove` (not `uninstall`).
  function recordingRunner(calls: string[][]): CodexCliRunner {
    return async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }

  test("marketplace registration uses `plugin marketplace add <source>`", async () => {
    const calls: string[][] = [];
    await addCodexMarketplace("/repo", recordingRunner(calls));
    expect(calls[0]).toEqual(["plugin", "marketplace", "add", "/repo"]);
  });

  test("install uses `plugin add wos@worktreeos`", async () => {
    const calls: string[][] = [];
    await installCodexPluginCli(recordingRunner(calls));
    expect(calls[0]).toEqual(["plugin", "add", "wos@worktreeos"]);
  });

  test("uninstall uses `plugin remove wos@worktreeos`", async () => {
    const calls: string[][] = [];
    await uninstallCodexPluginCli(recordingRunner(calls));
    expect(calls[0]).toEqual(["plugin", "remove", "wos@worktreeos"]);
  });
});

describe("legacy hook migration", () => {
  test("strips wos entries and preserves unrelated hooks and settings", () => {
    const path = claudeSettingsPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "/usr/bin/other-hook" }] },
            LEGACY_ENTRY,
          ],
          UserPromptSubmit: [LEGACY_ENTRY],
        },
      }),
    );

    expect(removeLegacyClaudeHooks(env)).toBe(true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "/usr/bin/other-hook" }] },
    ]);
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  });

  test("is idempotent on a clean settings file", () => {
    const path = claudeSettingsPath(env);
    mkdirSync(dirname(path), { recursive: true });
    const original = JSON.stringify({ model: "opus", hooks: { Stop: [] } });
    writeFileSync(path, original);
    expect(removeLegacyClaudeHooks(env)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("missing settings file is a no-op", () => {
    expect(removeLegacyClaudeHooks(env)).toBe(false);
  });
});

describe("ensureClaudePluginInstalled", () => {
  function fakeRunner(calls: string[][], exitCode = 0): ClaudeCliRunner {
    return async (args) => {
      calls.push(args);
      return { exitCode, stderr: exitCode === 0 ? "" : "boom" };
    };
  }

  test("installs via marketplace add + install when missing", async () => {
    const calls: string[][] = [];
    const result = await ensureClaudePluginInstalled(env, fakeRunner(calls));
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "plugin marketplace add",
      "plugin install wos@worktreeos",
    ]);
  });

  test("updates marketplace and plugin when outdated", async () => {
    writeRegistry("0.0.1");
    const calls: string[][] = [];
    const result = await ensureClaudePluginInstalled(env, fakeRunner(calls));
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "plugin marketplace add",
      "plugin marketplace update",
      "plugin update wos@worktreeos",
    ]);
  });

  test("no-op when installed and current, still migrates legacy hooks", async () => {
    writeRegistry(bundledClaudePluginVersion());
    const settings = claudeSettingsPath(env);
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [LEGACY_ENTRY] } }));
    const calls: string[][] = [];
    const result = await ensureClaudePluginInstalled(env, fakeRunner(calls));
    expect(result.ok).toBe(true);
    expect(result.migratedLegacyHooks).toBe(true);
    expect(calls).toEqual([]);
    expect(isAgentPluginInstalled("claude", env)).toBe(true);
  });

  test("surfaces CLI failures as typed errors", async () => {
    const calls: string[][] = [];
    const result = await ensureClaudePluginInstalled(env, fakeRunner(calls, 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("command-failed");
  });

  test("missing claude binary surfaces as claude-cli-not-found", async () => {
    const enoent: ClaudeCliRunner = async () => {
      const err = new Error("spawn claude ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    const result = await ensureClaudePluginInstalled(env, enoent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("claude-cli-not-found");
  });
});

describe("reinstallClaudePlugin", () => {
  function fakeRunner(calls: string[][], exitCode = 0): ClaudeCliRunner {
    return async (args) => {
      calls.push(args);
      return { exitCode, stderr: exitCode === 0 ? "" : "boom" };
    };
  }

  test("uninstalls, refreshes the marketplace, then installs", async () => {
    writeRegistry(bundledClaudePluginVersion());
    const calls: string[][] = [];
    const result = await reinstallClaudePlugin(env, fakeRunner(calls));
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "plugin uninstall wos@worktreeos",
      "plugin marketplace update",
      "plugin install wos@worktreeos",
    ]);
  });

  test("migrates legacy hooks best-effort before reinstalling", async () => {
    const settings = claudeSettingsPath(env);
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [LEGACY_ENTRY] } }));
    const result = await reinstallClaudePlugin(env, fakeRunner([]));
    expect(result.ok).toBe(true);
    expect(result.migratedLegacyHooks).toBe(true);
  });

  test("stops and surfaces the first failing step", async () => {
    const calls: string[][] = [];
    const result = await reinstallClaudePlugin(env, fakeRunner(calls, 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("command-failed");
    // The failing uninstall aborts the sequence — later steps never run.
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "plugin uninstall",
    ]);
  });

  test("missing claude binary surfaces as claude-cli-not-found", async () => {
    const enoent: ClaudeCliRunner = async () => {
      const err = new Error("spawn claude ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    const result = await reinstallClaudePlugin(env, enoent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("claude-cli-not-found");
  });
});

describe("opencode auto-inject", () => {
  test("opencode injection is idempotent and preserves other config", () => {
    const path = opencodeConfigPath(env);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme: "dark", plugin: ["other"] }));

    expect(injectOpencodePlugin(env)).toBe(true);
    const first = readFileSync(path, "utf8");
    const config = JSON.parse(first);
    expect(config.theme).toBe("dark");
    expect(config.plugin).toEqual(["other", opencodePluginEntry()]);

    expect(injectOpencodePlugin(env)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("opencode injection creates the config file when missing", () => {
    expect(injectOpencodePlugin(env)).toBe(true);
    const config = JSON.parse(readFileSync(opencodeConfigPath(env), "utf8"));
    expect(config.plugin).toEqual([opencodePluginEntry()]);
  });

  test("opencode injection replaces a stale wos entry", () => {
    const path = opencodeConfigPath(env);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ plugin: ["other", "@worktreeos/plugin-opencode"] }),
    );
    expect(injectOpencodePlugin(env)).toBe(true);
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.plugin).toEqual(["other", opencodePluginEntry()]);
  });
});
