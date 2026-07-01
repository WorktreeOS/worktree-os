import { test, expect, describe } from "bun:test";
import {
  isLoopbackHost,
  parseInitArgs,
  resolveBackendDecision,
} from "../apps/cli/commands/init-logic";
import type { PackageManagerInstall } from "@worktreeos/daemon/setup-environment";

describe("parseInitArgs", () => {
  test("parses all flags (space-separated)", () => {
    const out = parseInitArgs([
      "--host",
      "0.0.0.0",
      "--port",
      "8080",
      "--backend",
      "tmux",
      "--install-tmux",
      "--install-plugins",
      "--yes",
    ]);
    expect(out).toEqual({
      host: "0.0.0.0",
      port: 8080,
      backend: "tmux",
      installTmux: true,
      installPlugins: true,
      yes: true,
    });
  });

  test("parses --flag=value forms", () => {
    const out = parseInitArgs(["--host=127.0.0.1", "--port=4949", "--backend=default"]);
    expect(out).toEqual({
      host: "127.0.0.1",
      port: 4949,
      backend: "default",
      installTmux: false,
      installPlugins: false,
      yes: false,
    });
  });

  test("defaults flags to false with no args", () => {
    expect(parseInitArgs([])).toEqual({
      installTmux: false,
      installPlugins: false,
      yes: false,
    });
  });

  test("parses --install-plugins", () => {
    expect(parseInitArgs(["--install-plugins"])).toEqual({
      installTmux: false,
      installPlugins: true,
      yes: false,
    });
  });

  test("rejects a value attached to --install-plugins", () => {
    expect(parseInitArgs(["--install-plugins=1"])).toEqual({
      error: "--install-plugins does not take a value",
    });
  });

  test("rejects an invalid port", () => {
    expect(parseInitArgs(["--port", "abc"])).toEqual({
      error: "--port must be an integer in [1, 65535]",
    });
    expect(parseInitArgs(["--port", "70000"])).toEqual({
      error: "--port must be an integer in [1, 65535]",
    });
  });

  test("rejects an invalid backend", () => {
    expect(parseInitArgs(["--backend", "host"])).toEqual({
      error: "--backend must be 'default' or 'tmux'",
    });
  });

  test("rejects an unknown argument", () => {
    expect(parseInitArgs(["--bogus"])).toEqual({
      error: "unknown argument: --bogus",
    });
  });

  test("rejects a valued flag with no value", () => {
    expect(parseInitArgs(["--host"])).toEqual({ error: "--host requires a value" });
  });

  test("rejects a value attached to a boolean flag", () => {
    expect(parseInitArgs(["--yes=1"])).toEqual({
      error: "--yes does not take a value",
    });
  });
});

describe("resolveBackendDecision", () => {
  const pkg: PackageManagerInstall = { manager: "brew", command: "brew install tmux" };

  test("available → tmux, no warning", () => {
    expect(
      resolveBackendDecision({
        available: true,
        packageManager: null,
        installAccepted: false,
        installOk: false,
      }),
    ).toEqual({ backend: "tmux", warn: false });
  });

  test("install accepted and succeeded → tmux, no warning", () => {
    expect(
      resolveBackendDecision({
        available: false,
        packageManager: pkg,
        installAccepted: true,
        installOk: true,
      }),
    ).toEqual({ backend: "tmux", warn: false });
  });

  test("install declined → default with warning", () => {
    expect(
      resolveBackendDecision({
        available: false,
        packageManager: pkg,
        installAccepted: false,
        installOk: false,
      }),
    ).toEqual({ backend: "default", warn: true });
  });

  test("install failed → default with warning", () => {
    expect(
      resolveBackendDecision({
        available: false,
        packageManager: pkg,
        installAccepted: true,
        installOk: false,
      }),
    ).toEqual({ backend: "default", warn: true });
  });

  test("no package manager → default with warning", () => {
    expect(
      resolveBackendDecision({
        available: false,
        packageManager: null,
        installAccepted: false,
        installOk: false,
      }),
    ).toEqual({ backend: "default", warn: true });
  });
});

describe("isLoopbackHost", () => {
  test("loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  test("non-loopback addresses (including 0.0.0.0)", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});
