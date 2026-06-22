import { test, expect, describe } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isComposeCommand,
  isTestOwnedComposeProcess,
  isComposeLogFollowerProcess,
} from "./helpers/compose-process-cleanup.ts";

describe("compose process matching", () => {
  const home = "/tmp/wos-test-home-abc";

  test("detects docker compose and docker-compose commands", () => {
    expect(isComposeCommand("docker compose logs --follow api")).toBe(true);
    expect(isComposeCommand("docker-compose logs -f api")).toBe(true);
    expect(isComposeCommand("/Applications/Docker.app/Contents/MacOS/com.docker.backend")).toBe(
      false,
    );
  });

  test("matches only processes referencing the test wos home", () => {
    const cmd = `docker compose --project-directory ${home}/sessions/s1 logs --follow api`;
    expect(isTestOwnedComposeProcess(cmd, home)).toBe(true);
    expect(isTestOwnedComposeProcess("docker compose logs --follow api", home)).toBe(false);
    expect(
      isTestOwnedComposeProcess(
        "/Applications/Docker.app/Contents/MacOS/com.docker.backend",
        home,
      ),
    ).toBe(false);
  });

  test("identifies compose log followers for a test home", () => {
    const cmd = `docker compose --project-directory ${resolve(home)}/sessions/s1 logs --follow api`;
    expect(isComposeLogFollowerProcess(cmd, home)).toBe(true);
    expect(
      isComposeLogFollowerProcess(`docker compose --project-directory ${home} ps`, home),
    ).toBe(false);
  });
});

describe("run-tests wrapper", () => {
  test("dry-run reports wos home and forwards args", async () => {
    const proc = Bun.spawn(
      ["bun", "scripts/run-tests.ts", "--dry-run", "tests/paths.test.ts", "--bail"],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim()) as { wosHome: string; args: string[] };
    expect(payload.args).toEqual(["tests/paths.test.ts", "--bail"]);
    expect(payload.wosHome).toContain("wos-test-home-");
    try {
      await stat(payload.wosHome);
      throw new Error("expected dry-run home to be removed");
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  test("sets WOS_HOME for the child bun test process", async () => {
    const repoRoot = resolve(import.meta.dir, "..");
    const script = join(repoRoot, "tests", ".wos-home-probe.test.ts");
    await Bun.write(
      script,
      `import { test, expect } from "bun:test";
import { wosHome } from "@worktreeos/core/paths";
test("uses wrapper wos home", () => {
  expect(process.env.WOS_HOME).toBeTruthy();
  expect(wosHome()).toBe(process.env.WOS_HOME);
});`,
    );
    try {
      const proc = Bun.spawn(["bun", "scripts/run-tests.ts", script], {
        cwd: repoRoot,
        stdout: "inherit",
        stderr: "inherit",
      });
      expect(await proc.exited).toBe(0);
    } finally {
      await rm(script, { force: true });
    }
  });
});
