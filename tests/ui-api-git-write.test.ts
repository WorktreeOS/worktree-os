import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { push } from "@worktreeos/core/git";
import { createUiApiHandler } from "@worktreeos/daemon/ui-api";
import { OperationRegistry } from "@worktreeos/daemon/operation-registry";
import { DaemonSessionRegistry } from "@worktreeos/daemon/daemon-sessions";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import { LlmError } from "@worktreeos/core/llm";
import {
  defaultGlobalConfig,
  type GlobalConfig,
} from "@worktreeos/core/global-config";
import type {
  WorktreeGitBranchResponse,
  WorktreeGitCommitResponse,
  WorktreeGitFetchResponse,
  WorktreeGitPushResponse,
  WorktreeCommitMessageResponse,
  GitWriteErrorBody,
} from "@worktreeos/daemon/ui-protocol";

let root: string;

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wos-uiapi-git-"));
  const r = await realpath(dir);
  await Bun.$`git init -q ${r}`.quiet();
  await Bun.$`git -C ${r} config user.email t@t.t`.quiet();
  await Bun.$`git -C ${r} config user.name t`.quiet();
  await Bun.$`git -C ${r} config commit.gpgsign false`.quiet();
  await writeFile(join(r, "seed.txt"), "seed\n");
  await Bun.$`git -C ${r} add seed.txt`.quiet();
  await Bun.$`git -C ${r} commit -q -m init`.quiet();
  return r;
}

function makeHandler(opts: {
  commitMessageConfigLoader?: () => Promise<GlobalConfig>;
  commitMessageGenerator?: any;
} = {}) {
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    ...opts,
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  root = await makeTempGitRepo();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("UI API: git stage/unstage", () => {
  test("stages and unstages files", async () => {
    const handler = makeHandler();
    await writeFile(join(root, "a.txt"), "a\n");

    const stageRes = await handler(
      post("/ui/v1/worktrees/git/stage", { path: root, files: ["a.txt"] }),
    );
    expect(stageRes!.status).toBe(200);
    let staged = (
      await Bun.$`git -C ${root} diff --cached --name-only`.text()
    ).trim();
    expect(staged).toBe("a.txt");

    const unstageRes = await handler(
      post("/ui/v1/worktrees/git/unstage", { path: root, files: ["a.txt"] }),
    );
    expect(unstageRes!.status).toBe(200);
    staged = (await Bun.$`git -C ${root} diff --cached --name-only`.text()).trim();
    expect(staged).toBe("");
  });

  test("stage validates the request body", async () => {
    const handler = makeHandler();
    const res = await handler(
      post("/ui/v1/worktrees/git/stage", { path: root, files: "nope" }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("validation");
  });

  test("stage all (git add --all) stages every change without a file list", async () => {
    const handler = makeHandler();
    await writeFile(join(root, "seed.txt"), "seed-changed\n"); // modification
    await writeFile(join(root, "new.txt"), "new\n"); // untracked

    const res = await handler(
      post("/ui/v1/worktrees/git/stage", { path: root, files: [], all: true }),
    );
    expect(res!.status).toBe(200);
    const staged = (
      await Bun.$`git -C ${root} diff --cached --name-only`.text()
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .sort();
    expect(staged).toEqual(["new.txt", "seed.txt"]);
  });

  test("stage preserves the git failure for an escaping pathspec", async () => {
    const handler = makeHandler();
    const res = await handler(
      post("/ui/v1/worktrees/git/stage", { path: root, files: ["../x"] }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("git-error");
  });
});

describe("UI API: git commit", () => {
  test("commits staged changes", async () => {
    const handler = makeHandler();
    await writeFile(join(root, "a.txt"), "a\n");
    await Bun.$`git -C ${root} add a.txt`.quiet();

    const res = await handler(
      post("/ui/v1/worktrees/git/commit", { path: root, message: "feat: a" }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeGitCommitResponse;
    expect(body.sha.length).toBeGreaterThan(0);
    const subject = await Bun.$`git -C ${root} log -1 --pretty=%s`.text();
    expect(subject.trim()).toBe("feat: a");
  });

  test("nothing-staged is distinguishable from a git error", async () => {
    const handler = makeHandler();
    const res = await handler(
      post("/ui/v1/worktrees/git/commit", { path: root, message: "noop" }),
    );
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("nothing-staged");
  });

  test("commits on a detached HEAD", async () => {
    const handler = makeHandler();
    const sha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.$`git -C ${root} checkout -q --detach ${sha}`.quiet();
    await writeFile(join(root, "a.txt"), "a\n");
    await Bun.$`git -C ${root} add a.txt`.quiet();

    const res = await handler(
      post("/ui/v1/worktrees/git/commit", { path: root, message: "detached" }),
    );
    expect(res!.status).toBe(200);
    const head = (
      await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
    ).trim();
    expect(head).toBe("HEAD");
  });
});

describe("UI API: git branch", () => {
  test("creates and switches to a branch", async () => {
    const handler = makeHandler();
    const sha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.$`git -C ${root} checkout -q --detach ${sha}`.quiet();

    const res = await handler(
      post("/ui/v1/worktrees/git/branch", { path: root, name: "work/x" }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeGitBranchResponse;
    expect(body.head.detached).toBe(false);
    expect(body.head.branch).toBe("work/x");
  });

  test("preserves the git failure for an existing branch", async () => {
    const handler = makeHandler();
    const current = (
      await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
    ).trim();
    const res = await handler(
      post("/ui/v1/worktrees/git/branch", { path: root, name: current }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("git-error");
  });
});

describe("UI API: git fetch", () => {
  test("returns recomputed ahead/behind posture", async () => {
    const handler = makeHandler();
    const bareDir = await mkdtemp(join(tmpdir(), "wos-uiapi-fetch-"));
    const bare = await realpath(bareDir);
    const otherDir = await mkdtemp(join(tmpdir(), "wos-uiapi-fetch-other-"));
    const other = await realpath(otherDir);
    try {
      await Bun.$`git init -q --bare ${bare}`.quiet();
      await Bun.$`git -C ${root} remote add origin ${bare}`.quiet();
      await push(root, { setUpstream: true });

      // A second clone advances the remote so our worktree falls behind by one.
      await Bun.$`git clone -q ${bare} ${other}`.quiet();
      await Bun.$`git -C ${other} config user.email t@t.t`.quiet();
      await Bun.$`git -C ${other} config user.name t`.quiet();
      await Bun.$`git -C ${other} config commit.gpgsign false`.quiet();
      await writeFile(join(other, "remote.txt"), "remote\n");
      await Bun.$`git -C ${other} add remote.txt`.quiet();
      await Bun.$`git -C ${other} commit -q -m remote`.quiet();
      await Bun.$`git -C ${other} push -q`.quiet();

      const res = await handler(
        post("/ui/v1/worktrees/git/fetch", { path: root }),
      );
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as WorktreeGitFetchResponse;
      expect(body.ok).toBe(true);
      expect(body.aheadCount).toBe(0);
      expect(body.behindCount).toBe(1);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  test("omits ahead/behind counts when the branch has no upstream", async () => {
    const handler = makeHandler();
    const res = await handler(
      post("/ui/v1/worktrees/git/fetch", { path: root }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeGitFetchResponse;
    expect(body.ok).toBe(true);
    expect(body.aheadCount).toBeUndefined();
    expect(body.behindCount).toBeUndefined();
  });

  test("validates the request body", async () => {
    const handler = makeHandler();
    const res = await handler(post("/ui/v1/worktrees/git/fetch", {}));
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("validation");
  });
});

describe("UI API: git push", () => {
  test("pushes already-committed work and returns posture", async () => {
    const handler = makeHandler();
    const bareDir = await mkdtemp(join(tmpdir(), "wos-uiapi-push-"));
    const bare = await realpath(bareDir);
    try {
      await Bun.$`git init -q --bare ${bare}`.quiet();
      await Bun.$`git -C ${root} remote add origin ${bare}`.quiet();
      await push(root, { setUpstream: true });

      // Commit locally so the branch is one ahead, then push via the endpoint.
      await writeFile(join(root, "a.txt"), "a\n");
      await Bun.$`git -C ${root} add a.txt`.quiet();
      await Bun.$`git -C ${root} commit -q -m local`.quiet();

      const res = await handler(
        post("/ui/v1/worktrees/git/push", { path: root }),
      );
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as WorktreeGitPushResponse;
      expect(body.ok).toBe(true);
      expect(body.aheadCount).toBe(0);
      expect(body.behindCount).toBe(0);

      const branch = (
        await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
      ).trim();
      const remoteSha = (await Bun.$`git -C ${bare} rev-parse ${branch}`.text()).trim();
      const localSha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
      expect(remoteSha).toBe(localSha);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("surfaces a non-fast-forward rejection as a structured error", async () => {
    const handler = makeHandler();
    const bareDir = await mkdtemp(join(tmpdir(), "wos-uiapi-push-ff-"));
    const bare = await realpath(bareDir);
    const otherDir = await mkdtemp(join(tmpdir(), "wos-uiapi-push-ff-other-"));
    const other = await realpath(otherDir);
    try {
      await Bun.$`git init -q --bare ${bare}`.quiet();
      await Bun.$`git -C ${root} remote add origin ${bare}`.quiet();
      await push(root, { setUpstream: true });

      // The remote advances out from under us.
      await Bun.$`git clone -q ${bare} ${other}`.quiet();
      await Bun.$`git -C ${other} config user.email t@t.t`.quiet();
      await Bun.$`git -C ${other} config user.name t`.quiet();
      await Bun.$`git -C ${other} config commit.gpgsign false`.quiet();
      await writeFile(join(other, "remote.txt"), "remote\n");
      await Bun.$`git -C ${other} add remote.txt`.quiet();
      await Bun.$`git -C ${other} commit -q -m remote`.quiet();
      await Bun.$`git -C ${other} push -q`.quiet();

      // We commit on top of the stale base → push is not a fast-forward.
      await writeFile(join(root, "local.txt"), "local\n");
      await Bun.$`git -C ${root} add local.txt`.quiet();
      await Bun.$`git -C ${root} commit -q -m local`.quiet();

      const res = await handler(
        post("/ui/v1/worktrees/git/push", { path: root }),
      );
      expect(res!.status).toBe(409);
      const body = (await res!.json()) as GitWriteErrorBody;
      expect(body.error).toBe("non-fast-forward");
      expect(body.message.length).toBeGreaterThan(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("UI API: commit-message generation", () => {
  function configWithProvider(): GlobalConfig {
    return {
      ...defaultGlobalConfig(),
      aiProviders: [{ type: "anthropic", apiKey: "k", name: "work" }],
    };
  }

  test("generates a message from the staged diff", async () => {
    await writeFile(join(root, "a.txt"), "a\n");
    await Bun.$`git -C ${root} add a.txt`.quiet();
    let receivedDiff = "";
    const handler = makeHandler({
      commitMessageConfigLoader: async () => configWithProvider(),
      commitMessageGenerator: async (params: any) => {
        receivedDiff = params.diff;
        return "feat: generated";
      },
    });
    const res = await handler(
      post("/ui/v1/worktrees/git/commit-message", { path: root }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as WorktreeCommitMessageResponse;
    expect(body.message).toBe("feat: generated");
    expect(receivedDiff).toContain("a.txt");
  });

  test("returns a structured no-provider result", async () => {
    const handler = makeHandler({
      commitMessageConfigLoader: async () => defaultGlobalConfig(),
      commitMessageGenerator: async () => {
        throw new Error("should not be called");
      },
    });
    const res = await handler(
      post("/ui/v1/worktrees/git/commit-message", { path: root }),
    );
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("no-provider-configured");
  });

  test("maps an LLM failure to generation-failed", async () => {
    const handler = makeHandler({
      commitMessageConfigLoader: async () => configWithProvider(),
      commitMessageGenerator: async () => {
        throw new LlmError("rate limited", "http-error", 429);
      },
    });
    const res = await handler(
      post("/ui/v1/worktrees/git/commit-message", { path: root }),
    );
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as GitWriteErrorBody;
    expect(body.error).toBe("generation-failed");
    expect(body.message).toContain("rate limited");
  });

  test("reads repo .wos/config.yaml rules and language", async () => {
    await writeFile(join(root, "a.txt"), "a\n");
    await Bun.$`git -C ${root} add a.txt`.quiet();
    await mkdir(join(root, ".wos"), { recursive: true });
    await writeFile(
      join(root, ".wos", "config.yaml"),
      ["commit:", "  message:", "    language: fr", "    instructions: Be terse."].join(
        "\n",
      ),
    );
    let captured: any;
    const handler = makeHandler({
      commitMessageConfigLoader: async () => configWithProvider(),
      commitMessageGenerator: async (params: any) => {
        captured = params;
        return "msg";
      },
    });
    const res = await handler(
      post("/ui/v1/worktrees/git/commit-message", { path: root }),
    );
    expect(res!.status).toBe(200);
    expect(captured.language).toBe("fr");
    expect(captured.rules).toBe("Be terse.");
  });
});
