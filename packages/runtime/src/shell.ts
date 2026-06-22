import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
  AppServiceConfig,
  WosConfig,
  ResolvedHealthcheckDefaults,
} from "@worktreeos/core/config";
import { isShellMode } from "@worktreeos/core/config";
import { isSourceWorktree, type WorktreeEntry } from "@worktreeos/core/git";
import {
  logSink,
  nullObserver,
  type DeploymentObserver,
  type LogChannel,
} from "@worktreeos/core/events";
import {
  sessionShellLogDir,
  sessionShellServiceLogPath,
} from "@worktreeos/core/paths";
import {
  readState,
  stateFilePath,
  writeState,
  type PortAssignments,
  type ShellRuntimeState,
  type ShellServiceRuntimeState,
  type WosState,
} from "@worktreeos/core/state";
import { generateDeploymentId } from "@worktreeos/core/tunnel-metadata";
import {
  resolveServiceSelection,
  ServiceSelectionError,
  type ResolvedServiceSelection,
  type ServiceSelectionInput,
} from "@worktreeos/compose/service-selection";
import {
  validateRuntimeArguments,
  type RuntimeArgumentMap,
} from "@worktreeos/compose/runtime-arguments";
import {
  allocatePorts,
  assertStaticPortsAvailable,
  assignStaticPorts,
  collectBindings,
  defaultIsPortAvailable,
  type AvailabilityChecker,
} from "@worktreeos/compose/port-allocator";
import { parseEnvFileContents } from "@worktreeos/compose/compose-env";
import type { ServiceStatus } from "@worktreeos/compose/ps";
import {
  hasRequiredHealthcheckFailure,
  runAppPortHealthchecks,
  summarizeHealthcheckFailures,
  waitingHealthcheckSnapshot,
  type AppPortHealthcheckResult,
  type HealthcheckHttpClient,
} from "./healthchecks";
import { firstRunSetup, forceRemoveCloneVolumes } from "./setup";
import { formatHealthchecks, formatStatus } from "@worktreeos/ui/format";
import { throwIfDeploymentCancelled } from "./cancellation";
import { emptyTunnelResolution, type TunnelPreparer } from "./up-program";

export class ShellRuntimeError extends Error {}

/** Resolved hostname tunnel map: service -> containerPort (string) -> hostname. */
export type ShellTunnelHostnames = Record<string, Record<string, string>>;

/** Resolved full-URL tunnel map: service -> containerPort (string) -> url. */
export type ShellTunnelUrls = Record<string, Record<string, string>>;

/**
 * Handle returned by a spawned shell service process. `pid` is the root
 * process id; `processGroupId` is set when the platform started the process in
 * its own group (so the whole tree can be terminated via the negative pid).
 */
export interface ShellSpawnHandle {
  pid: number;
  processGroupId?: number;
}

export interface ShellSpawnRequest {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * Injectable host-process boundary so the shell backend can be unit-tested
 * without spawning real processes. The default implementation uses
 * `Bun.spawn` with `detached: true` (a new process group) and redirects
 * stdout/stderr straight to session log files.
 */
export interface ShellProcessHost {
  spawn(req: ShellSpawnRequest): ShellSpawnHandle;
  isAlive(pid: number): boolean;
  kill(target: { pid: number; processGroupId?: number }, signal: "SIGTERM" | "SIGKILL"): void;
}

export const defaultShellProcessHost: ShellProcessHost = {
  spawn(req) {
    const outFd = openSync(req.stdoutPath, "w");
    const errFd = openSync(req.stderrPath, "w");
    try {
      const proc = Bun.spawn(req.command, {
        cwd: req.cwd,
        env: req.env,
        stdin: "ignore",
        stdout: outFd,
        stderr: errFd,
        // POSIX: `detached: true` runs setsid() so the child leads its own
        // process group and the whole tree can be signalled via the negative
        // pid. Windows has no setsid; the tree is reaped with `taskkill /T`,
        // so the child stays a normal child (no process-group id is recorded).
        // `windowsHide` keeps the host shell from flashing a console window
        // when the daemon (which runs detached, without a console) starts it.
        ...(IS_WINDOWS ? { windowsHide: true } : { detached: true }),
      });
      proc.unref();
      return IS_WINDOWS
        ? { pid: proc.pid }
        : { pid: proc.pid, processGroupId: proc.pid };
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
  },
  isAlive(pid) {
    return isProcessAlive(pid);
  },
  kill(target, signal) {
    if (IS_WINDOWS) {
      // No negative-pid group signal on Windows: walk the child tree with
      // `taskkill /T`. A `SIGKILL` forces (`/F`); a graceful `SIGTERM` requests
      // termination first (the stop loop escalates to `SIGKILL` after the
      // grace window).
      const args = ["/PID", String(target.pid), "/T"];
      if (signal === "SIGKILL") args.push("/F");
      try {
        spawnSync("taskkill", args, { stdio: "ignore", timeout: 5000, windowsHide: true });
      } catch {
        // taskkill missing or process already gone — nothing to do.
      }
      return;
    }
    const id = target.processGroupId ? -target.processGroupId : target.pid;
    try {
      process.kill(id, signal);
    } catch {
      // Process already gone — nothing to do.
    }
  },
};

/** Probe whether `pid` references a live process owned or visible to us. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DEFAULT_STOP_GRACE_MS = 5000;

/**
 * Shared deps for the shell `up` flow. Structurally satisfied by
 * `RunUpDeps`, so `runUpProgram` can forward its deps directly.
 */
export interface RunShellUpDeps {
  worktreeRoot: string;
  config: WosConfig;
  source: WorktreeEntry;
  projectName: string;
  force?: boolean;
  noTunnel?: boolean;
  isPortAvailable?: AvailabilityChecker;
  now?: () => Date;
  stdout?: (text: string) => void;
  observer?: DeploymentObserver;
  cacheRoot?: string;
  healthcheckHttp?: HealthcheckHttpClient;
  healthcheckDefaults?: ResolvedHealthcheckDefaults;
  signal?: AbortSignal;
  tunnelPreparer?: TunnelPreparer;
  progress?: { composeStarted: boolean };
  selection?: ServiceSelectionInput;
  runtimeArguments?: RuntimeArgumentMap;
  /** Host-process boundary (tests inject a fake). */
  shellProcessHost?: ShellProcessHost;
  /** Base environment inherited by every service process. Defaults to `process.env`. */
  shellBaseEnv?: Record<string, string>;
  /** LAN bind address advertised to services in place of `localhost`. */
  serviceBind?: string;
}

const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;
const RUNTIME_ARGUMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface TemplateContext {
  config: WosConfig;
  assignments: PortAssignments;
  tunnelHostnames: ShellTunnelHostnames;
  tunnelUrls: ShellTunnelUrls;
  declaredArguments: Set<string>;
  submittedArguments: RuntimeArgumentMap;
  /** LAN bind address that replaces the `localhost` fallback when set. */
  serviceBind?: string;
}

/** Bracket IPv6 literals so they are valid in a `http://<host>:<port>` URL. */
function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Resolve a single configured value, expanding `${...}` shell-mode templates:
 * declared runtime arguments (`${NAME}` / `${NAME:-default}`) and exact
 * per-port references `${app.services.X.hostPort[N]}` /
 * `${app.services.X.hostname[N]}` / `${app.services.X.url[N]}`. Unknown
 * expressions fail loudly, matching generated-compose template semantics.
 */
export function resolveShellTemplateValue(
  value: string,
  field: string,
  tctx: TemplateContext,
): string {
  return value.replace(TEMPLATE_PATTERN, (raw, exprRaw: string) => {
    const expr = exprRaw.trim();
    const arg = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(expr);
    if (arg && RUNTIME_ARGUMENT_NAME_PATTERN.test(arg[1]!)) {
      const name = arg[1]!;
      const defaultValue = arg[2];
      if (!tctx.declaredArguments.has(name)) {
        throw new ShellRuntimeError(
          `${field}: template "${raw}" references undeclared runtime argument "${name}"`,
        );
      }
      const submitted = tctx.submittedArguments[name];
      if (typeof submitted === "string" && submitted.length > 0) return submitted;
      if (defaultValue !== undefined) return defaultValue;
      throw new ShellRuntimeError(
        `${field}: template "${raw}" requires runtime argument "${name}" but no value was provided`,
      );
    }
    const hostPort = /^app\.services\.([A-Za-z0-9_-]+)\.hostPort\[(\d+)\]$/.exec(expr);
    if (hostPort) {
      const service = hostPort[1]!;
      const port = Number(hostPort[2]);
      assertConfiguredPort(tctx.config, service, port, raw, field);
      const host = tctx.assignments[service]?.[String(port)];
      if (typeof host !== "number") {
        throw new ShellRuntimeError(
          `${field}: missing host-port assignment for app.${service}:${port}`,
        );
      }
      return String(host);
    }
    const hostname = /^app\.services\.([A-Za-z0-9_-]+)\.hostname\[(\d+)\]$/.exec(expr);
    if (hostname) {
      const service = hostname[1]!;
      const port = Number(hostname[2]);
      assertConfiguredPort(tctx.config, service, port, raw, field);
      return (
        tctx.tunnelHostnames[service]?.[String(port)] ??
        tctx.serviceBind ??
        "localhost"
      );
    }
    const url = /^app\.services\.([A-Za-z0-9_-]+)\.url\[(\d+)\]$/.exec(expr);
    if (url) {
      const service = url[1]!;
      const port = Number(url[2]);
      assertConfiguredPort(tctx.config, service, port, raw, field);
      const tunnelUrl = tctx.tunnelUrls[service]?.[String(port)];
      if (tunnelUrl) return tunnelUrl;
      const host = tctx.assignments[service]?.[String(port)];
      if (typeof host !== "number") {
        throw new ShellRuntimeError(
          `${field}: missing host-port assignment for app.${service}:${port}`,
        );
      }
      return `http://${formatUrlHost(tctx.serviceBind ?? "localhost")}:${host}`;
    }
    throw new ShellRuntimeError(`${field}: unsupported template expression "${raw}"`);
  });
}

function assertConfiguredPort(
  config: WosConfig,
  service: string,
  port: number,
  raw: string,
  field: string,
): void {
  const svc = config.app.services[service];
  if (!svc) {
    throw new ShellRuntimeError(
      `${field}: template "${raw}" references unknown app service "${service}"`,
    );
  }
  if (!svc.ports.some((p) => p.containerPort === port)) {
    throw new ShellRuntimeError(
      `${field}: template "${raw}" references unconfigured port ${port} for app service "${service}"`,
    );
  }
}

/**
 * Build the environment for a shell service process. Precedence (last wins):
 * inherited base env -> env_file -> resolved service environment -> automatic
 * `WOS_SERVICE_PORT` / `WOS_SERVICE_HOSTNAME` for the first configured port.
 */
export async function buildShellServiceEnvironment(opts: {
  config: WosConfig;
  service: string;
  svc: AppServiceConfig;
  worktreeRoot: string;
  assignments: PortAssignments;
  tunnelHostnames: ShellTunnelHostnames;
  tunnelUrls: ShellTunnelUrls;
  runtimeArguments?: RuntimeArgumentMap;
  baseEnv: Record<string, string>;
  serviceBind?: string;
}): Promise<{ env: Record<string, string>; ports: Record<string, number> }> {
  const tctx: TemplateContext = {
    config: opts.config,
    assignments: opts.assignments,
    tunnelHostnames: opts.tunnelHostnames,
    tunnelUrls: opts.tunnelUrls,
    declaredArguments: new Set(opts.config.arguments ?? []),
    submittedArguments: opts.runtimeArguments ?? {},
    serviceBind: opts.serviceBind,
  };
  const env: Record<string, string> = { ...opts.baseEnv };

  if (opts.svc.envFile) {
    const envFilePath = isAbsolute(opts.svc.envFile)
      ? opts.svc.envFile
      : resolve(opts.worktreeRoot, opts.svc.envFile);
    const file = Bun.file(envFilePath);
    if (!(await file.exists())) {
      throw new ShellRuntimeError(
        `app.services.${opts.service}.env_file not found: ${envFilePath}`,
      );
    }
    const parsed = parseEnvFileContents(await file.text(), envFilePath);
    Object.assign(env, parsed);
  }

  for (const key of Object.keys(opts.svc.environment).sort()) {
    env[key] = resolveShellTemplateValue(
      opts.svc.environment[key]!,
      `app.services.${opts.service}.environment.${key}`,
      tctx,
    );
  }

  const ports: Record<string, number> = {};
  for (const p of opts.svc.ports) {
    const host = opts.assignments[opts.service]?.[String(p.containerPort)];
    if (typeof host === "number") ports[String(p.containerPort)] = host;
  }

  // Automatic wos variables win last so wos-aware services cannot be pointed at
  // a stale user value. Described by the first configured port only.
  const firstPort = opts.svc.ports[0];
  if (firstPort) {
    const host = ports[String(firstPort.containerPort)];
    if (typeof host === "number") {
      env.WOS_SERVICE_PORT = String(host);
      env.WOS_SERVICE_HOSTNAME =
        opts.tunnelHostnames[opts.service]?.[String(firstPort.containerPort)] ??
        opts.serviceBind ??
        "localhost";
    }
  }

  return { env, ports };
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Build the host process argv for a shell-mode script.
 *
 * POSIX wraps the commands in `sh -lc "(c1) && (c2)"`: each `(...)` is a
 * subshell so a `cd` or env change in one command cannot leak into the next,
 * and `&&` stops on the first failure.
 *
 * Windows has no equivalent single-string form: `cmd.exe`'s `(...)` does not
 * fork (a `cd` leaks), and `Bun.spawn` escapes embedded `"` to `\"` so the
 * `/c` argument cannot carry quoted paths. Instead we write a batch runner that
 * wraps each command in `setlocal`/`endlocal` — which restores both the current
 * directory and the environment — with stop-on-first-failure, and execute the
 * batch directly so `Bun` handles the executable path (spaces included). The
 * batch file's verbatim content avoids the argument-escaping problem entirely.
 */
export function buildScriptInvocation(opts: {
  script: string[];
  /** Where to write the `.cmd` runner on Windows. Ignored on POSIX. */
  runnerPath: string;
}): { command: string[] } {
  if (!IS_WINDOWS) {
    const joined = opts.script.map((c) => `(${c})`).join(" && ");
    return { command: ["sh", "-lc", joined] };
  }
  writeFileSync(opts.runnerPath, windowsBatchBody(opts.script), "utf8");
  return { command: [opts.runnerPath] };
}

/** CRLF batch body: each command isolated via setlocal/endlocal, stop on failure. */
export function windowsBatchBody(script: string[]): string {
  const lines: string[] = ["@echo off"];
  for (const c of script) {
    lines.push("setlocal");
    lines.push(c);
    // `%errorlevel%` here expands to the just-run command's code (parse-time
    // expansion), so the batch exits with the real failing code, mirroring the
    // POSIX `&&` short-circuit.
    lines.push("if errorlevel 1 exit /b %errorlevel%");
    lines.push("endlocal");
  }
  return lines.join("\r\n") + "\r\n";
}

function sanitizeRunnerName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Path of the per-service Windows batch runner, alongside the session logs. */
function shellRunnerPath(worktreeRoot: string, service: string): string {
  return resolve(
    sessionShellLogDir(worktreeRoot),
    `${sanitizeRunnerName(service)}.runner.cmd`,
  );
}

function processEnvStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Build runtime-neutral `ServiceStatus` snapshots from persisted shell state.
 * A recorded pid that is no longer alive is reported as `exited`; no Docker
 * state is consulted.
 */
export function shellServiceStatuses(
  state: WosState,
  host: ShellProcessHost = defaultShellProcessHost,
): ServiceStatus[] {
  const services = state.shell?.services ?? {};
  return Object.keys(services)
    .sort()
    .map((service) => {
      const meta = services[service]!;
      const alive = host.isAlive(meta.pid);
      const ports = Object.keys(meta.ports)
        .map(Number)
        .sort((a, b) => a - b)
        .map((containerPort) => ({
          containerPort,
          hostPort: meta.ports[String(containerPort)]!,
          hostIp: "127.0.0.1",
          protocol: "tcp",
        }));
      return {
        service,
        state: alive ? "running" : "exited",
        status: alive ? "running" : "exited",
        ports,
        restartCount: 0,
      } satisfies ServiceStatus;
    });
}

async function stopShellService(
  meta: ShellServiceRuntimeState,
  host: ShellProcessHost,
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const target = { pid: meta.pid, processGroupId: meta.processGroupId };
  if (!host.isAlive(meta.pid)) return;
  host.kill(target, "SIGTERM");
  const step = 50;
  let waited = 0;
  while (waited < graceMs) {
    if (!host.isAlive(meta.pid)) return;
    await sleep(step);
    waited += step;
  }
  if (host.isAlive(meta.pid)) host.kill(target, "SIGKILL");
}

export interface ShellStopOptions {
  shellProcessHost?: ShellProcessHost;
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Stop every recorded shell service for an initialized session. */
export async function stopAllShellServices(
  state: WosState,
  opts: ShellStopOptions = {},
): Promise<void> {
  const host = opts.shellProcessHost ?? defaultShellProcessHost;
  const services = state.shell?.services ?? {};
  for (const name of Object.keys(services)) {
    await stopShellService(services[name]!, host, opts);
  }
}

/** Stop a single recorded shell service, leaving the others running. */
export async function stopOneShellService(
  state: WosState,
  service: string,
  opts: ShellStopOptions = {},
): Promise<void> {
  const host = opts.shellProcessHost ?? defaultShellProcessHost;
  const meta = state.shell?.services[service];
  if (!meta) {
    throw new ShellRuntimeError(`shell service "${service}" is not managed by this session`);
  }
  await stopShellService(meta, host, opts);
}

async function spawnShellService(opts: {
  config: WosConfig;
  service: string;
  svc: AppServiceConfig;
  worktreeRoot: string;
  assignments: PortAssignments;
  tunnelHostnames: ShellTunnelHostnames;
  tunnelUrls: ShellTunnelUrls;
  runtimeArguments?: RuntimeArgumentMap;
  baseEnv: Record<string, string>;
  host: ShellProcessHost;
  now: () => Date;
  serviceBind?: string;
}): Promise<ShellServiceRuntimeState> {
  const cwd = opts.svc.cwd
    ? resolve(opts.worktreeRoot, opts.svc.cwd)
    : resolve(opts.worktreeRoot);
  const { env, ports } = await buildShellServiceEnvironment({
    config: opts.config,
    service: opts.service,
    svc: opts.svc,
    worktreeRoot: opts.worktreeRoot,
    assignments: opts.assignments,
    tunnelHostnames: opts.tunnelHostnames,
    tunnelUrls: opts.tunnelUrls,
    runtimeArguments: opts.runtimeArguments,
    baseEnv: opts.baseEnv,
    serviceBind: opts.serviceBind,
  });
  const { command } = buildScriptInvocation({
    script: opts.svc.script,
    runnerPath: shellRunnerPath(opts.worktreeRoot, opts.service),
  });
  const stdoutPath = sessionShellServiceLogPath(opts.worktreeRoot, opts.service, "stdout");
  const stderrPath = sessionShellServiceLogPath(opts.worktreeRoot, opts.service, "stderr");
  const handle = opts.host.spawn({ command, cwd, env, stdoutPath, stderrPath });
  return {
    pid: handle.pid,
    ...(handle.processGroupId !== undefined ? { processGroupId: handle.processGroupId } : {}),
    command,
    cwd,
    environmentKeys: Object.keys(env).sort(),
    logFiles: { stdout: stdoutPath, stderr: stderrPath },
    startedAt: opts.now().toISOString(),
    ports,
  };
}

/**
 * Run shell init commands directly on the host. Output is streamed to the
 * observer's `init` channel. Throws on a non-zero exit so first-run setup
 * aborts before any service is started.
 */
async function runHostInit(opts: {
  commands: string[];
  cwd: string;
  env: Record<string, string>;
  observer: DeploymentObserver;
}): Promise<void> {
  if (opts.commands.length === 0) return;
  const sink = logSink(opts.observer, "init" satisfies LogChannel);
  // On Windows the init commands run through a throwaway batch runner (see
  // `buildScriptInvocation`); it is removed once the process exits.
  const runnerPath = IS_WINDOWS
    ? resolve(tmpdir(), `wos-init-${crypto.randomUUID()}.cmd`)
    : "";
  const { command } = buildScriptInvocation({
    script: opts.commands,
    runnerPath,
  });
  const proc = Bun.spawn(command, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const decoder = new TextDecoder();
  const pump = async (
    stream: ReadableStream<Uint8Array> | null,
    onChunk: (text: string) => void,
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) onChunk(text);
      }
    } finally {
      reader.releaseLock();
    }
  };
  await Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array> | null, sink.onStdout),
    pump(proc.stderr as ReadableStream<Uint8Array> | null, sink.onStderr),
  ]);
  const exitCode = await proc.exited;
  if (runnerPath) {
    try {
      rmSync(runnerPath, { force: true });
    } catch {
      /* best-effort cleanup of the throwaway runner */
    }
  }
  if (exitCode !== 0) {
    throw new ShellRuntimeError(`shell init failed (exit ${exitCode})`);
  }
}

/** Shell-mode `up`. Mirrors `runUpProgram` without Docker Compose. */
export async function runShellUpProgram(deps: RunShellUpDeps): Promise<WosState> {
  const host = deps.shellProcessHost ?? defaultShellProcessHost;
  const isPortAvailable = deps.isPortAvailable ?? defaultIsPortAvailable;
  const now = deps.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const observer = deps.observer ?? nullObserver;
  const baseEnv = deps.shellBaseEnv ?? processEnvStrings();

  validateRuntimeArguments(deps.config, deps.runtimeArguments);

  observer.emit({ type: "step", id: "prepare", state: "running" });
  const statePath = stateFilePath(deps.worktreeRoot);
  const existing = await readState(statePath);
  let selection: ResolvedServiceSelection;
  try {
    selection = resolveServiceSelection(deps.config, deps.selection ?? { kind: "all" });
  } catch (e) {
    if (e instanceof ServiceSelectionError) {
      observer.emit({ type: "step", id: "prepare", state: "failed", message: e.message });
    }
    throw e;
  }
  const selectedSet = new Set(selection.services);
  const bindings = collectBindings(deps.config, selectedSet);
  observer.emit({ type: "step", id: "prepare", state: "done" });

  // Replace any prior shell deployment by stopping its recorded services.
  if (existing?.shell && Object.keys(existing.shell.services).length > 0) {
    observer.emit({ type: "step", id: "release-ports", state: "running" });
    await stopAllShellServices(existing, { shellProcessHost: host });
    observer.emit({ type: "step", id: "release-ports", state: "done" });
  }

  const sourceMode = isSourceWorktree(deps.worktreeRoot, deps.source);
  if (deps.force && !sourceMode) {
    await forceRemoveCloneVolumes(deps.worktreeRoot, deps.config.cloneVolumes);
  }

  let assignments: PortAssignments;
  if (deps.config.dynamicPorts !== false) {
    assignments = await allocatePorts(
      {
        projectName: deps.projectName,
        range: deps.config.hostPorts,
        bindings,
        previous: existing?.portAssignments,
      },
      isPortAvailable,
    );
  } else {
    assignments = assignStaticPorts(bindings);
    await assertStaticPortsAvailable(assignments, isPortAvailable);
  }

  const tunnelPreparer = deps.noTunnel ? undefined : deps.tunnelPreparer;
  if (deps.noTunnel) await deps.tunnelPreparer?.skip();
  const tunnelResolution =
    (await tunnelPreparer?.prepare(assignments)) ?? emptyTunnelResolution();
  // A preparer may return a partial object (e.g. `{}` when no tunnel server is
  // running); `??` only guards a nullish whole, so default the maps explicitly.
  const tunnelHostnames = tunnelResolution.hostnames ?? {};
  const tunnelUrls = tunnelResolution.urls ?? {};

  const deploymentId = generateDeploymentId();
  const needsSetup = !existing || !existing.initialized || !!deps.force;
  if (needsSetup) {
    observer.emit({ type: "step", id: "first-run-setup", state: "running" });
    const serviceInits = selection.services
      .filter((name) => {
        const svc = deps.config.app.services[name];
        return svc !== undefined && (svc.initScript ?? []).length > 0;
      })
      .map((name) => {
        const svc = deps.config.app.services[name]!;
        return {
          service: name,
          commands: svc.initScript ?? [],
          workingDir: svc.cwd ?? undefined,
        };
      });
    await firstRunSetup({
      sourceRoot: deps.source.path,
      currentRoot: deps.worktreeRoot,
      cloneVolumes: sourceMode ? [] : deps.config.cloneVolumes,
      initScript: deps.config.app.initScript,
      serviceInits,
      cacheEntries: deps.config.cache,
      cacheRoot: deps.cacheRoot,
      observer,
      runInit: async (commands) => {
        observer.emit({ type: "step", id: "init-script", state: "running" });
        try {
          await runHostInit({
            commands,
            cwd: resolve(deps.worktreeRoot),
            env: baseEnv,
            observer,
          });
          observer.emit({ type: "step", id: "init-script", state: "done" });
        } catch (e) {
          observer.emit({
            type: "step",
            id: "init-script",
            state: "failed",
            message: (e as Error).message,
          });
          throw e;
        }
      },
      runServiceInit: async (phase) => {
        observer.emit({ type: "step", id: "init-script", state: "running" });
        try {
          await runHostInit({
            commands: phase.commands,
            cwd: phase.workingDir
              ? resolve(deps.worktreeRoot, phase.workingDir)
              : resolve(deps.worktreeRoot),
            env: baseEnv,
            observer,
          });
          observer.emit({ type: "step", id: "init-script", state: "done" });
        } catch (e) {
          observer.emit({
            type: "step",
            id: "init-script",
            state: "failed",
            message: `service ${phase.service} init failed: ${(e as Error).message}`,
          });
          throw e;
        }
      },
    });
    observer.emit({ type: "step", id: "first-run-setup", state: "done" });
  }

  await mkdir(sessionShellLogDir(deps.worktreeRoot), { recursive: true });

  // A stop requested during setup must not spawn any service process.
  throwIfDeploymentCancelled(deps.signal);

  observer.emit({ type: "step", id: "compose-up", state: "running" });
  const shellServices: Record<string, ShellServiceRuntimeState> = {};
  try {
    for (const name of selection.services) {
      const svc = deps.config.app.services[name];
      if (!svc) continue;
      shellServices[name] = await spawnShellService({
        config: deps.config,
        service: name,
        svc,
        worktreeRoot: deps.worktreeRoot,
        assignments,
        tunnelHostnames,
        tunnelUrls,
        runtimeArguments: deps.runtimeArguments,
        baseEnv,
        host,
        now,
        serviceBind: deps.serviceBind,
      });
    }
  } catch (e) {
    observer.emit({
      type: "step",
      id: "compose-up",
      state: "failed",
      message: (e as Error).message,
    });
    // Stop anything that did start so a failed up does not leak processes.
    await stopAllShellServices(
      { ...(existing ?? ({} as WosState)), shell: { services: shellServices } } as WosState,
      { shellProcessHost: host },
    );
    throw e;
  }
  if (deps.progress) deps.progress.composeStarted = true;
  observer.emit({ type: "step", id: "compose-up", state: "done" });

  const shell: ShellRuntimeState = {
    services: shellServices,
    ...(deps.runtimeArguments && Object.keys(deps.runtimeArguments).length > 0
      ? { runtimeArguments: deps.runtimeArguments }
      : {}),
  };
  let state: WosState = {
    initialized: true,
    projectName: deps.projectName,
    composeFile: "",
    backend: "shell",
    mode: "shell",
    shell,
    portAssignments: assignments,
    worktreeRoot: deps.worktreeRoot,
    sourcePath: deps.source.path,
    deploymentId,
  };
  await writeState(statePath, state);

  observer.emit({ type: "step", id: "status", state: "running" });
  const services = shellServiceStatuses(state, host);
  observer.emit({ type: "step", id: "status", state: "done" });
  observer.emit({
    type: "services-discovered",
    services: services.map((s) => s.service),
    composeContext: { projectName: deps.projectName, composeFile: "" },
  });

  observer.emit({ type: "step", id: "healthcheck", state: "running" });
  stdout(formatStatus(services) + "\n");
  const waitingSnapshot = waitingHealthcheckSnapshot(
    deps.config,
    services,
    deps.healthcheckDefaults,
    selectedSet,
  );
  const waitingLines = formatHealthchecks(waitingSnapshot);
  if (waitingLines.length > 0) stdout(waitingLines + "\n");
  let healthchecks: AppPortHealthcheckResult[];
  try {
    healthchecks = await runAppPortHealthchecks({
      config: deps.config,
      services,
      http: deps.healthcheckHttp,
      defaults: deps.healthcheckDefaults,
      mode: "wait",
      signal: deps.signal,
      selectedServices: selectedSet,
      onAttempt: (a) => {
        const outcome = a.matched
          ? "ok"
          : a.status !== undefined
          ? `HTTP ${a.status}`
          : a.error ?? "error";
        stdout(
          `  healthcheck ${a.service}:${a.containerPort} attempt ${a.attempt} ${a.url} → ${outcome}\n`,
        );
      },
    });
  } catch (e) {
    observer.emit({
      type: "step",
      id: "healthcheck",
      state: "failed",
      message: (e as Error).message,
    });
    throw e;
  }
  // An aborted wait loop returns failure results rather than throwing; treat a
  // stop request as a cancellation instead of a healthcheck failure so the
  // daemon tears down cleanly rather than surfacing a scary failure.
  throwIfDeploymentCancelled(deps.signal);
  const healthLines = formatHealthchecks(healthchecks);
  if (healthLines.length > 0) stdout(healthLines + "\n");
  if (hasRequiredHealthcheckFailure(healthchecks)) {
    const message = `app-port healthcheck failed: ${summarizeHealthcheckFailures(healthchecks)}`;
    observer.emit({ type: "step", id: "healthcheck", state: "failed", message });
    throw new Error(message);
  }
  observer.emit({ type: "step", id: "healthcheck", state: "done" });

  const finishedAt = now();
  const lastUp = finishedAt.toISOString();
  const durationMs = finishedAt.getTime() - startedAtMs;
  state = {
    ...state,
    lastUp,
    ...(deps.deployCommit ? { lastUpCommit: deps.deployCommit } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0
      ? { lastUpDurationMs: durationMs }
      : {}),
  };
  await writeState(statePath, state);
  observer.emit({ type: "complete", lastUp });
  return state;
}

/**
 * Re-resolve a shell service's configuration and start it again. Used by the
 * restart action. The caller stops the existing process first.
 */
export async function startShellServiceFromConfig(opts: {
  config: WosConfig;
  service: string;
  worktreeRoot: string;
  assignments: PortAssignments;
  tunnelHostnames?: ShellTunnelHostnames;
  tunnelUrls?: ShellTunnelUrls;
  runtimeArguments?: RuntimeArgumentMap;
  baseEnv?: Record<string, string>;
  host?: ShellProcessHost;
  now?: () => Date;
  serviceBind?: string;
}): Promise<ShellServiceRuntimeState> {
  const svc = opts.config.app.services[opts.service];
  if (!svc) {
    throw new ShellRuntimeError(
      `shell service "${opts.service}" is not declared in app.services`,
    );
  }
  await mkdir(sessionShellLogDir(opts.worktreeRoot), { recursive: true });
  return spawnShellService({
    config: opts.config,
    service: opts.service,
    svc,
    worktreeRoot: opts.worktreeRoot,
    assignments: opts.assignments,
    tunnelHostnames: opts.tunnelHostnames ?? {},
    tunnelUrls: opts.tunnelUrls ?? {},
    runtimeArguments: opts.runtimeArguments,
    baseEnv: opts.baseEnv ?? processEnvStrings(),
    host: opts.host ?? defaultShellProcessHost,
    now: opts.now ?? (() => new Date()),
    serviceBind: opts.serviceBind,
  });
}

/** Convenience predicate re-exported for callers branching on backend. */
export { isShellMode };
