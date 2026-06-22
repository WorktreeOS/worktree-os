import { describe, expect, test } from "bun:test";
import { delimiter, dirname } from "node:path";

import { prependBinaryDir } from "@worktreeos/daemon/daemon-server";

/**
 * The daemon prepends its own binary directory to a spawned session's PATH so
 * that binary-backed Claude Code hooks (`wos agent-hook <event>`) resolve `wos`
 * even when it is not on the user's global PATH.
 */
describe("prependBinaryDir", () => {
  const fakeExec = `${delimiter === ";" ? "C:\\opt\\wos" : "/opt/wos"}/bin/wos`;
  const binDir = dirname(fakeExec);

  test("prepends the binary directory to an existing PATH", () => {
    const existing = ["/usr/bin", "/bin"].join(delimiter);
    const result = prependBinaryDir(existing, fakeExec);
    expect(result.split(delimiter)[0]).toBe(binDir);
    expect(result.endsWith(existing)).toBe(true);
  });

  test("is idempotent when the binary directory is already first", () => {
    const existing = [binDir, "/usr/bin"].join(delimiter);
    expect(prependBinaryDir(existing, fakeExec)).toBe(existing);
  });

  test("returns just the binary directory when PATH is empty or unset", () => {
    expect(prependBinaryDir("", fakeExec)).toBe(binDir);
    expect(prependBinaryDir(undefined, fakeExec)).toBe(binDir);
  });

  test("defaults to the running executable's directory", () => {
    const result = prependBinaryDir("/usr/bin");
    expect(result.split(delimiter)[0]).toBe(dirname(process.execPath));
  });
});
