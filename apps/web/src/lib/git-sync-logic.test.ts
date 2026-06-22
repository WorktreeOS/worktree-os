import { test, expect, describe } from "bun:test";
import {
  deriveSyncControls,
  deriveSyncPosture,
  freshnessLabel,
} from "./git-sync-logic";

describe("deriveSyncPosture", () => {
  test("level branch is up to date", () => {
    const p = deriveSyncPosture({ detached: false, aheadCount: 0, behindCount: 0 });
    expect(p.word).toBe("up to date");
    expect(p.tone).toBe("good");
    expect(p.hasUpstream).toBe(true);
  });

  test("ahead-only branch reports ahead", () => {
    const p = deriveSyncPosture({ detached: false, aheadCount: 3, behindCount: 0 });
    expect(p.word).toBe("ahead");
    expect(p.tone).toBe("neutral");
    expect(p.ahead).toBe(3);
    expect(p.behind).toBe(0);
  });

  test("behind-only branch reports behind", () => {
    const p = deriveSyncPosture({ detached: false, aheadCount: 0, behindCount: 2 });
    expect(p.word).toBe("behind");
    expect(p.tone).toBe("warn");
    expect(p.behind).toBe(2);
  });

  test("ahead and behind reports diverged", () => {
    const p = deriveSyncPosture({ detached: false, aheadCount: 1, behindCount: 4 });
    expect(p.word).toBe("diverged");
    expect(p.tone).toBe("bad");
    expect(p.ahead).toBe(1);
    expect(p.behind).toBe(4);
  });

  test("detached HEAD has no upstream", () => {
    const p = deriveSyncPosture({ detached: true, aheadCount: 1, behindCount: 0 });
    expect(p.word).toBe("no upstream");
    expect(p.tone).toBe("muted");
    expect(p.hasUpstream).toBe(false);
  });

  test("missing counts (no upstream tracking) has no upstream", () => {
    const p = deriveSyncPosture({ detached: false });
    expect(p.word).toBe("no upstream");
    expect(p.hasUpstream).toBe(false);
    expect(p.ahead).toBe(0);
    expect(p.behind).toBe(0);
  });
});

describe("deriveSyncControls", () => {
  test("push gated off when level with upstream", () => {
    const posture = deriveSyncPosture({ detached: false, aheadCount: 0, behindCount: 0 });
    const c = deriveSyncControls(posture, { busy: false });
    expect(c.canFetch).toBe(true);
    expect(c.canPush).toBe(false);
  });

  test("push enabled when ahead", () => {
    const posture = deriveSyncPosture({ detached: false, aheadCount: 2, behindCount: 0 });
    const c = deriveSyncControls(posture, { busy: false });
    expect(c.canPush).toBe(true);
  });

  test("push enabled when diverged (rejection prompts fetch)", () => {
    const posture = deriveSyncPosture({ detached: false, aheadCount: 1, behindCount: 1 });
    const c = deriveSyncControls(posture, { busy: false });
    expect(c.canPush).toBe(true);
  });

  test("both actions disabled while busy", () => {
    const posture = deriveSyncPosture({ detached: false, aheadCount: 2, behindCount: 0 });
    const c = deriveSyncControls(posture, { busy: true });
    expect(c.canFetch).toBe(false);
    expect(c.canPush).toBe(false);
  });

  test("no-upstream branch can fetch but not push", () => {
    const posture = deriveSyncPosture({ detached: true });
    const c = deriveSyncControls(posture, { busy: false });
    expect(c.canFetch).toBe(true);
    expect(c.canPush).toBe(false);
  });
});

describe("freshnessLabel", () => {
  test("null before any fetch", () => {
    expect(freshnessLabel(null)).toBeNull();
  });

  test("just now under a minute", () => {
    const now = 1_000_000;
    expect(freshnessLabel(now - 5_000, now)).toBe("fetched just now");
  });

  test("minutes ago", () => {
    const now = 1_000_000;
    expect(freshnessLabel(now - 5 * 60_000, now)).toBe("fetched 5m ago");
  });

  test("hours ago", () => {
    const now = 10_000_000;
    expect(freshnessLabel(now - 2 * 3_600_000, now)).toBe("fetched 2h ago");
  });

  test("days ago", () => {
    const now = 1_000_000_000;
    expect(freshnessLabel(now - 3 * 86_400_000, now)).toBe("fetched 3d ago");
  });
});
