import { describe, expect, test } from "bun:test";
import { decideWorktreeOpen, worktreeRouteUrl } from "./worktree-open";

const PATH = "/repo/feature-x";
const ENC = encodeURIComponent(PATH);

describe("decideWorktreeOpen — terminal entry", () => {
  test("always navigates full-screen, even off the worktree route", () => {
    expect(
      decideWorktreeOpen({
        entry: "terminal",
        path: PATH,
        pathname: "/board",
        terminalSessionId: "sess-1",
      }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}&terminal=sess-1` });
  });

  test("navigates full-screen with no session id when none given", () => {
    expect(
      decideWorktreeOpen({ entry: "terminal", path: PATH, pathname: "/board" }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}` });
  });

  test("navigates full-screen even when already on the worktree route", () => {
    expect(
      decideWorktreeOpen({
        entry: "terminal",
        path: PATH,
        pathname: "/worktree",
        terminalSessionId: "sess-2",
      }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}&terminal=sess-2` });
  });
});

describe("decideWorktreeOpen — worktree entry", () => {
  test("opens the panel when off the worktree route", () => {
    expect(
      decideWorktreeOpen({ entry: "worktree", path: PATH, pathname: "/board" }),
    ).toEqual({ kind: "panel", tab: undefined });
  });

  test("opens the panel from the home route", () => {
    expect(
      decideWorktreeOpen({ entry: "worktree", path: PATH, pathname: "/" }),
    ).toEqual({ kind: "panel", tab: undefined });
  });

  test("swaps the path when already on the worktree route", () => {
    expect(
      decideWorktreeOpen({
        entry: "worktree",
        path: PATH,
        pathname: "/worktree",
      }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}` });
  });

  test("an explicit tab forces the panel destination (board → overview)", () => {
    expect(
      decideWorktreeOpen({
        entry: "worktree",
        path: PATH,
        pathname: "/board",
        tab: "overview",
      }),
    ).toEqual({ kind: "panel", tab: "overview" });
  });

  test("an explicit tab rides the swap when already on the worktree route", () => {
    expect(
      decideWorktreeOpen({
        entry: "worktree",
        path: PATH,
        pathname: "/worktree",
        tab: "overview",
      }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}&panel=overview` });
  });

  test("navigates full-screen from the /select placeholder instead of docking", () => {
    expect(
      decideWorktreeOpen({ entry: "worktree", path: PATH, pathname: "/select" }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}` });
  });
});

describe("decideWorktreeOpen — runtime entry", () => {
  test("opens the panel on the runtime tab when off the worktree route", () => {
    expect(
      decideWorktreeOpen({ entry: "runtime", path: PATH, pathname: "/board" }),
    ).toEqual({ kind: "panel", tab: "runtime" });
  });

  test("swaps the path with the runtime handoff when on the worktree route", () => {
    expect(
      decideWorktreeOpen({
        entry: "runtime",
        path: PATH,
        pathname: "/worktree",
      }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}&panel=runtime` });
  });

  test("navigates full-screen with the runtime handoff from /select", () => {
    expect(
      decideWorktreeOpen({ entry: "runtime", path: PATH, pathname: "/select" }),
    ).toEqual({ kind: "navigate", url: `/worktree?path=${ENC}&panel=runtime` });
  });
});

describe("worktreeRouteUrl — expand target", () => {
  // Expand promotes the panel's worktree to the full-screen route, then the
  // panel host clears the ephemeral selection. The URL the host navigates to is
  // built here; the "then-clear" is host behaviour verified manually.
  test("builds the bare full-screen URL the expand control navigates to", () => {
    expect(worktreeRouteUrl(PATH)).toBe(`/worktree?path=${ENC}`);
  });

  test("builds a tab-selecting URL when a panel param is given", () => {
    expect(worktreeRouteUrl(PATH, { panel: "runtime" })).toBe(
      `/worktree?path=${ENC}&panel=runtime`,
    );
  });

  test("the expand URL matches the on-route swap URL for the same path", () => {
    const swap = decideWorktreeOpen({
      entry: "worktree",
      path: PATH,
      pathname: "/worktree",
    });
    expect(swap).toEqual({ kind: "navigate", url: worktreeRouteUrl(PATH) });
  });
});
