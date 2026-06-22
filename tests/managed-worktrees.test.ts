import { test, expect, describe, afterEach } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  deriveProjectSegment,
  managedWorktreesProjectRoot,
  managedWorktreesRoot,
  ManagedWorktreePathError,
  resolveManagedWorktreePath,
  validateManagedWorktreeName,
} from "@worktreeos/core/managed-worktrees";
import type { ProjectRecord } from "@worktreeos/core/project-registry";

const ORIGINAL_WOS_HOME = process.env.WOS_HOME;

afterEach(() => {
  if (ORIGINAL_WOS_HOME === undefined) {
    delete process.env.WOS_HOME;
  } else {
    process.env.WOS_HOME = ORIGINAL_WOS_HOME;
  }
});

function fakeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "01234567-89ab-cdef-0123-456789abcdef",
    displayName: "app",
    sourcePath: "/repos/app",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("managedWorktreesRoot", () => {
  test("defaults under ~/.wos/worktrees", () => {
    delete process.env.WOS_HOME;
    expect(managedWorktreesRoot()).toBe(
      resolve(homedir(), ".wos", "worktrees"),
    );
  });

  test("respects WOS_HOME", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    expect(managedWorktreesRoot()).toBe("/tmp/wos-home/worktrees");
  });
});

describe("deriveProjectSegment", () => {
  test("appends short id suffix to sanitized display name", () => {
    const segment = deriveProjectSegment(fakeProject({ displayName: "app" }));
    expect(segment).toBe("app-01234567");
  });

  test("sanitizes unsafe characters", () => {
    const segment = deriveProjectSegment(
      fakeProject({ displayName: "My Cool/Repo" }),
    );
    expect(segment).toBe("My-Cool-Repo-01234567");
  });

  test("falls back to id-only segment for empty/unsafe display name", () => {
    const segment = deriveProjectSegment(
      fakeProject({ displayName: "..", id: "abcdefgh" }),
    );
    expect(segment).toBe("project-abcdefgh");
  });

  test("different projects get distinct segments even with the same name", () => {
    const a = deriveProjectSegment(
      fakeProject({ displayName: "app", id: "aaaaaaaa-1111" }),
    );
    const b = deriveProjectSegment(
      fakeProject({ displayName: "app", id: "bbbbbbbb-2222" }),
    );
    expect(a).not.toBe(b);
    expect(a.startsWith("app-")).toBe(true);
    expect(b.startsWith("app-")).toBe(true);
  });
});

describe("managedWorktreesProjectRoot", () => {
  test("composes <home>/worktrees/<segment>", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    const root = managedWorktreesProjectRoot(fakeProject());
    expect(root).toBe("/tmp/wos-home/worktrees/app-01234567");
  });
});

describe("validateManagedWorktreeName", () => {
  test("accepts simple safe names", () => {
    expect(validateManagedWorktreeName("feature-a")).toEqual({
      ok: true,
      name: "feature-a",
    });
    expect(validateManagedWorktreeName("v1.2.3")).toEqual({
      ok: true,
      name: "v1.2.3",
    });
  });

  test("rejects empty / whitespace-only names", () => {
    expect(validateManagedWorktreeName("").ok).toBe(false);
    expect(validateManagedWorktreeName("   ").ok).toBe(false);
  });

  test("rejects dot segments", () => {
    expect(validateManagedWorktreeName(".").ok).toBe(false);
    expect(validateManagedWorktreeName("..").ok).toBe(false);
    expect(validateManagedWorktreeName(".hidden").ok).toBe(false);
  });

  test("rejects path separators and escapes", () => {
    expect(validateManagedWorktreeName("a/b").ok).toBe(false);
    expect(validateManagedWorktreeName("..\\b").ok).toBe(false);
    expect(validateManagedWorktreeName("../escape").ok).toBe(false);
  });

  test("rejects spaces and other unsafe characters", () => {
    expect(validateManagedWorktreeName("a b").ok).toBe(false);
    expect(validateManagedWorktreeName("a*b").ok).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(validateManagedWorktreeName(42 as unknown).ok).toBe(false);
    expect(validateManagedWorktreeName(null as unknown).ok).toBe(false);
  });
});

describe("resolveManagedWorktreePath", () => {
  test("resolves under WOS_HOME/worktrees/<segment>", () => {
    process.env.WOS_HOME = "/tmp/wos-home";
    const r = resolveManagedWorktreePath({
      record: fakeProject(),
      name: "feature-a",
    });
    expect(r.projectSegment).toBe("app-01234567");
    expect(r.projectRoot).toBe("/tmp/wos-home/worktrees/app-01234567");
    expect(r.targetPath).toBe(
      "/tmp/wos-home/worktrees/app-01234567/feature-a",
    );
  });

  test("throws on invalid name", () => {
    expect(() =>
      resolveManagedWorktreePath({ record: fakeProject(), name: "../bad" }),
    ).toThrow(ManagedWorktreePathError);
  });
});
