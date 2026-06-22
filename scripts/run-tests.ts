import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateTestOwnedComposeProcesses } from "../tests/helpers/compose-process-cleanup.ts";

const args = process.argv.slice(2);
const dryRun = args[0] === "--dry-run";
const testArgs = dryRun ? args.slice(1) : args;

let wosHome: string | undefined;
let exitCode = 0;

try {
  wosHome = await mkdtemp(join(tmpdir(), "wos-test-home-"));

  if (dryRun) {
    console.log(
      JSON.stringify({
        wosHome,
        args: testArgs,
      }),
    );
  } else {
    const proc = Bun.spawn(["bun", "test", ...testArgs], {
      env: { ...process.env, WOS_HOME: wosHome },
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  }
} finally {
  if (wosHome) {
    await terminateTestOwnedComposeProcesses(wosHome);
    await rm(wosHome, { recursive: true, force: true });
  }
}

process.exit(exitCode);
