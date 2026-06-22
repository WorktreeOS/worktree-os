import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

const repoRoot = resolve(import.meta.dir, "..");
const buildScript = resolve(repoRoot, "scripts/build-binary.ts");
const tailwindPlugin = resolve(repoRoot, "node_modules/bun-plugin-tailwind");

let workDir: string;
let outfile: string;

const SKIP = !existsSync(tailwindPlugin);

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "wos-binary-build-"));
  outfile = join(workDir, "wos");
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const itOrSkip = SKIP ? test.skip : test;

itOrSkip(
  "build:binary produces an executable that runs `wos help` standalone",
  async () => {
    // Build the binary into the temporary work directory using the same build
    // script the developer invokes via `bun run build:binary`, but redirecting
    // its output to a throwaway path so the test does not clobber repo state.
    const build = Bun.spawn(
      [process.execPath, buildScript],
      {
        cwd: repoRoot,
        env: { ...process.env, WOS_BINARY_OUTFILE: outfile },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const buildCode = await build.exited;
    if (buildCode !== 0) {
      const stderr = await new Response(build.stderr).text();
      throw new Error(`build-binary failed (${buildCode}): ${stderr}`);
    }
    expect(existsSync(outfile)).toBe(true);

    const helpProc = Bun.spawn([outfile, "help"], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const helpCode = await helpProc.exited;
    const helpOut = await new Response(helpProc.stdout).text();
    expect(helpCode).toBe(0);
    expect(helpOut).toContain("wos");
    expect(helpOut).toContain("daemon");
  },
  120_000,
);
