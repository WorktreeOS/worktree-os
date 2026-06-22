import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runStop } from "../apps/cli/commands/start";

const ROOTS = ["apps/cli", "packages/daemon/src"];

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listSourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no Unix socket regression guard", () => {
  test("CLI and daemon sources never reference daemon.sock or fetch(..., { unix })", async () => {
    const repoRoot = resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of await listSourceFiles(resolve(repoRoot, root))) {
        const src = await readFile(file, "utf8");
        if (src.includes("daemon.sock")) {
          offenders.push(`${file}: daemon.sock`);
        }
        // Bun's socket transport marker: a `unix:` fetch/request option.
        if (/\bunix:\s*(socketPath|unixSocket)/.test(src)) {
          offenders.push(`${file}: fetch unix option`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("wos stop does not create or require a daemon.sock file", async () => {
    const home = await mkdtemp(join(tmpdir(), "wos-nosock-"));
    const code = await runStop({
      metadataPath: resolve(home, "daemon.json"),
      healthTimeoutMs: 100,
    });
    expect(code).toBe(0);
    const entries = await readdir(home);
    expect(entries.filter((e) => e.endsWith(".sock"))).toEqual([]);
  });
});
