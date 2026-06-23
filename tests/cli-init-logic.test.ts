import { test, expect, describe } from "bun:test";
import {
  OUTSIDE_TMUX_WARNING,
  detectPackageManager,
  isLoopbackHost,
  parseInitArgs,
  requiresConfig,
  resolveBackendDecision,
  selectNextFreePort,
  type PackageManagerInstall,
} from "../apps/cli/commands/init-logic";

/** Build a `which` lookup that resolves only the named binaries. */
function whichFrom(...present: string[]): (name: string) => string | null {
  const set = new Set(present);
  return (name) => (set.has(name) ? `/usr/bin/${name}` : null);
}

describe("selectNextFreePort", () => {
  test("returns start when start is free", () => {
    expect(selectNextFreePort(4949, () => true)).toBe(4949);
  });

  test("returns the next free port when start is taken", () => {
    const taken = new Set([4949]);
    expect(selectNextFreePort(4949, (p) => !taken.has(p))).toBe(4950);
  });

  test("skips a run of taken ports", () => {
    expect(selectNextFreePort(4949, (p) => p >= 4952)).toBe(4952);
  });

  test("falls back to start when nothing in range is free", () => {
    expect(selectNextFreePort(65534, () => false)).toBe(65534);
  });
});

describe("detectPackageManager", () => {
  test("darwin prefers brew", () => {
    expect(detectPackageManager("darwin", whichFrom("brew"))).toEqual({
      manager: "brew",
      command: "brew install tmux",
    });
  });

  test("darwin returns null when brew is absent", () => {
    expect(detectPackageManager("darwin", whichFrom())).toBeNull();
  });

  test("linux prefers apt (apt-get binary)", () => {
    expect(detectPackageManager("linux", whichFrom("apt-get", "dnf"))).toEqual({
      manager: "apt",
      command: "sudo apt-get install -y tmux",
    });
  });

  test("linux falls back to dnf", () => {
    expect(detectPackageManager("linux", whichFrom("dnf"))).toEqual({
      manager: "dnf",
      command: "sudo dnf install -y tmux",
    });
  });

  test("linux falls back to pacman", () => {
    expect(detectPackageManager("linux", whichFrom("pacman"))).toEqual({
      manager: "pacman",
      command: "sudo pacman -S --noconfirm tmux",
    });
  });

  test("linux uses brew when only linuxbrew is present", () => {
    expect(detectPackageManager("linux", whichFrom("brew"))).toEqual({
      manager: "brew",
      command: "brew install tmux",
    });
  });

  test("win32 prefers winget (installs psmux)", () => {
    expect(detectPackageManager("win32", whichFrom("winget", "scoop"))).toEqual({
      manager: "winget",
      command: "winget install psmux",
    });
  });

  test("win32 falls back to scoop", () => {
    expect(detectPackageManager("win32", whichFrom("scoop"))).toEqual({
      manager: "scoop",
      command: "scoop install psmux",
    });
  });

  test("win32 returns null when no manager is present", () => {
    expect(detectPackageManager("win32", whichFrom())).toBeNull();
  });
});

describe("requiresConfig", () => {
  test("wizard entrypoints and help are exempt", () => {
    expect(requiresConfig(undefined)).toBe(false);
    expect(requiresConfig("init")).toBe(false);
    expect(requiresConfig("help")).toBe(false);
    expect(requiresConfig("-h")).toBe(false);
    expect(requiresConfig("--help")).toBe(false);
  });

  test("all other commands require config", () => {
    for (const cmd of ["up", "down", "status", "start", "web", "worktree", "bogus"]) {
      expect(requiresConfig(cmd)).toBe(true);
    }
  });
});

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

describe("OUTSIDE_TMUX_WARNING", () => {
  test("exact copy", () => {
    expect(OUTSIDE_TMUX_WARNING).toBe(
      "Running outside tmux/psmux — terminal sessions may be unstable.",
    );
  });
});
