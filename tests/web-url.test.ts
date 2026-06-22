import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildWorktreeDetailUrl,
  resolveWorktreeDetailUrl,
} from "../apps/cli/commands/web-url";

describe("buildWorktreeDetailUrl", () => {
  test("encodes the worktree path and joins it under /worktree", () => {
    expect(
      buildWorktreeDetailUrl("http://127.0.0.1:4949", "/home/user/repo"),
    ).toBe("http://127.0.0.1:4949/worktree?path=%2Fhome%2Fuser%2Frepo");
  });

  test("strips trailing slashes from the base URL", () => {
    expect(
      buildWorktreeDetailUrl("http://127.0.0.1:4949///", "/x"),
    ).toBe("http://127.0.0.1:4949/worktree?path=%2Fx");
  });

  test("encodes paths with spaces and special characters", () => {
    expect(
      buildWorktreeDetailUrl(
        "http://127.0.0.1:4949",
        "/home/u s e r/My Repo",
      ),
    ).toBe(
      "http://127.0.0.1:4949/worktree?path=%2Fhome%2Fu%20s%20e%20r%2FMy%20Repo",
    );
  });
});

describe("resolveWorktreeDetailUrl", () => {
  let home: string;
  let metadataPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "wos-web-url-"));
    metadataPath = resolve(home, "daemon.json");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("returns null when metadata file is missing", async () => {
    const url = await resolveWorktreeDetailUrl("/x", { metadataPath });
    expect(url).toBeNull();
  });

  test("returns null when metadata is present but webUrl is missing", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({
        pid: 1,
        socketPath: "/x",
        startedAt: "t",
        protocol: "v1",
      }),
    );
    const url = await resolveWorktreeDetailUrl("/x", { metadataPath });
    expect(url).toBeNull();
  });

  test("returns the worktree detail URL when webUrl is present", async () => {
    await writeFile(
      metadataPath,
      JSON.stringify({
        pid: 1,
        socketPath: "/x",
        startedAt: "t",
        protocol: "v1",
        webUrl: "http://127.0.0.1:4949",
      }),
    );
    const url = await resolveWorktreeDetailUrl("/home/u/r", { metadataPath });
    expect(url).toBe("http://127.0.0.1:4949/worktree?path=%2Fhome%2Fu%2Fr");
  });

  test("returns null when metadata file is not valid JSON", async () => {
    await writeFile(metadataPath, "not-json-{");
    const url = await resolveWorktreeDetailUrl("/x", { metadataPath });
    expect(url).toBeNull();
  });
});
