import { describe, expect, test } from "bun:test";
import {
  deriveDirPath,
  deriveQuery,
  filterSuggestions,
  normalizeForValidation,
  parentDirOf,
} from "../apps/web/src/lib/add-project-logic";
import type { DirectorySuggestion } from "../apps/web/src/lib/ui-api";

describe("add-project: deriveDirPath", () => {
  test("returns empty for empty input", () => {
    expect(deriveDirPath("")).toBe("");
    expect(deriveDirPath("   ")).toBe("");
  });

  test("root is its own listing path", () => {
    expect(deriveDirPath("/")).toBe("/");
  });

  test("sends the full typed path as the candidate", () => {
    expect(deriveDirPath("/usr/loc")).toBe("/usr/loc");
    expect(deriveDirPath("/foo/bar/baz")).toBe("/foo/bar/baz");
    expect(deriveDirPath("/foo")).toBe("/foo");
  });

  test("collapses trailing slashes to the directory itself", () => {
    expect(deriveDirPath("/Users/")).toBe("/Users");
    expect(deriveDirPath("/var/www/")).toBe("/var/www");
    expect(deriveDirPath("/usr//")).toBe("/usr");
  });
});

describe("add-project: deriveQuery", () => {
  test("no filter when the daemon listed the candidate itself", () => {
    // Exact existing directory: listed path equals the candidate.
    expect(deriveQuery("/usr/local", "/usr/local")).toBe("");
    expect(deriveQuery("/usr/local/", "/usr/local")).toBe("");
    expect(deriveQuery("/", "/")).toBe("");
    expect(deriveQuery("", "")).toBe("");
  });

  test("partial segment becomes the filter when the parent was listed", () => {
    expect(deriveQuery("/usr/loc", "/usr")).toBe("loc");
    expect(deriveQuery("/var/www/de", "/var/www")).toBe("de");
  });
});

describe("add-project: parentDirOf", () => {
  test("returns the parent directory of a path", () => {
    expect(parentDirOf("/usr/local")).toBe("/usr");
    expect(parentDirOf("/foo")).toBe("/");
    expect(parentDirOf("/")).toBe("/");
  });
});

describe("add-project: filterSuggestions", () => {
  const entries: DirectorySuggestion[] = [
    { path: "/a/alpha", name: "alpha", isGitWorktree: false },
    { path: "/a/Beta", name: "Beta", isGitWorktree: true },
    { path: "/a/gamma", name: "gamma", isGitWorktree: false },
  ];

  test("empty query returns all entries", () => {
    expect(filterSuggestions(entries, "")).toEqual(entries);
  });

  test("prefix match is case insensitive", () => {
    expect(filterSuggestions(entries, "be")).toEqual([entries[1]!]);
    expect(filterSuggestions(entries, "A")).toEqual([entries[0]!]);
  });

  test("non-matching query returns empty list", () => {
    expect(filterSuggestions(entries, "zzz")).toEqual([]);
  });
});

describe("add-project: normalizeForValidation", () => {
  test("strips whitespace and trailing slashes", () => {
    expect(normalizeForValidation("  /tmp/repo/  ")).toBe("/tmp/repo");
    expect(normalizeForValidation("/tmp/repo")).toBe("/tmp/repo");
    expect(normalizeForValidation("/tmp/repo///")).toBe("/tmp/repo");
    expect(normalizeForValidation("/")).toBe("");
  });
});

describe("add-project: module surface", () => {
  test("AddProjectModal loads as a React component", async () => {
    const mod = await import("../apps/web/src/components/add-project-modal");
    expect(typeof mod.AddProjectModal).toBe("function");
  });
});
