export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Optional execution context for docker commands. Passed as the last
 * argument so existing runners that ignore it continue to work.
 */
export interface DockerRunOptions {
  /**
   * Process environment for the spawned docker process. When set, replaces
   * the inherited environment completely — callers are responsible for
   * merging with `process.env` if they want to inherit ambient variables.
   */
  env?: Record<string, string>;
}

export type DockerRunner = (
  args: string[],
  opts?: DockerRunOptions,
) => Promise<DockerResult>;

export const defaultDockerRunner: DockerRunner = async (args, opts) => {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    ...(opts?.env ? { env: opts.env } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

export interface StreamSinks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface StreamingDockerResult {
  exitCode: number;
  stderr: string;
}

export type StreamingDockerRunner = (
  args: string[],
  sinks: StreamSinks,
  opts?: DockerRunOptions,
) => Promise<StreamingDockerResult>;

export const defaultStreamingDockerRunner: StreamingDockerRunner = async (
  args,
  sinks,
  opts,
) => {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    ...(opts?.env ? { env: opts.env } : {}),
  });
  const decoder = new TextDecoder();
  let stderrAcc = "";

  const pump = async (
    stream: ReadableStream<Uint8Array> | undefined,
    onChunk?: (text: string) => void,
    capture?: (text: string) => void,
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length === 0) continue;
        capture?.(text);
        onChunk?.(text);
      }
      const tail = decoder.decode();
      if (tail.length > 0) {
        capture?.(tail);
        onChunk?.(tail);
      }
    } finally {
      reader.releaseLock();
    }
  };

  await Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array> | undefined, sinks.onStdout),
    pump(proc.stderr as ReadableStream<Uint8Array> | undefined, sinks.onStderr, (t) => {
      stderrAcc += t;
    }),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stderr: stderrAcc };
};

export interface ComposeContext {
  projectName: string;
  /**
   * Primary Compose file. In generated mode this is the wos-generated
   * file. In compose mode this is the wos-owned sanitized base file
   * (`composeFiles[0]`) so older readers see a single file path.
   */
  composeFile: string;
  /**
   * Ordered list of Compose files to pass to Docker Compose. When set, every
   * file emits a `-f` flag in order. When omitted, behavior falls back to
   * `composeFile` alone (preserving generated-mode single-file semantics).
   */
  composeFiles?: string[];
}

export function composeFilesOf(ctx: ComposeContext): string[] {
  if (ctx.composeFiles && ctx.composeFiles.length > 0) return ctx.composeFiles;
  return [ctx.composeFile];
}

export function composeArgs(ctx: ComposeContext, extra: string[]): string[] {
  const fileFlags: string[] = [];
  for (const f of composeFilesOf(ctx)) {
    fileFlags.push("-f", f);
  }
  return ["compose", "-p", ctx.projectName, ...fileFlags, ...extra];
}

export class ComposeError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string = "") {
    super(message);
    this.stderr = stderr;
  }
}

export interface ComposeDownOptions {
  removeOrphans?: boolean;
}

function composeDownArgs(ctx: ComposeContext, options: ComposeDownOptions): string[] {
  const extra: string[] = ["down"];
  if (options.removeOrphans) extra.push("--remove-orphans");
  return composeArgs(ctx, extra);
}

export interface ComposeEnvOption {
  /** Optional environment for Docker Compose invocations. */
  env?: Record<string, string>;
}

export async function composeDown(
  ctx: ComposeContext,
  options: ComposeDownOptions = {},
  runner: DockerRunner = defaultDockerRunner,
  env?: ComposeEnvOption,
): Promise<void> {
  const { exitCode, stderr } = await runner(composeDownArgs(ctx, options), env);
  if (exitCode !== 0) {
    throw new ComposeError(`docker compose down failed: ${stderr.trim()}`, stderr);
  }
}

export async function composeUp(
  ctx: ComposeContext,
  runner: DockerRunner = defaultDockerRunner,
  env?: ComposeEnvOption,
): Promise<void> {
  const { exitCode, stderr } = await runner(
    composeArgs(ctx, ["up", "-d", "--force-recreate"]),
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(`docker compose up -d failed: ${stderr.trim()}`, stderr);
  }
}

export async function composePs(
  ctx: ComposeContext,
  runner: DockerRunner = defaultDockerRunner,
  env?: ComposeEnvOption,
): Promise<string> {
  const { stdout, stderr, exitCode } = await runner(
    composeArgs(ctx, ["ps", "--all", "--format", "json"]),
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(`docker compose ps failed: ${stderr.trim()}`, stderr);
  }
  return stdout;
}

export async function composeDownStreamed(
  ctx: ComposeContext,
  sinks: StreamSinks,
  runner: StreamingDockerRunner = defaultStreamingDockerRunner,
  options: ComposeDownOptions = {},
  env?: ComposeEnvOption,
): Promise<void> {
  const { exitCode, stderr } = await runner(
    composeDownArgs(ctx, options),
    sinks,
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(`docker compose down failed: ${stderr.trim()}`, stderr);
  }
}

export async function composeUpStreamed(
  ctx: ComposeContext,
  sinks: StreamSinks,
  runner: StreamingDockerRunner = defaultStreamingDockerRunner,
  env?: ComposeEnvOption,
): Promise<void> {
  const { exitCode, stderr } = await runner(
    composeArgs(ctx, ["up", "-d", "--force-recreate"]),
    sinks,
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(`docker compose up -d failed: ${stderr.trim()}`, stderr);
  }
}

export async function composePsStreamed(
  ctx: ComposeContext,
  sinks: StreamSinks,
  runner: StreamingDockerRunner = defaultStreamingDockerRunner,
  env?: ComposeEnvOption,
): Promise<string> {
  let stdoutAcc = "";
  const { exitCode, stderr } = await runner(
    composeArgs(ctx, ["ps", "--all", "--format", "json"]),
    {
      onStdout: (chunk) => {
        stdoutAcc += chunk;
        sinks.onStdout?.(chunk);
      },
      onStderr: sinks.onStderr,
    },
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(`docker compose ps failed: ${stderr.trim()}`, stderr);
  }
  return stdoutAcc;
}

export async function composeStopService(
  ctx: ComposeContext,
  service: string,
  runner: DockerRunner = defaultDockerRunner,
  env?: ComposeEnvOption,
): Promise<void> {
  const { exitCode, stderr } = await runner(
    composeArgs(ctx, ["stop", service]),
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(
      `docker compose stop ${service} failed: ${stderr.trim()}`,
      stderr,
    );
  }
}

export async function composeUpService(
  ctx: ComposeContext,
  service: string,
  runner: DockerRunner = defaultDockerRunner,
  env?: ComposeEnvOption,
): Promise<void> {
  const rm = await runner(composeArgs(ctx, ["rm", "-f", "-s", service]), env);
  if (rm.exitCode !== 0) {
    throw new ComposeError(
      `docker compose rm -f -s ${service} failed: ${rm.stderr.trim()}`,
      rm.stderr,
    );
  }
  const { exitCode, stderr } = await runner(
    composeArgs(ctx, ["up", "-d", service]),
    env,
  );
  if (exitCode !== 0) {
    throw new ComposeError(
      `docker compose up -d ${service} failed: ${stderr.trim()}`,
      stderr,
    );
  }
}

/**
 * Build the Docker Compose `exec` argument vector for running a one-off
 * command inside a managed service container. The command argv is appended
 * verbatim after the service name so flags and separators are preserved.
 */
export function composeExecArgs(
  ctx: ComposeContext,
  service: string,
  command: string[],
): string[] {
  return composeArgs(ctx, ["exec", service, ...command]);
}

export function composeLogsFollowArgs(
  ctx: ComposeContext,
  service: string,
  tail: number,
): string[] {
  return composeArgs(ctx, [
    "logs",
    "--follow",
    "--no-color",
    "--tail",
    String(tail),
    service,
  ]);
}

const PORT_CONFLICT_KEYWORDS =
  /(port is already allocated|address already in use|failed to bind|bind for|cannot start service.*port|driver failed programming external connectivity)/i;

export function isPortConflictStderr(stderr: string): boolean {
  return PORT_CONFLICT_KEYWORDS.test(stderr);
}

export function extractPortNumbers(stderr: string): number[] {
  const ports = new Set<number>();
  const re = /:(\d{1,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
  }
  return [...ports];
}
