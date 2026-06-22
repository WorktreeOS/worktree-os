import { describe, expect, test } from "bun:test";
import { worktreeLabel } from "../apps/web/src/lib/sidebar-labels";
import type { WorktreeSummary } from "../apps/web/src/lib/ui-api";

function wt(extra: Partial<WorktreeSummary>): WorktreeSummary {
  return {
    path: "/repo/feature",
    detached: false,
    isSource: false,
    sessionName: "feature",
    status: "not_started",
    ...extra,
  };
}

describe("worktreeLabel display-name preference", () => {
  test("prefers displayName when present", () => {
    expect(
      worktreeLabel(wt({ displayName: "Checkout redesign", branch: "feature" })),
    ).toBe("Checkout redesign");
  });

  test("falls back to branch when displayName is missing", () => {
    expect(worktreeLabel(wt({ branch: "feature" }))).toBe("feature");
  });

  test("falls back to short HEAD when no branch or displayName", () => {
    expect(worktreeLabel(wt({ head: "abcdef1234" }))).toBe("abcdef1");
  });

  test("falls back to path when nothing else is set", () => {
    expect(worktreeLabel(wt({ path: "/repo/feature" }))).toBe(
      "/repo/feature",
    );
  });

  test("ignores empty displayName", () => {
    expect(
      worktreeLabel(wt({ displayName: "", branch: "feature" })),
    ).toBe("feature");
  });
});
