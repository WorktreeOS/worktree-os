import { test, expect } from "bun:test";
import { webAssetRoot, bundledWosPath, pluginRoot, pluginsDir } from "./resources";

const R = "/Applications/WorktreeOS.app/Contents/Resources";

// Electrobun nests all `build.copy` output under `Resources/app/`.
test("webAssetRoot", () => {
  expect(webAssetRoot(R)).toBe(`${R}/app/web`);
});

test("bundledWosPath", () => {
  expect(bundledWosPath(R)).toBe(`${R}/app/bin/wos`);
});

test("pluginRoot per agent", () => {
  expect(pluginRoot(R, "claude")).toBe(`${R}/app/plugins/plugin-claude`);
  expect(pluginRoot(R, "codex")).toBe(`${R}/app/plugins/plugin-codex`);
  expect(pluginRoot(R, "opencode")).toBe(`${R}/app/plugins/plugin-opencode`);
  expect(pluginRoot(R, "pi")).toBe(`${R}/app/plugins/plugin-pi`);
});

test("pluginsDir", () => {
  expect(pluginsDir(R)).toBe(`${R}/app/plugins`);
});
