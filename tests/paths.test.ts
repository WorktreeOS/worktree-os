import { test, expect, describe, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  wosCacheRoot,
  wosHome,
  sessionComposePath,
  sessionNameForWorktree,
  sessionRootForWorktree,
  sessionStatePath,
} from "@worktreeos/core/paths";

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;

// These tests assert POSIX path-string derivation from POSIX absolute inputs
// (`/var/www/...`, `/tmp/wos-home`). On Windows `resolve()` drive-prefixes such
// inputs, so the derived strings legitimately differ — the Windows behavior is
// covered by the "Windows-style paths" / drive-letter blocks below.
const posixOnly = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  if (ORIGINAL_WOS_HOME === undefined) {
    delete process.env.WOS_HOME;
  } else {
    process.env.WOS_HOME = ORIGINAL_WOS_HOME;
  }
});

describe("wosHome", () => {
  test("defaults to ~/.wos when WOS_HOME is unset", () => {
    delete process.env.WOS_HOME;
    expect(wosHome()).toBe(resolve(homedir(), ".wos"));
  });

  posixOnly("uses WOS_HOME when set", () => {
    process.env.WOS_HOME = "/custom/wos-home";
    expect(wosHome()).toBe("/custom/wos-home");
  });

  test("expands leading ~/ in WOS_HOME", () => {
    process.env.WOS_HOME = "~/custom-wos";
    expect(wosHome()).toBe(resolve(homedir(), "custom-wos"));
  });

  test("expands bare ~ in WOS_HOME", () => {
    process.env.WOS_HOME = "~";
    expect(wosHome()).toBe(homedir());
  });
});

describe("wosCacheRoot", () => {
  posixOnly("is <wosHome>/cache", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    expect(wosCacheRoot()).toBe("/tmp/wos-home/cache");
  });

  test("defaults to ~/.wos/cache when WOS_HOME is unset", () => {
    delete process.env.WOS_HOME;
    expect(wosCacheRoot()).toBe(resolve(homedir(), ".wos", "cache"));
  });
});

describe("sessionNameForWorktree", () => {
  posixOnly("derives `var-www-repo-path` from /var/www/repo-path", () => {
    expect(sessionNameForWorktree("/var/www/repo-path")).toBe("var-www-repo-path");
  });

  posixOnly("returns single segment for /repo", () => {
    expect(sessionNameForWorktree("/repo")).toBe("repo");
  });

  posixOnly("preserves dashes within segments", () => {
    expect(sessionNameForWorktree("/var/www/my-cool-repo")).toBe(
      "var-www-my-cool-repo",
    );
  });
});

describe("sessionNameForWorktree on Windows-style paths", () => {
  test("drive-letter path yields a hashed name without colon or backslash", () => {
    const name = sessionNameForWorktree("C:\\Users\\dev\\repo");
    expect(name).toMatch(/^C-Users-dev-repo--[0-9a-f]{10}$/);
  });

  test("backslash and forward-slash forms of the same path agree", () => {
    expect(sessionNameForWorktree("C:/Users/dev/repo")).toBe(
      sessionNameForWorktree("C:\\Users\\dev\\repo"),
    );
  });

  test("drive letter case does not change the name", () => {
    expect(sessionNameForWorktree("c:\\Users\\dev\\repo")).toBe(
      sessionNameForWorktree("C:\\Users\\dev\\repo"),
    );
  });

  test("different drives yield different names", () => {
    expect(sessionNameForWorktree("C:\\repo")).not.toBe(
      sessionNameForWorktree("D:\\repo"),
    );
  });
});

describe("sessionNameForWorktree sanitization", () => {
  posixOnly("reserved characters are replaced and hashed", () => {
    const name = sessionNameForWorktree("/var/www/repo?one");
    expect(name).toMatch(/^var-www-repo-one--[0-9a-f]{10}$/);
  });

  test("trailing dot is hashed away", () => {
    const name = sessionNameForWorktree("/var/www/repo.");
    expect(name).toMatch(/--[0-9a-f]{10}$/);
    expect(name.endsWith(".")).toBe(false);
  });

  test("trailing space is hashed away", () => {
    const name = sessionNameForWorktree("/var/www/repo ");
    expect(name).toMatch(/--[0-9a-f]{10}$/);
    expect(name).not.toContain(" ");
  });

  test("collision-prone siblings stay distinct", () => {
    const a = sessionNameForWorktree("/var/www/repo?a");
    const b = sessionNameForWorktree("/var/www/repo*a");
    expect(a).not.toBe(b);
  });

  test("hashed names are stable across calls", () => {
    expect(sessionNameForWorktree("C:\\Users\\dev\\repo")).toBe(
      sessionNameForWorktree("C:\\Users\\dev\\repo"),
    );
  });
});

describe("sessionNameForWorktree legacy directory preservation", () => {
  posixOnly("existing legacy session directory keeps its unsafe legacy name", () => {
    const home = mkdtempSync(join(tmpdir(), "wos-paths-"));
    try {
      process.env.WOS_HOME = home;
      const legacyName = "var-www-repo one";
      mkdirSync(join(home, "sessions", legacyName), { recursive: true });
      expect(sessionNameForWorktree("/var/www/repo one")).toBe(legacyName);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  posixOnly("without a legacy directory the unsafe name is hashed", () => {
    const home = mkdtempSync(join(tmpdir(), "wos-paths-"));
    try {
      process.env.WOS_HOME = home;
      const name = sessionNameForWorktree("/var/www/repo one");
      expect(name).toMatch(/^var-www-repo-one--[0-9a-f]{10}$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("sessionRootForWorktree / sessionComposePath / sessionStatePath", () => {
  posixOnly("compose path is <wosHome>/sessions/<name>/compose.yaml", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    expect(sessionRootForWorktree("/var/www/repo-path")).toBe(
      "/tmp/wos-home/sessions/var-www-repo-path",
    );
    expect(sessionComposePath("/var/www/repo-path")).toBe(
      "/tmp/wos-home/sessions/var-www-repo-path/compose.yaml",
    );
  });

  posixOnly("state path is <wosHome>/sessions/<name>/state.json", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    expect(sessionStatePath("/var/www/repo-path")).toBe(
      "/tmp/wos-home/sessions/var-www-repo-path/state.json",
    );
  });
});
