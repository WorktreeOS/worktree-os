import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  claudePluginRoot,
  codexPluginRoot,
  opencodePluginEntry,
  piPluginEntry,
} from "@worktreeos/daemon/agent-plugin-install";
import { claudeMarketplaceSource } from "@worktreeos/daemon/claude-plugin-cli";
import { codexMarketplaceSource } from "@worktreeos/daemon/codex-plugin-cli";

import { layDownPlugins } from "../scripts/build-dist";

// Task 4.1: the plugin roots and marketplace sources resolve to the in-repo
// packages in a source checkout and beside the bundle under the published
// layout. Passing `pluginsDir` directly exercises both branches without
// depending on the test runner's own `import.meta.dir`.
describe("plugin resolution — source vs packaged branch", () => {
  test("a source checkout resolves to the in-repo plugin packages", () => {
    expect(claudePluginRoot(null).endsWith("/plugin-claude")).toBe(true);
    expect(codexPluginRoot(null).endsWith("/plugin-codex")).toBe(true);
    expect(opencodePluginEntry(null)).toContain(
      "/plugin-opencode/src/index.ts",
    );
    expect(piPluginEntry(null).endsWith("/plugin-pi/src/index.ts")).toBe(true);
  });

  test("the published layout resolves beside the bundle", () => {
    const plugins = "/pkg/plugins";
    expect(claudePluginRoot(plugins)).toBe("/pkg/plugins/claude");
    expect(codexPluginRoot(plugins)).toBe("/pkg/plugins/codex");
    expect(opencodePluginEntry(plugins)).toBe(
      "file:///pkg/plugins/opencode/src/index.ts",
    );
    expect(piPluginEntry(plugins)).toBe("/pkg/plugins/pi/src/index.ts");
  });

  test("marketplace sources follow the packaged layout; env override still wins", () => {
    const plugins = "/pkg/plugins";
    expect(claudeMarketplaceSource({}, plugins)).toBe("/pkg/plugins/claude");
    expect(codexMarketplaceSource({}, plugins)).toBe("/pkg/plugins/codex");
    expect(
      claudeMarketplaceSource(
        { WOS_CLAUDE_MARKETPLACE_SOURCE: "/override" },
        plugins,
      ),
    ).toBe("/override");
    expect(
      codexMarketplaceSource(
        { WOS_CODEX_MARKETPLACE_SOURCE: "/override" },
        plugins,
      ),
    ).toBe("/override");
  });
});

// Task 4.3: run the plugin-install resolution against an assembled `dist/npm`
// layout (not the source tree) and confirm the resolved entries exist and load.
describe("packaged plugin layout contract (assembled dist)", () => {
  let outDir: string;
  let plugins: string;

  beforeAll(async () => {
    outDir = mkdtempSync(resolve(tmpdir(), "wos-dist-plugins-"));
    await layDownPlugins(outDir);
    plugins = resolve(outDir, "plugins");
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test("the Claude marketplace source is a real dir with a self-hosted manifest", async () => {
    const source = claudeMarketplaceSource({}, plugins);
    const manifest = (await Bun.file(
      resolve(source, ".claude-plugin/marketplace.json"),
    ).json()) as { plugins: Array<{ source: string }> };
    expect(manifest.plugins[0]?.source).toBe(".");
    const root = claudePluginRoot(plugins);
    expect(existsSync(resolve(root, ".claude-plugin/plugin.json"))).toBe(true);
    expect(existsSync(resolve(root, "hooks/hooks.json"))).toBe(true);
  });

  test("the Codex marketplace source is a real dir with a self-hosted manifest", async () => {
    const source = codexMarketplaceSource({}, plugins);
    const manifest = (await Bun.file(
      resolve(source, ".agents/plugins/marketplace.json"),
    ).json()) as { plugins: Array<{ source: string }> };
    expect(manifest.plugins[0]?.source).toBe(".");
    const root = codexPluginRoot(plugins);
    expect(existsSync(resolve(root, ".codex-plugin/plugin.json"))).toBe(true);
    expect(existsSync(resolve(root, "hooks/hooks.json"))).toBe(true);
  });

  test("the OpenCode entry exists and loads from the packaged layout", async () => {
    const entry = opencodePluginEntry(plugins).replace(/^file:\/\//, "");
    expect(existsSync(entry)).toBe(true);
    const mod = await import(entry);
    expect(typeof mod.WosPlugin).toBe("function");
  });

  test("the pi entry exists and loads from the packaged layout", async () => {
    const entry = piPluginEntry(plugins);
    expect(existsSync(entry)).toBe(true);
    const mod = await import(entry);
    expect(typeof mod.default).toBe("function");
  });
});
