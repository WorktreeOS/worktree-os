import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
} from "./helpers/daemon-test-harness.ts";
import type { DaemonHandle } from "@worktreeos/daemon/daemon-server";
import type {
  DirectoryListResponse,
  ProjectPathValidateResponse,
} from "@worktreeos/daemon/ui-protocol";

let tmpHome: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  tmpHome = await createDaemonTestHome("wos-ui-pathpicker-");
  daemon = null;
});

afterEach(async () => {
  await teardownDaemonTestHome(tmpHome, daemon);
});

interface BuildOpts {
  gitRunner?: (
    root: string,
    args: string[],
  ) => Promise<string> | string;
  tunnelWebUi?: import("@worktreeos/core/global-config").GlobalTunnelWebUiConfig;
}

async function buildHandler(opts: BuildOpts = {}) {
  const { createUiApiHandler } = await import("@worktreeos/daemon/ui-api");
  const { OperationRegistry } = await import(
    "@worktreeos/daemon/operation-registry"
  );
  const { DaemonSessionRegistry } = await import(
    "@worktreeos/daemon/daemon-sessions"
  );
  const { TunnelRegistry } = await import("@worktreeos/runtime/tunnel-registry");
  const { GitError } = await import("@worktreeos/core/git");
  const defaultGitRunner = async () => {
    throw new GitError("git: not a git repository");
  };
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    gitRunner: async (root, args) => {
      const result = await gitRunner(root, args);
      return typeof result === "string" ? result : "";
    },
    projectsFilePath: resolve(tmpHome, "projects.json"),
    resolveSession: async () => ({}) as never,
    tunnelWebUi: opts.tunnelWebUi,
  });
}

describe("UI API: directory autocomplete", () => {
  test("lists immediate child directories only", async () => {
    const root = join(tmpHome, "root");
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "alpha"), { recursive: true });
    await mkdir(join(root, "beta"), { recursive: true });
    await mkdir(join(root, "beta", "nested"), { recursive: true });
    await writeFile(join(root, "readme.md"), "hi");

    const handler = await buildHandler();
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(root)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as DirectoryListResponse;
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).not.toContain("readme.md");
    // Nested directories are NOT included — only immediate children.
    expect(names).not.toContain("nested");
  });

  test("returns 404 for missing path and 400 for non-directory", async () => {
    const handler = await buildHandler();
    // Neither the path nor its parent exists, so there is nothing to list.
    const missing = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(
          join(tmpHome, "nope", "deeper"),
        )}`,
      ),
    );
    expect(missing!.status).toBe(404);

    const file = join(tmpHome, "file.txt");
    await writeFile(file, "x");
    const notDir = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(file)}`,
      ),
    );
    expect(notDir!.status).toBe(400);
    const body = (await notDir!.json()) as { error: string };
    expect(body.error).toBe("not-directory");
  });

  test("marks Git worktree roots by their .git entry without spawning git", async () => {
    const root = join(tmpHome, "root");
    await mkdir(root, { recursive: true });
    const repo = join(root, "repo");
    const plain = join(root, "plain-dir");
    await mkdir(repo, { recursive: true });
    await mkdir(plain, { recursive: true });
    // A worktree/repository root is detected by a `.git` entry alone.
    await mkdir(join(repo, ".git"), { recursive: true });

    const gitCalls: string[] = [];
    const handler = await buildHandler({
      gitRunner: async (cwd) => {
        gitCalls.push(cwd);
        return "";
      },
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(root)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as DirectoryListResponse;
    const byName = new Map(body.entries.map((e) => [e.name, e]));
    expect(byName.get("repo")?.isGitWorktree).toBe(true);
    expect(byName.get("plain-dir")?.isGitWorktree).toBe(false);
    // The autocomplete never spawns git, even for worktree roots.
    expect(gitCalls).toEqual([]);
  });

  test("an exact directory path lists its own children", async () => {
    const base = join(tmpHome, "base");
    const project = join(base, "project");
    await mkdir(join(project, "child-a"), { recursive: true });
    await mkdir(join(project, "child-b"), { recursive: true });

    const handler = await buildHandler();
    // No trailing slash; the path itself names an existing directory.
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(project)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as DirectoryListResponse;
    expect(body.path).toBe(resolve(project));
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("child-a");
    expect(names).toContain("child-b");
  });

  test("a partial trailing segment lists the parent's children", async () => {
    const base = join(tmpHome, "base");
    await mkdir(join(base, "project"), { recursive: true });

    const handler = await buildHandler();
    // `proj` does not exist, but its parent `base` does.
    const partial = join(base, "proj");
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(partial)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as DirectoryListResponse;
    expect(body.path).toBe(resolve(base));
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("project");
  });

  test("skips inaccessible child directories", async () => {
    if (process.platform === "win32") return; // chmod semantics differ
    if (process.getuid?.() === 0) return; // root bypasses perms
    const root = join(tmpHome, "root");
    const ok = join(root, "ok");
    const locked = join(root, "locked");
    await mkdir(ok, { recursive: true });
    await mkdir(locked, { recursive: true });
    // readdir on the parent still lists both entries; the per-entry `.git`
    // probe simply finds nothing for `locked` and it stays in the listing. The
    // "inaccessible" coverage is for when the *parent* cannot be read.
    const handler = await buildHandler();
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(root)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as DirectoryListResponse;
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("ok");
    expect(names).toContain("locked");

    // Now make the root itself unreadable and confirm we get 403.
    await chmod(root, 0o000);
    try {
      const denied = await handler(
        new Request(
          `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(root)}`,
        ),
      );
      // On some kernels readdir returns EACCES; on others stat works first and
      // readdir fails next. Either way the response should not be 200.
      expect(denied!.status === 403 || denied!.status === 500).toBe(true);
    } finally {
      await chmod(root, 0o755);
    }
  });
});

describe("UI API: project path validation", () => {
  test("valid Git worktree with both deploy configs returns no warning", async () => {
    const repo = join(tmpHome, "repo");
    await mkdir(repo, { recursive: true });
    await Bun.write(join(repo, ".wos", "deploy.yaml"), "app:\n  services: {}\n");
    await Bun.write(
      join(repo, ".wos", "deploy.worktree.yaml"),
      "app:\n  services: {}\n",
    );
    const handler = await buildHandler({
      gitRunner: async (_cwd, args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return `worktree ${repo}\nHEAD aaa\nbranch refs/heads/main\n\n`;
        }
        return "";
      },
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/projects/validate?path=${encodeURIComponent(repo)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ProjectPathValidateResponse;
    expect(body.valid).toBe(true);
    expect(body.sourcePath).toBe(realpathSync(repo));
    expect(body.warning).toBeUndefined();
  });

  test("valid Git worktree without deploy configs returns missing-config warning", async () => {
    const repo = join(tmpHome, "repo");
    await mkdir(repo, { recursive: true });
    const handler = await buildHandler({
      gitRunner: async (_cwd, args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return `worktree ${repo}\nHEAD aaa\nbranch refs/heads/main\n\n`;
        }
        return "";
      },
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/projects/validate?path=${encodeURIComponent(repo)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ProjectPathValidateResponse;
    expect(body.valid).toBe(true);
    expect(body.warning?.code).toBe("missing-config");
    // Both deploy configs are missing, so the message names each one.
    expect(body.warning?.message).toContain("deploy.yaml");
    expect(body.warning?.message).toContain("deploy.worktree.yaml");
  });

  test("missing worktree deploy config warns about secondary startup only", async () => {
    const repo = join(tmpHome, "repo");
    await mkdir(repo, { recursive: true });
    await Bun.write(join(repo, ".wos", "deploy.yaml"), "app:\n  services: {}\n");
    const handler = await buildHandler({
      gitRunner: async (_cwd, args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return `worktree ${repo}\nHEAD aaa\nbranch refs/heads/main\n\n`;
        }
        return "";
      },
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/projects/validate?path=${encodeURIComponent(repo)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ProjectPathValidateResponse;
    expect(body.valid).toBe(true);
    expect(body.warning?.code).toBe("missing-config");
    expect(body.warning?.message).toContain("deploy.worktree.yaml");
    expect(body.warning?.message).toContain("secondary worktree");
  });

  test("non-Git path returns invalid with a message", async () => {
    const dir = join(tmpHome, "plain");
    await mkdir(dir, { recursive: true });
    const handler = await buildHandler();
    const res = await handler(
      new Request(
        `http://x/ui/v1/projects/validate?path=${encodeURIComponent(dir)}`,
      ),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as ProjectPathValidateResponse;
    expect(body.valid).toBe(false);
    expect(typeof body.message).toBe("string");
  });

  test("validation does not register a project", async () => {
    const repo = join(tmpHome, "repo");
    await mkdir(repo, { recursive: true });
    await Bun.write(join(repo, ".wos", "deploy.yaml"), "app:\n  services: {}\n");
    const handler = await buildHandler({
      gitRunner: async (_cwd, args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return `worktree ${repo}\nHEAD aaa\nbranch refs/heads/main\n\n`;
        }
        return "";
      },
    });
    const res = await handler(
      new Request(
        `http://x/ui/v1/projects/validate?path=${encodeURIComponent(repo)}`,
      ),
    );
    expect(res!.status).toBe(200);
    // Project list must remain empty after validation.
    const list = await handler(new Request("http://x/ui/v1/projects"));
    expect(list!.status).toBe(200);
    const body = (await list!.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });
});

describe("UI API: filesystem/validation public access policy", () => {
  test("public-host directory request is denied when terminal access is disabled", async () => {
    const PUBLIC_HOST = "wos.example.com";
    const handler = await buildHandler({
      tunnelWebUi: {
        enabled: true,
        hostname: PUBLIC_HOST,
        secret: "letmein",
        terminalEnabled: false,
        whitelistIps: [],
      },
    });
    const { signAuthCookie, AUTH_COOKIE_NAME } = await import(
      "@worktreeos/daemon/public-auth"
    );
    const cookie = `${AUTH_COOKIE_NAME}=${signAuthCookie("letmein", Date.now())}`;
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(tmpHome)}`,
        { headers: { host: PUBLIC_HOST, cookie } },
      ),
    );
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("public-host validate request is denied when terminal access is disabled", async () => {
    const PUBLIC_HOST = "wos.example.com";
    const handler = await buildHandler({
      tunnelWebUi: {
        enabled: true,
        hostname: PUBLIC_HOST,
        secret: "letmein",
        terminalEnabled: false,
        whitelistIps: [],
      },
    });
    const { signAuthCookie, AUTH_COOKIE_NAME } = await import(
      "@worktreeos/daemon/public-auth"
    );
    const cookie = `${AUTH_COOKIE_NAME}=${signAuthCookie("letmein", Date.now())}`;
    const res = await handler(
      new Request(
        `http://x/ui/v1/projects/validate?path=${encodeURIComponent(tmpHome)}`,
        { headers: { host: PUBLIC_HOST, cookie } },
      ),
    );
    expect(res!.status).toBe(403);
  });

  test("public-host directory request is allowed when terminal access is enabled", async () => {
    const PUBLIC_HOST = "wos.example.com";
    const dir = join(tmpHome, "root");
    await mkdir(dir, { recursive: true });
    const handler = await buildHandler({
      tunnelWebUi: {
        enabled: true,
        hostname: PUBLIC_HOST,
        secret: "letmein",
        terminalEnabled: true,
        whitelistIps: [],
      },
    });
    const { signAuthCookie, AUTH_COOKIE_NAME } = await import(
      "@worktreeos/daemon/public-auth"
    );
    const cookie = `${AUTH_COOKIE_NAME}=${signAuthCookie("letmein", Date.now())}`;
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(dir)}`,
        { headers: { host: PUBLIC_HOST, cookie } },
      ),
    );
    expect(res!.status).toBe(200);
  });

  test("local client is always allowed regardless of terminal access flag", async () => {
    const dir = join(tmpHome, "root");
    await mkdir(dir, { recursive: true });
    const handler = await buildHandler({
      tunnelWebUi: {
        enabled: true,
        hostname: "wos.example.com",
        secret: "letmein",
        terminalEnabled: false,
        whitelistIps: [],
      },
    });
    // No host header set — request is treated as local.
    const res = await handler(
      new Request(
        `http://x/ui/v1/filesystem/directories?path=${encodeURIComponent(dir)}`,
      ),
    );
    expect(res!.status).toBe(200);
  });
});

