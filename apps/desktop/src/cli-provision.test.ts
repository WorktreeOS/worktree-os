import { test, expect } from "bun:test";
import {
  decideSymlink,
  provisionCli,
  defaultPreferredDir,
  type ProvisionEffects,
} from "./cli-provision";

const BUNDLED = "/Applications/WorktreeOS.app/Contents/Resources/bin/wos";
const PREFERRED = "/Users/x/.local/bin";

test("foreign wos on PATH → left untouched", () => {
  expect(
    decideSymlink({
      bundledWos: BUNDLED,
      existingWos: "/usr/local/bin/wos",
      existingRealpath: "/usr/local/bin/wos",
      existingIsManaged: false,
      preferredDir: PREFERRED,
      loginPath: "/usr/local/bin:/usr/bin",
    }),
  ).toEqual({ action: "skip-foreign", existing: "/usr/local/bin/wos" });
});

test("our symlink already current → skip", () => {
  expect(
    decideSymlink({
      bundledWos: BUNDLED,
      existingWos: `${PREFERRED}/wos`,
      existingRealpath: BUNDLED,
      existingIsManaged: true,
      preferredDir: PREFERRED,
      loginPath: `${PREFERRED}:/usr/bin`,
    }),
  ).toEqual({ action: "skip-current", link: `${PREFERRED}/wos` });
});

test("our managed symlink but stale (app moved) → refresh", () => {
  expect(
    decideSymlink({
      bundledWos: BUNDLED,
      existingWos: `${PREFERRED}/wos`,
      existingRealpath: "/old/path/wos",
      existingIsManaged: true,
      preferredDir: PREFERRED,
      loginPath: `${PREFERRED}:/usr/bin`,
    }),
  ).toEqual({ action: "link", link: `${PREFERRED}/wos`, target: BUNDLED });
});

test("no wos + preferred dir on PATH → link", () => {
  expect(
    decideSymlink({
      bundledWos: BUNDLED,
      existingWos: null,
      existingRealpath: null,
      existingIsManaged: false,
      preferredDir: PREFERRED,
      loginPath: `${PREFERRED}:/usr/bin`,
    }),
  ).toEqual({ action: "link", link: `${PREFERRED}/wos`, target: BUNDLED });
});

test("no wos + preferred dir NOT on PATH → notice (no dotfile edit)", () => {
  expect(
    decideSymlink({
      bundledWos: BUNDLED,
      existingWos: null,
      existingRealpath: null,
      existingIsManaged: false,
      preferredDir: PREFERRED,
      loginPath: "/usr/bin:/bin",
    }),
  ).toEqual({ action: "notice", preferredDir: PREFERRED });
});

test("defaultPreferredDir resolves ~/.local/bin", () => {
  expect(defaultPreferredDir("/Users/x")).toBe("/Users/x/.local/bin");
});

test("provisionCli links when absent and dir on PATH", async () => {
  const calls: string[] = [];
  const fx: ProvisionEffects = {
    which: async () => null,
    realpath: async () => null,
    readlink: async () => null,
    ensureDir: async (d) => void calls.push(`mkdir ${d}`),
    symlink: async (t, l) => void calls.push(`ln ${t} ${l}`),
    notify: (m) => void calls.push(`notify ${m}`),
  };
  const decision = await provisionCli(
    { bundledWos: BUNDLED, preferredDir: PREFERRED, loginPath: `${PREFERRED}:/usr/bin` },
    fx,
  );
  expect(decision.action).toBe("link");
  expect(calls).toEqual([`mkdir ${PREFERRED}`, `ln ${BUNDLED} ${PREFERRED}/wos`]);
});

test("provisionCli leaves a foreign wos and never symlinks", async () => {
  const calls: string[] = [];
  const fx: ProvisionEffects = {
    which: async () => "/usr/local/bin/wos",
    realpath: async () => "/usr/local/bin/wos",
    readlink: async () => null, // not a symlink → not managed
    ensureDir: async () => void calls.push("mkdir"),
    symlink: async () => void calls.push("ln"),
    notify: () => void calls.push("notify"),
  };
  const decision = await provisionCli(
    { bundledWos: BUNDLED, preferredDir: PREFERRED, loginPath: "/usr/local/bin" },
    fx,
  );
  expect(decision.action).toBe("skip-foreign");
  expect(calls).toEqual([]);
});

test("provisionCli notifies when no writable dir is on PATH", async () => {
  const calls: string[] = [];
  const fx: ProvisionEffects = {
    which: async () => null,
    realpath: async () => null,
    readlink: async () => null,
    ensureDir: async () => void calls.push("mkdir"),
    symlink: async () => void calls.push("ln"),
    notify: () => void calls.push("notify"),
  };
  const decision = await provisionCli(
    { bundledWos: BUNDLED, preferredDir: PREFERRED, loginPath: "/usr/bin:/bin" },
    fx,
  );
  expect(decision.action).toBe("notice");
  expect(calls).toEqual(["notify"]);
});
