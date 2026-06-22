import { test, expect, describe } from "bun:test";
import { buildWindowsRestartLauncher } from "@worktreeos/daemon/daemon-server";

// `buildWindowsRestartLauncher` exists because `Bun.serve`'s listening socket
// is inheritable on Windows: a restart child spawned via `Bun.spawn` /
// `node:child_process` inherits it and pins the daemon's TCP port for its whole
// lifetime, so the replacement daemon can never bind. Launching through
// PowerShell `Start-Process` (bInheritHandles=FALSE) severs that inheritance.
// These tests lock the quoting so paths with spaces / quotes survive verbatim.
describe("buildWindowsRestartLauncher", () => {
  test("wraps a hidden Start-Process around the restart command", () => {
    const argv = buildWindowsRestartLauncher([
      "C:\\Users\\me\\.bun\\bin\\bun.exe",
      "C:\\dev\\wos\\index.ts",
      "restart",
    ]);
    expect(argv.slice(0, 4)).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    const ps = argv[4]!;
    expect(ps).toContain("Start-Process -FilePath 'C:\\Users\\me\\.bun\\bin\\bun.exe'");
    expect(ps).toContain(`-ArgumentList '"C:\\dev\\wos\\index.ts" "restart"'`);
    expect(ps).toContain("-WindowStyle Hidden");
  });

  test("double-quotes each argument so spaces in paths survive", () => {
    const ps = buildWindowsRestartLauncher([
      "C:\\Program Files\\wos\\wos.exe",
      "restart",
    ])[4]!;
    expect(ps).toContain("-FilePath 'C:\\Program Files\\wos\\wos.exe'");
    expect(ps).toContain(`-ArgumentList '"restart"'`);
  });

  test("escapes single quotes in the executable path for PowerShell", () => {
    const ps = buildWindowsRestartLauncher([
      "C:\\Users\\O'Brien\\bun.exe",
      "restart",
    ])[4]!;
    // Single quotes are doubled inside the single-quoted PowerShell string.
    expect(ps).toContain("-FilePath 'C:\\Users\\O''Brien\\bun.exe'");
  });

  test("omits -ArgumentList when there are no arguments", () => {
    const ps = buildWindowsRestartLauncher(["wos.exe"])[4]!;
    expect(ps).not.toContain("-ArgumentList");
    expect(ps).toContain("-FilePath 'wos.exe'");
  });
});
