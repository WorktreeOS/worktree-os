import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSessionContext } from "@worktreeos/core/session-context";
import type { GitRunner } from "@worktreeos/core/git";

interface RepoLayout {
  root: string;
  source: string;
  secondary: string;
  cleanup: () => Promise<void>;
}

async function makeRepoLayout(): Promise<RepoLayout> {
  const root = await mkdtemp(join(tmpdir(), "wos-session-ctx-"));
  const source = resolve(root, "main");
  const secondary = resolve(root, "feature");
  await mkdir(source, { recursive: true });
  await mkdir(secondary, { recursive: true });
  return {
    root,
    source,
    secondary,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function makeGitRunner(opts: {
  currentRoot: string;
  source: string;
  secondary: string;
}): GitRunner {
  const { currentRoot, source, secondary } = opts;
  return async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return `${currentRoot}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      return `${source}/.git\n`;
    }
    if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
      return [
        `worktree ${source}`,
        "HEAD aaaaaaaa",
        "branch refs/heads/main",
        "",
        `worktree ${secondary}`,
        "HEAD bbbbbbbb",
        "branch refs/heads/feature",
        "",
      ].join("\n");
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

let active: RepoLayout | null = null;
afterEach(async () => {
  await active?.cleanup();
  active = null;
});

describe("resolveSessionContext source-config loading", () => {
  test("loads .wos/deploy.worktree.yaml from primary/source worktree when called from secondary", async () => {
    active = await makeRepoLayout();
    await Bun.write(
      join(active.source, ".wos", "deploy.worktree.yaml"),
      "clone_volumes:\n  - .data\napp:\n  image: node:22\n  services:\n    api:\n      ports:\n        - 3000\n",
    );
    const gitRunner = makeGitRunner({
      currentRoot: active.secondary,
      source: active.source,
      secondary: active.secondary,
    });
    const ctx = await resolveSessionContext({ cwd: active.secondary, gitRunner });
    expect(ctx.worktreeRoot).toBe(active.secondary);
    expect(ctx.source.path).toBe(active.source);
    expect(ctx.config.app.image).toBe("node:22");
    expect(ctx.config.cloneVolumes[0]?.source).toBe(".data");
  });

  test("loads source worktree deploy config even when secondary has its own file", async () => {
    active = await makeRepoLayout();
    await Bun.write(
      join(active.source, ".wos", "deploy.worktree.yaml"),
      "app:\n  image: source-image\n  services:\n    api:\n      ports:\n        - 3000\n",
    );
    // A decoy file inside the secondary checkout must be ignored: the worktree
    // deploy config is authoritative only in the source worktree.
    await Bun.write(
      join(active.secondary, ".wos", "deploy.worktree.yaml"),
      "app:\n  image: stale-secondary-image\n  services:\n    api:\n      ports:\n        - 3000\n",
    );
    const gitRunner = makeGitRunner({
      currentRoot: active.secondary,
      source: active.source,
      secondary: active.secondary,
    });
    const ctx = await resolveSessionContext({ cwd: active.secondary, gitRunner });
    expect(ctx.config.app.image).toBe("source-image");
  });

  test("fails with primary/source path in the error when worktree deploy config is missing in source", async () => {
    active = await makeRepoLayout();
    const gitRunner = makeGitRunner({
      currentRoot: active.secondary,
      source: active.source,
      secondary: active.secondary,
    });
    await expect(
      resolveSessionContext({ cwd: active.secondary, gitRunner }),
    ).rejects.toThrow(
      new RegExp(`deploy config not found at .*${active.source}.*deploy\\.worktree\\.yaml`),
    );
  });

  test("session-state and worktreeRoot stay on the secondary worktree", async () => {
    active = await makeRepoLayout();
    await Bun.write(
      join(active.source, ".wos", "deploy.worktree.yaml"),
      "clone_volumes:\n  - rel/runtime-target\napp:\n  image: node:22\n  services:\n    api:\n      ports:\n        - 3000\n",
    );
    const gitRunner = makeGitRunner({
      currentRoot: active.secondary,
      source: active.source,
      secondary: active.secondary,
    });
    const ctx = await resolveSessionContext({ cwd: active.secondary, gitRunner });
    expect(ctx.worktreeRoot).toBe(active.secondary);
    expect(ctx.sessionRoot).toContain(active.secondary.replace(/^\//, "").split("/").pop()!);
    // clone_volumes entries stay as raw relative strings: the runtime resolves
    // destinations against worktreeRoot (secondary) and sources against
    // source.path. Loading the config does not eagerly rewrite paths.
    expect(ctx.config.cloneVolumes[0]?.source).toBe("rel/runtime-target");
    expect(ctx.config.cloneVolumes[0]?.destination).toBe("rel/runtime-target");
  });
});
