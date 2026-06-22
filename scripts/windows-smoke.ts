#!/usr/bin/env bun
/**
 * Native daemon smoke test.
 *
 * Starts the daemon, verifies HTTP discovery + `GET /ui/v1/health`, asserts the
 * lifecycle uses NO Unix domain socket (the Windows regression guard), probes
 * terminal-backend availability, and stops the daemon.
 *
 * Usage:
 *   bun scripts/windows-smoke.ts                 # run against the source CLI
 *   bun scripts/windows-smoke.ts <path/to/wos>   # run against a built binary
 *
 * Exits non-zero on the first failed check so CI / release smoke fails loudly.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = process.argv[2];
const wosCmd = binary
  ? [resolve(binary)]
  : ["bun", resolve(import.meta.dir, "..", "apps/cli/index.ts")];

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function runCli(args: string[], env: Record<string, string>): { code: number; out: string; err: string } {
  const p = Bun.spawnSync([...wosCmd, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode ?? -1,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

const home = await mkdtemp(join(tmpdir(), "wos-smoke-"));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
env.WOS_HOME = home;
log(`platform=${process.platform} wosHome=${home}`);
log(`cli=${wosCmd.join(" ")}`);

let exitCode = 0;
try {
  // 1. Start the daemon. `wos start` returns once the listener is healthy.
  const start = runCli(["start"], env);
  if (start.code !== 0) {
    // The auto-started daemon captures its stdout+stderr here; surface it so a
    // startup failure shows the daemon's actual error, not just a timeout.
    const daemonLog = await readFile(join(home, "daemon.log"), "utf8").catch(
      () => "",
    );
    fail(
      `wos start exited ${start.code}\n${start.out}\n${start.err}` +
        (daemonLog ? `\n--- daemon.log ---\n${daemonLog}` : ""),
    );
  }
  log("daemon started");

  // 2. HTTP discovery: daemon.json must describe an HTTP listener.
  const meta = JSON.parse(await readFile(join(home, "daemon.json"), "utf8")) as {
    webUrl: string;
    webScheme: string;
    socketPath?: string;
  };
  if (!meta.webUrl || !/^https?:/.test(meta.webUrl)) {
    fail(`daemon.json has no HTTP webUrl: ${JSON.stringify(meta)}`);
  }
  log(`webUrl=${meta.webUrl}`);

  // 3. Regression guard: the lifecycle must NOT depend on a Unix socket file.
  if (meta.socketPath) fail(`daemon.json wrote a socketPath: ${meta.socketPath}`);
  const homeFiles = await readdir(home);
  const sockets = homeFiles.filter((f) => f.endsWith(".sock"));
  if (sockets.length > 0) fail(`Unix socket file(s) present in wos-home: ${sockets.join(", ")}`);
  log("no Unix socket files (HTTP-only lifecycle confirmed)");

  // 4. GET /ui/v1/health over HTTP.
  const healthUrl = `${meta.webUrl.replace(/\/+$/, "")}/ui/v1/health`;
  const res = await fetch(healthUrl);
  if (!res.ok) fail(`GET ${healthUrl} returned ${res.status}`);
  const health = (await res.json()) as { protocol?: string };
  log(`health ok (protocol=${health.protocol ?? "?"})`);

  // 5. Terminal availability probe (best-effort, never fatal): report whether
  //    the default ConPTY backend is usable on this host.
  if (!binary) {
    try {
      const { isBunTerminalAvailable } = await import(
        "@worktreeos/daemon/terminal-layer/bun-terminal-runtime"
      );
      log(`terminal default backend available=${isBunTerminalAvailable()}`);
    } catch (e) {
      log(`terminal availability probe skipped: ${(e as Error).message}`);
    }
  }

  log("SMOKE PASSED");
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  const stop = runCli(["stop"], env);
  log(`daemon stopped (exit ${stop.code})`);
  await rm(home, { recursive: true, force: true }).catch(() => {});
}

process.exit(exitCode);
