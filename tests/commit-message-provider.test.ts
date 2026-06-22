import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildManagementSnapshot,
  defaultGlobalConfig,
  globalConfigPath,
  loadGlobalConfig,
  resolveCommitMessageProvider,
  saveGlobalConfig,
  type GlobalConfig,
} from "@worktreeos/core/global-config";
import {
  defaultRepoConfig,
  type RepoConfig,
} from "@worktreeos/core/repo-config";

let tmpHome: string;
let warnings: string[];
const env = () => ({ WOS_HOME: tmpHome }) as NodeJS.ProcessEnv;
const warn = (s: string) => {
  warnings.push(s);
};

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-commit-cfg-"));
  warnings = [];
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

async function writeConfigJson(obj: unknown): Promise<void> {
  await writeFile(globalConfigPath(env()), JSON.stringify(obj, null, 2));
}

describe("commitMessages global config", () => {
  test("default global config has an empty commitMessages block", () => {
    expect(defaultGlobalConfig().commitMessages).toEqual({});
  });

  test("loads a valid commitMessages block referencing a configured provider", async () => {
    await writeConfigJson({
      aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
      commitMessages: { provider: "work", model: "claude-opus-4-8" },
    });
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.commitMessages).toEqual({
      provider: "work",
      model: "claude-opus-4-8",
    });
    expect(warnings).toEqual([]);
  });

  test("drops a commitMessages.provider that names no configured provider", async () => {
    await writeConfigJson({
      aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
      commitMessages: { provider: "missing" },
    });
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.commitMessages.provider).toBeUndefined();
    expect(warnings.join("")).toContain("commitMessages.provider");
  });

  test("management snapshot carries raw and effective commitMessages", async () => {
    await writeConfigJson({
      aiProviders: [{ type: "openai", apiKey: "k", name: "oai" }],
      commitMessages: { provider: "oai", model: "gpt-4o" },
    });
    const snap = await buildManagementSnapshot({ env: env(), stderrWrite: warn });
    expect(snap.raw?.commitMessages).toEqual({ provider: "oai", model: "gpt-4o" });
    expect(snap.effective.commitMessages).toEqual({
      provider: "oai",
      model: "gpt-4o",
    });
  });

  test("save round-trip persists commitMessages", async () => {
    const result = await saveGlobalConfig(
      {
        aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
        commitMessages: { provider: "work", model: "m" },
      },
      { env: env(), stderrWrite: warn },
    );
    expect(result.ok).toBe(true);
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.commitMessages).toEqual({ provider: "work", model: "m" });
  });

  test("save that omits commitMessages preserves the existing block", async () => {
    await saveGlobalConfig(
      {
        aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
        commitMessages: { provider: "work" },
      },
      { env: env(), stderrWrite: warn },
    );
    // A later save from another page that omits commitMessages entirely.
    await saveGlobalConfig(
      { aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }] },
      { env: env(), stderrWrite: warn },
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.commitMessages.provider).toBe("work");
  });

  test("save with an explicit empty commitMessages clears it", async () => {
    await saveGlobalConfig(
      {
        aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
        commitMessages: { provider: "work" },
      },
      { env: env(), stderrWrite: warn },
    );
    await saveGlobalConfig(
      {
        aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
        commitMessages: {},
      },
      { env: env(), stderrWrite: warn },
    );
    const cfg = await loadGlobalConfig({ env: env(), stderrWrite: warn });
    expect(cfg.commitMessages).toEqual({});
  });
});

describe("resolveCommitMessageProvider", () => {
  function configWith(
    providers: GlobalConfig["aiProviders"],
    commitMessages: GlobalConfig["commitMessages"] = {},
  ): GlobalConfig {
    return { ...defaultGlobalConfig(), aiProviders: providers, commitMessages };
  }
  function repoWith(message: RepoConfig["commit"]["message"]): RepoConfig {
    return { commit: { message } };
  }

  test("returns undefined when no providers are configured", () => {
    const resolved = resolveCommitMessageProvider(
      defaultRepoConfig(),
      configWith([]),
    );
    expect(resolved).toBeUndefined();
  });

  test("prefers the repo config provider/model", () => {
    const cfg = configWith(
      [
        { type: "anthropic", apiKey: "a", name: "A" },
        { type: "openai", apiKey: "b", name: "B" },
      ],
      { provider: "B", model: "global-model" },
    );
    const resolved = resolveCommitMessageProvider(
      repoWith({ provider: "A", model: "repo-model" }),
      cfg,
    );
    expect(resolved?.provider.name).toBe("A");
    expect(resolved?.model).toBe("repo-model");
  });

  test("falls back to the global default provider", () => {
    const cfg = configWith(
      [
        { type: "anthropic", apiKey: "a", name: "A" },
        { type: "openai", apiKey: "b", name: "B" },
      ],
      { provider: "B", model: "global-model" },
    );
    const resolved = resolveCommitMessageProvider(defaultRepoConfig(), cfg);
    expect(resolved?.provider.name).toBe("B");
    expect(resolved?.model).toBe("global-model");
  });

  test("falls back to the first configured provider", () => {
    const cfg = configWith([
      { type: "anthropic", apiKey: "a", name: "A" },
      { type: "openai", apiKey: "b", name: "B" },
    ]);
    const resolved = resolveCommitMessageProvider(defaultRepoConfig(), cfg);
    expect(resolved?.provider.name).toBe("A");
    expect(resolved?.model).toBeUndefined();
  });
});
