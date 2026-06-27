import { describe, expect, test } from "bun:test";

import { isBunRuntime } from "@worktreeos/daemon/launch-mode";

// The CLI entry (`apps/cli/index.ts`) guards on `process.versions.bun` before
// any Bun-only API. `isBunRuntime` is the same predicate, unit-tested for both
// branches so a non-Bun runtime is guaranteed to take the exit path.
describe("CLI Bun runtime guard predicate", () => {
  test("passes when the Bun marker is present", () => {
    expect(isBunRuntime({ bun: "1.3.14" })).toBe(true);
  });

  test("fails when the Bun marker is absent (the exit path)", () => {
    expect(isBunRuntime({ node: "22.0.0" })).toBe(false);
    expect(isBunRuntime({})).toBe(false);
    expect(isBunRuntime({ bun: "" })).toBe(false);
  });

  test("the live runtime under `bun test` is recognized as Bun", () => {
    expect(isBunRuntime()).toBe(true);
  });
});
