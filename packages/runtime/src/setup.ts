import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve, dirname, sep } from "node:path";
import {
  composeArgs,
  type ComposeContext,
  type DockerRunner,
  type StreamingDockerRunner,
} from "@worktreeos/compose/compose";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import { logSink, type DeploymentObserver } from "@worktreeos/core/events";
import {
  CacheError,
  restoreCacheEntry,
  saveCacheEntry,
  type CacheOperationOptions,
} from "./cache";
import type { CacheEntryConfig, CloneVolumeConfig } from "@worktreeos/core/config";

export class SetupError extends Error {}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export type CopyVolumeResult = { status: "copied" } | { status: "skipped"; reason: "destination-exists" };

export function resolveCloneVolumePaths(
  entry: CloneVolumeConfig,
  sourceRoot: string,
  currentRoot: string,
): { src: string; dst: string } {
  const src = isAbsolute(entry.source)
    ? entry.source
    : resolve(sourceRoot, entry.source);
  const dst = isAbsolute(entry.destination)
    ? entry.destination
    : resolve(currentRoot, entry.destination);
  return { src, dst };
}

export async function copyVolume(
  sourceRoot: string,
  currentRoot: string,
  entry: CloneVolumeConfig,
): Promise<CopyVolumeResult> {
  const { src, dst } = resolveCloneVolumePaths(entry, sourceRoot, currentRoot);
  if (src === dst) return { status: "copied" };
  if (!(await pathExists(src))) {
    throw new SetupError(`volume source "${entry.displayPath}" does not exist (${src})`);
  }
  if (await pathExists(dst)) {
    return { status: "skipped", reason: "destination-exists" };
  }
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, errorOnExist: true, force: false });
  return { status: "copied" };
}

function trashPath(dst: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return resolve(dirname(dst), `.wos-trash-${stamp}`);
}

export async function forceRemoveCloneVolumes(
  currentRoot: string,
  cloneVolumes: CloneVolumeConfig[],
  sourceRoot?: string,
): Promise<void> {
  const root = resolve(currentRoot);
  const trash: string[] = [];
  for (const entry of cloneVolumes) {
    const { dst } = resolveCloneVolumePaths(entry, sourceRoot ?? root, root);
    if (dst === root || dst === "/" || dst.length === 0) {
      throw new SetupError(
        `clone_volumes entry "${entry.displayPath}" resolves to a dangerous destination (${dst})`,
      );
    }
    if (!(await pathExists(dst))) continue;
    const parked = trashPath(dst);
    try {
      await rename(dst, parked);
      trash.push(parked);
    } catch {
      await rm(dst, { recursive: true, force: true });
    }
  }
  if (trash.length === 0) return;
  // The destinations are already parked under trash names, so the user-visible
  // removal is done. Delete the parked copies in the background via fs APIs
  // (portable; no `rm` binary, which does not exist on Windows). Fire-and-forget
  // to keep the caller non-blocking; failures are swallowed (best-effort GC).
  for (const parked of trash) {
    void rm(parked, { recursive: true, force: true }).catch(() => {});
  }
}

export type InitRunner = (commands: string[]) => Promise<void>;

export interface ContainerInitOptions {
  composeContext: ComposeContext;
  commands: string[];
  runner: DockerRunner;
  streamingRunner?: StreamingDockerRunner;
  observer?: DeploymentObserver;
  initService?: string;
  /**
   * Working directory inside the init container. When set, each command is
   * wrapped to `cd <workingDir> && (command)` so per-command subshell
   * isolation is preserved. When unset, commands run from the container's
   * configured `working_dir`.
   */
  workingDir?: string;
}

export async function runContainerInit(opts: ContainerInitOptions): Promise<void> {
  if (opts.commands.length === 0) return;
  const service = opts.initService ?? INIT_SERVICE_NAME;
  const wrapped = opts.workingDir
    ? opts.commands.map((c) => `(cd ${shellQuote(opts.workingDir!)} && ${c})`)
    : opts.commands.map((c) => `(${c})`);
  const joined = wrapped.join(" && ");
  const args = composeArgs(opts.composeContext, [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    service,
    "-lc",
    joined,
  ]);
  if (opts.observer && opts.streamingRunner) {
    const { exitCode, stderr } = await opts.streamingRunner(
      args,
      logSink(opts.observer, "init"),
    );
    if (exitCode !== 0) {
      throw new SetupError(
        `container init failed (exit ${exitCode}): ${stderr.trim() || "no stderr"}`,
      );
    }
    return;
  }
  const { exitCode, stderr } = await opts.runner(args);
  if (exitCode !== 0) {
    throw new SetupError(
      `container init failed (exit ${exitCode}): ${stderr.trim() || "no stderr"}`,
    );
  }
}

export type CacheRunner = (entry: CacheEntryConfig) => Promise<{ status: "hit" | "miss" }>;
export type CacheSaver = (entry: CacheEntryConfig) => Promise<void>;

/**
 * Per-service init phase: commands to run for a specific service after the
 * global init script. Empty commands are skipped. `workingDir` defaults to the
 * init container's `working_dir` when undefined.
 */
export interface ServiceInitPhase {
  service: string;
  commands: string[];
  workingDir?: string;
}

export type ServiceInitRunner = (phase: ServiceInitPhase) => Promise<void>;

export interface FirstRunOptions {
  sourceRoot: string;
  currentRoot: string;
  cloneVolumes: CloneVolumeConfig[];
  initScript: string[];
  runInit: InitRunner;
  /**
   * Optional per-service init phases run in dependency-first order after the
   * global init script and before cache save.
   */
  serviceInits?: ServiceInitPhase[];
  runServiceInit?: ServiceInitRunner;
  observer?: DeploymentObserver;
  cacheEntries?: CacheEntryConfig[];
  cacheRoot?: string;
  restoreCache?: CacheRunner;
  saveCache?: CacheSaver;
}

export async function firstRunSetup(opts: FirstRunOptions): Promise<void> {
  const total = opts.cloneVolumes.length;
  for (let i = 0; i < total; i += 1) {
    const v = opts.cloneVolumes[i]!;
    const index = i + 1;
    opts.observer?.emit({ type: "volume-clone", phase: "start", path: v.displayPath, index, total });
    try {
      const result = await copyVolume(opts.sourceRoot, opts.currentRoot, v);
      if (result.status === "skipped" && result.reason === "destination-exists") {
        opts.observer?.emit({
          type: "log",
          channel: "deployment",
          stream: "stderr",
          chunk: `[warn] clone_volumes: "${v.displayPath}" already exists in current worktree — skipping\n`,
        });
      }
    } finally {
      opts.observer?.emit({ type: "volume-clone", phase: "complete", path: v.displayPath, index, total });
    }
  }
  const cacheEntries = opts.cacheEntries ?? [];
  const restore: CacheRunner =
    opts.restoreCache ??
    defaultRestoreCache(opts.currentRoot, opts.cacheRoot);
  const save: CacheSaver =
    opts.saveCache ?? defaultSaveCache(opts.currentRoot, opts.cacheRoot);
  for (const entry of cacheEntries) {
    try {
      await restore(entry);
    } catch (e) {
      if (e instanceof CacheError) {
        throw new SetupError(`cache restore failed: ${e.message}`);
      }
      throw e;
    }
  }
  if (opts.initScript.length > 0) {
    await opts.runInit(opts.initScript);
  }
  const serviceInits = opts.serviceInits ?? [];
  if (serviceInits.length > 0) {
    if (!opts.runServiceInit) {
      throw new SetupError(
        "runServiceInit is required when serviceInits is non-empty",
      );
    }
    for (const phase of serviceInits) {
      if (phase.commands.length === 0) continue;
      await opts.runServiceInit(phase);
    }
  }
  for (const entry of cacheEntries) {
    try {
      await save(entry);
    } catch (e) {
      if (e instanceof CacheError) {
        throw new SetupError(`cache save failed: ${e.message}`);
      }
      throw e;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultRestoreCache(currentRoot: string, cacheRoot?: string): CacheRunner {
  return async (entry) => {
    const opts: CacheOperationOptions = { entry, worktreeRoot: currentRoot, cacheRoot };
    return await restoreCacheEntry(opts);
  };
}

function defaultSaveCache(currentRoot: string, cacheRoot?: string): CacheSaver {
  return async (entry) => {
    const opts: CacheOperationOptions = { entry, worktreeRoot: currentRoot, cacheRoot };
    await saveCacheEntry(opts);
  };
}
