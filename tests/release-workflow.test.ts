import { test, expect } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const workflowPath = resolve(repoRoot, ".github/workflows/release.yml");

test("release workflow does not configure a Windows binary target", async () => {
  const workflow = await Bun.file(workflowPath).text();
  expect(workflow).not.toContain("bun-windows-x64");
  expect(workflow).not.toContain("windows-amd64");
  expect(workflow).not.toContain(".exe");
});

test("release workflow keeps macOS arm64 and Linux amd64 binary targets", async () => {
  const workflow = await Bun.file(workflowPath).text();
  expect(workflow).toContain("bun-darwin-arm64");
  expect(workflow).toContain("macos-arm64");
  expect(workflow).toContain("bun-linux-x64");
  expect(workflow).toContain("linux-amd64");
});
