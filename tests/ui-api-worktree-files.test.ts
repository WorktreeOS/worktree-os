import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdir,
  rm,
  symlink,
  writeFile,
  utimes,
  realpath,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createUiApiHandler } from "@worktreeos/daemon/ui-api";
import { OperationRegistry } from "@worktreeos/daemon/operation-registry";
import { DaemonSessionRegistry } from "@worktreeos/daemon/daemon-sessions";
import { TunnelRegistry } from "@worktreeos/runtime/tunnel-registry";
import type { WorktreeGitRunner } from "@worktreeos/core/git";
import {
  WORKTREE_FILE_MAX_BYTES,
  type WorktreeFileContentResponse,
  type WorktreeFileErrorBody,
  type WorktreeFileTreeResponse,
  type WorktreeFileWriteResponse,
} from "@worktreeos/daemon/ui-protocol";

let tmpHome: string;
let worktree: string;

function buildHandler(gitRunner?: WorktreeGitRunner) {
  return createUiApiHandler({
    registry: new OperationRegistry(),
    sessions: new DaemonSessionRegistry({ starter: () => [] }),
    tunnels: new TunnelRegistry(),
    ...(gitRunner ? { gitRunner } : {}),
  });
}

async function getTree(
  handler: ReturnType<typeof buildHandler>,
  path: string,
  dir = "",
): Promise<Response> {
  const params = new URLSearchParams({ path });
  if (dir) params.set("dir", dir);
  return (await handler(
    new Request(`http://x/ui/v1/worktrees/files/tree?${params.toString()}`),
  )) as Response;
}

async function getContent(
  handler: ReturnType<typeof buildHandler>,
  path: string,
  file: string,
): Promise<Response> {
  const params = new URLSearchParams({ path, file });
  return (await handler(
    new Request(
      `http://x/ui/v1/worktrees/files/content?${params.toString()}`,
    ),
  )) as Response;
}

async function putContent(
  handler: ReturnType<typeof buildHandler>,
  body: unknown,
): Promise<Response> {
  return (await handler(
    new Request("http://x/ui/v1/worktrees/files/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )) as Response;
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-files-"));
  worktree = await realpath(tmpHome);
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "README.md"), "hello world\n");
  await writeFile(join(worktree, "src", "index.ts"), "export const x = 1;\n");
  // .git must be hidden by the tree listing.
  await mkdir(join(worktree, ".git"), { recursive: true });
  await writeFile(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

describe("UI API: worktree file tree", () => {
  test("lists root directory with .git hidden and directories first", async () => {
    const handler = buildHandler();
    const res = await getTree(handler, worktree);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorktreeFileTreeResponse;
    expect(body.worktreePath).toBe(worktree);
    expect(body.dir).toBe("");
    const names = body.entries.map((e) => e.name);
    expect(names).not.toContain(".git");
    expect(names).toEqual(["src", "README.md"]);
    expect(body.entries[0]?.kind).toBe("directory");
    expect(body.entries[1]?.kind).toBe("file");
    expect(body.entries[1]?.size).toBe("hello world\n".length);
  });

  test("lists a nested directory", async () => {
    const handler = buildHandler();
    const res = await getTree(handler, worktree, "src");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorktreeFileTreeResponse;
    expect(body.dir).toBe("src");
    expect(body.entries.map((e) => e.path)).toEqual(["src/index.ts"]);
  });

  test("attaches git status letters to files and rollup counts to directories", async () => {
    // Whole-worktree porcelain output covering the fixture tree plus a nested
    // change so the `src` rollup must count a deeper path.
    const porcelain = [
      " M README.md",
      "A  src/index.ts",
      "?? src/extra/new.ts",
      "",
    ].join("\n");
    const gitRunner: WorktreeGitRunner = async (_cwd, args) => {
      if (args[0] === "status") return porcelain;
      return "";
    };
    const handler = buildHandler(gitRunner);

    const rootRes = await getTree(handler, worktree);
    const rootBody = (await rootRes.json()) as WorktreeFileTreeResponse;
    const readme = rootBody.entries.find((e) => e.name === "README.md");
    const srcDir = rootBody.entries.find((e) => e.name === "src");
    expect(readme?.gitStatus).toBe(" M");
    // `src` subtree has src/index.ts and src/extra/new.ts → 2 changed files.
    expect(srcDir?.changedCount).toBe(2);

    const srcRes = await getTree(handler, worktree, "src");
    const srcBody = (await srcRes.json()) as WorktreeFileTreeResponse;
    const index = srcBody.entries.find((e) => e.name === "index.ts");
    expect(index?.gitStatus).toBe("A ");
  });

  test("omits git status when the git command fails", async () => {
    const gitRunner: WorktreeGitRunner = async () => {
      throw new Error("not a git repository");
    };
    const handler = buildHandler(gitRunner);
    const res = await getTree(handler, worktree);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorktreeFileTreeResponse;
    expect(body.entries.length).toBeGreaterThan(0);
    for (const entry of body.entries) {
      expect(entry.gitStatus).toBeUndefined();
      expect(entry.changedCount).toBeUndefined();
    }
  });

  test("rejects absolute dir path", async () => {
    const handler = buildHandler();
    const res = await getTree(handler, worktree, "/etc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("validation");
  });

  test("rejects parent traversal", async () => {
    const handler = buildHandler();
    const res = await getTree(handler, worktree, "../etc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("validation");
  });

  test("rejects symlink escape", async () => {
    const outside = await mkdtemp(join(tmpdir(), "wos-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "do not read\n");
      await symlink(outside, join(worktree, "escape"));
      const handler = buildHandler();
      // Direct dir listing into the symlink should be rejected because the
      // resolved real path lives outside the worktree.
      const res = await getTree(handler, worktree, "escape");
      expect(res.status).toBe(400);
      const body = (await res.json()) as WorktreeFileErrorBody;
      expect(body.error).toBe("validation");
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("returns 404 for missing directory", async () => {
    const handler = buildHandler();
    const res = await getTree(handler, worktree, "nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("not-found");
  });
});

describe("UI API: worktree file read", () => {
  test("returns UTF-8 text and metadata for a small file", async () => {
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "README.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorktreeFileContentResponse;
    expect(body.content).toBe("hello world\n");
    expect(body.size).toBe("hello world\n".length);
    expect(body.editable).toBe(true);
    expect(typeof body.mtimeMs).toBe("number");
  });

  test("rejects a directory target", async () => {
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "src");
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("not-a-file");
  });

  test("returns 404 for missing files", async () => {
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "missing.txt");
    expect(res.status).toBe(404);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("not-found");
  });

  test("rejects binary files", async () => {
    const filePath = join(worktree, "blob.bin");
    await writeFile(filePath, Buffer.from([0, 1, 2, 0, 4, 5]));
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "blob.bin");
    expect(res.status).toBe(415);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("unsupported-file");
    expect(body.reason).toBe("binary");
  });

  test("rejects oversized files", async () => {
    const big = Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 1, 65);
    await writeFile(join(worktree, "big.txt"), big);
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "big.txt");
    expect(res.status).toBe(413);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("unsupported-file");
    expect(body.reason).toBe("too-large");
    expect(body.maxBytes).toBe(WORKTREE_FILE_MAX_BYTES);
  });

  test("rejects absolute file path", async () => {
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "/etc/passwd");
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("validation");
  });

  test("rejects parent traversal", async () => {
    const handler = buildHandler();
    const res = await getContent(handler, worktree, "../etc/passwd");
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("validation");
  });
});

describe("UI API: worktree file write", () => {
  test("saves new UTF-8 content and returns updated metadata", async () => {
    const handler = buildHandler();
    const read = await getContent(handler, worktree, "README.md");
    const readBody = (await read.json()) as WorktreeFileContentResponse;
    const res = await putContent(handler, {
      path: worktree,
      file: "README.md",
      content: "updated\n",
      expectedMtimeMs: readBody.mtimeMs,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorktreeFileWriteResponse;
    expect(body.size).toBe("updated\n".length);
    expect(body.mtimeMs).toBeGreaterThanOrEqual(readBody.mtimeMs);
    const after = await Bun.file(join(worktree, "README.md")).text();
    expect(after).toBe("updated\n");
  });

  test("returns conflict when mtime changed externally", async () => {
    const handler = buildHandler();
    const read = await getContent(handler, worktree, "README.md");
    const readBody = (await read.json()) as WorktreeFileContentResponse;
    // Bump the mtime to simulate an external write.
    const futureSecs = (readBody.mtimeMs + 10_000) / 1000;
    await utimes(join(worktree, "README.md"), futureSecs, futureSecs);
    const res = await putContent(handler, {
      path: worktree,
      file: "README.md",
      content: "boom\n",
      expectedMtimeMs: readBody.mtimeMs,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("conflict");
    expect(typeof body.currentMtimeMs).toBe("number");
    // File on disk must not have been overwritten.
    const after = await Bun.file(join(worktree, "README.md")).text();
    expect(after).toBe("hello world\n");
  });

  test("rejects writing outside the worktree", async () => {
    const handler = buildHandler();
    const res = await putContent(handler, {
      path: worktree,
      file: "../escape.txt",
      content: "no",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("validation");
  });

  test("rejects writing to missing file", async () => {
    const handler = buildHandler();
    const res = await putContent(handler, {
      path: worktree,
      file: "new-file.txt",
      content: "no",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("not-found");
  });

  test("rejects writing to a directory", async () => {
    const handler = buildHandler();
    const res = await putContent(handler, {
      path: worktree,
      file: "src",
      content: "no",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("not-a-file");
  });

  test("rejects writing oversized content", async () => {
    const big = Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 1, 66);
    await writeFile(join(worktree, "big.txt"), big);
    const handler = buildHandler();
    const res = await putContent(handler, {
      path: worktree,
      file: "big.txt",
      content: "ignored",
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as WorktreeFileErrorBody;
    expect(body.error).toBe("unsupported-file");
    expect(body.reason).toBe("too-large");
  });
});

// Note: `sep` referenced to keep the import used.
void sep;
