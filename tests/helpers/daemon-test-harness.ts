import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startDaemon,
  type DaemonHandle,
  type DaemonOptions,
} from "@worktreeos/daemon/daemon-server";
import type { FollowerStarter } from "@worktreeos/daemon/daemon-sessions";
import {
  assertNoLeakedComposeLogFollowers,
  terminateTestOwnedComposeProcesses,
} from "./compose-process-cleanup.ts";

export const noopFollowerStarter: FollowerStarter = () => [];

export const fakeDockerRunner = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

export interface DaemonTestHarness {
  wosHome: string;
  metadataPath: string;
  /** Base URL of the daemon HTTP listener (ephemeral loopback port). */
  baseUrl: string;
  daemon: DaemonHandle;
  stop: () => Promise<void>;
}

export type CreateDaemonHarnessOptions = Omit<DaemonOptions, "metadataPath"> & {
  wosHome?: string;
};

export function withDaemonDefaults(
  wosHome: string,
  opts: CreateDaemonHarnessOptions = {},
): DaemonOptions & { metadataPath: string } {
  const {
    restorePersistedState,
    followerStarter,
    dockerRunner,
    web,
    metadataPath,
    ...rest
  } = opts;
  return {
    ...rest,
    metadataPath: metadataPath ?? resolve(wosHome, "daemon.json"),
    restorePersistedState: restorePersistedState ?? false,
    followerStarter: followerStarter ?? noopFollowerStarter,
    dockerRunner: dockerRunner ?? fakeDockerRunner,
    // Ephemeral loopback port so parallel test daemons never collide.
    web: web ?? { port: 0 },
  };
}

const savedHomes = new Map<string, string | undefined>();

export function bindDaemonTestEnv(wosHome: string): () => void {
  const saved = process.env.WOS_HOME;
  process.env.WOS_HOME = wosHome;
  return () => {
    if (saved === undefined) delete process.env.WOS_HOME;
    else process.env.WOS_HOME = saved;
  };
}

export async function createDaemonTestHarness(
  opts: CreateDaemonHarnessOptions = {},
): Promise<DaemonTestHarness> {
  const wosHome =
    opts.wosHome ?? (await mkdtemp(join(tmpdir(), "wos-daemon-test-")));
  const restoreEnv = bindDaemonTestEnv(wosHome);

  const { wosHome: _ignored, ...daemonOpts } = opts;
  const merged = withDaemonDefaults(wosHome, daemonOpts);
  const daemon = await startDaemon(merged);

  const stop = async () => {
    await daemon.stop();
    assertNoLeakedComposeLogFollowers(wosHome);
    await terminateTestOwnedComposeProcesses(wosHome);
    restoreEnv();
    if (!opts.wosHome) {
      await rm(wosHome, { recursive: true, force: true });
    }
  };

  return {
    wosHome,
    metadataPath: merged.metadataPath,
    baseUrl: daemon.webUrl,
    daemon,
    stop,
  };
}

export async function createDaemonTestHome(prefix = "wos-daemon-"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  savedHomes.set(home, process.env.WOS_HOME);
  process.env.WOS_HOME = home;
  return home;
}

export async function teardownDaemonTestHome(
  wosHome: string,
  daemon?: DaemonHandle | null,
): Promise<void> {
  if (daemon) await daemon.stop();
  assertNoLeakedComposeLogFollowers(wosHome);
  await terminateTestOwnedComposeProcesses(wosHome);
  await rm(wosHome, { recursive: true, force: true });
  const saved = savedHomes.get(wosHome);
  if (saved === undefined) delete process.env.WOS_HOME;
  else process.env.WOS_HOME = saved;
  savedHomes.delete(wosHome);
}
