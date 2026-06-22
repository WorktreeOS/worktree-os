import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultRepoConfig,
  loadRepoConfig,
  repoConfigPath,
} from "@worktreeos/core/repo-config";

let root: string;
const warnings: string[] = [];
const collectWarn = (text: string) => {
  warnings.push(text);
};

beforeEach(async () => {
  warnings.length = 0;
  const dir = await mkdtemp(join(tmpdir(), "wos-repo-config-"));
  root = await realpath(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(text: string): Promise<void> {
  await mkdir(join(root, ".wos"), { recursive: true });
  await writeFile(repoConfigPath(root), text);
}

describe("loadRepoConfig", () => {
  test("absent file resolves to defaults", async () => {
    const config = await loadRepoConfig(root, { stderrWrite: collectWarn });
    expect(config).toEqual(defaultRepoConfig());
    expect(warnings).toEqual([]);
  });

  test("empty file resolves to defaults", async () => {
    await writeConfig("");
    const config = await loadRepoConfig(root, { stderrWrite: collectWarn });
    expect(config).toEqual(defaultRepoConfig());
    expect(warnings).toEqual([]);
  });

  test("valid commit.message is parsed", async () => {
    await writeConfig(
      [
        "commit:",
        "  message:",
        "    provider: work-anthropic",
        "    model: claude-opus-4-8",
        "    language: en",
        "    instructions: |",
        "      - Conventional Commits.",
        "      - Subject <= 72 chars.",
      ].join("\n"),
    );
    const config = await loadRepoConfig(root, { stderrWrite: collectWarn });
    expect(config.commit.message.provider).toBe("work-anthropic");
    expect(config.commit.message.model).toBe("claude-opus-4-8");
    expect(config.commit.message.language).toBe("en");
    expect(config.commit.message.instructions).toContain("Conventional Commits");
    expect(warnings).toEqual([]);
  });

  test("malformed values fall back and warn", async () => {
    await writeConfig(
      ["commit:", "  message:", "    provider: 123", "    model: true"].join("\n"),
    );
    const config = await loadRepoConfig(root, { stderrWrite: collectWarn });
    expect(config.commit.message.provider).toBeUndefined();
    expect(config.commit.message.model).toBeUndefined();
    expect(warnings.length).toBe(2);
    expect(warnings.join("")).toContain("commit.message.provider");
    expect(warnings.join("")).toContain("commit.message.model");
  });

  test("unknown sibling keys are ignored", async () => {
    await writeConfig(
      [
        "commit:",
        "  message:",
        "    provider: p",
        "deploy:",
        "  unrelated: true",
        "future:",
        "  thing: 1",
      ].join("\n"),
    );
    const config = await loadRepoConfig(root, { stderrWrite: collectWarn });
    expect(config.commit.message.provider).toBe("p");
    expect(warnings).toEqual([]);
  });

  test("commit not a mapping warns and falls back", async () => {
    await writeConfig("commit: nonsense\n");
    const config = await loadRepoConfig(root, { stderrWrite: collectWarn });
    expect(config).toEqual(defaultRepoConfig());
    expect(warnings.join("")).toContain("commit must be a mapping");
  });
});
