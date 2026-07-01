import { test, expect, describe } from "bun:test";
import {
  OUTSIDE_TMUX_WARNING,
  detectPackageManager,
  managerRequiresElevation,
  selectNextFreePort,
} from "@worktreeos/daemon/setup-environment";

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

describe("managerRequiresElevation", () => {
  test("no-sudo managers do not require elevation", () => {
    expect(managerRequiresElevation("brew")).toBe(false);
    expect(managerRequiresElevation("winget")).toBe(false);
    expect(managerRequiresElevation("scoop")).toBe(false);
  });

  test("sudo managers require elevation", () => {
    expect(managerRequiresElevation("apt")).toBe(true);
    expect(managerRequiresElevation("dnf")).toBe(true);
    expect(managerRequiresElevation("pacman")).toBe(true);
  });
});

describe("OUTSIDE_TMUX_WARNING", () => {
  test("exact copy", () => {
    expect(OUTSIDE_TMUX_WARNING).toBe(
      "Running outside tmux/psmux — terminal sessions may be unstable.",
    );
  });
});
