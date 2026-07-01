import { test, expect } from "bun:test";
import { pathDirs, isOnPath, loginShellPath } from "./login-path";

test("pathDirs splits and drops empties", () => {
  expect(pathDirs("/usr/bin:/bin::/sbin")).toEqual(["/usr/bin", "/bin", "/sbin"]);
  expect(pathDirs("")).toEqual([]);
  expect(pathDirs(undefined)).toEqual([]);
  expect(pathDirs(null)).toEqual([]);
});

test("isOnPath checks membership", () => {
  expect(isOnPath("/usr/bin", "/usr/bin:/bin")).toBe(true);
  expect(isOnPath("/opt/x", "/usr/bin:/bin")).toBe(false);
  expect(isOnPath("/usr/bin", null)).toBe(false);
});

test("loginShellPath parses the probed PATH from an injected runner", async () => {
  const path = await loginShellPath({
    env: { SHELL: "/bin/zsh" },
    run: async (argv) => {
      expect(argv).toEqual(["/bin/zsh", "-lic", 'printf %s "$PATH"']);
      return "/Users/x/.local/bin:/usr/bin:/bin\n";
    },
  });
  expect(path).toBe("/Users/x/.local/bin:/usr/bin:/bin");
});

test("loginShellPath returns null on empty output", async () => {
  expect(await loginShellPath({ run: async () => "  \n" })).toBeNull();
});

test("loginShellPath returns null when the probe throws", async () => {
  expect(
    await loginShellPath({
      run: async () => {
        throw new Error("spawn failed");
      },
    }),
  ).toBeNull();
});
