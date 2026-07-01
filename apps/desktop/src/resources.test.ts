import { test, expect } from "bun:test";
import { webAssetRoot, bundledWosPath, pluginRoot, pluginsDir } from "./resources";

const R = "/Applications/WorktreeOS.app/Contents/Resources";

test("webAssetRoot", () => {
  expect(webAssetRoot(R)).toBe(`${R}/web`);
});

test("bundledWosPath", () => {
  expect(bundledWosPath(R)).toBe(`${R}/bin/wos`);
});

test("pluginRoot per agent", () => {
  expect(pluginRoot(R, "claude")).toBe(`${R}/plugins/plugin-claude`);
  expect(pluginRoot(R, "codex")).toBe(`${R}/plugins/plugin-codex`);
  expect(pluginRoot(R, "opencode")).toBe(`${R}/plugins/plugin-opencode`);
  expect(pluginRoot(R, "pi")).toBe(`${R}/plugins/plugin-pi`);
});

test("pluginsDir", () => {
  expect(pluginsDir(R)).toBe(`${R}/plugins`);
});
