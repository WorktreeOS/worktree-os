import {
  composeLogsFollowArgs,
  defaultStreamingDockerRunner,
  type ComposeContext,
  type StreamingDockerRunner,
} from "@worktreeos/compose/compose";
import { INIT_SERVICE_NAME } from "@worktreeos/compose/generated-compose";
import { logSink, type DeploymentObserver, type LogChannel } from "@worktreeos/core/events";

export interface ServiceFollower {
  service: string;
  channel: LogChannel;
  /** Returns when the follower has been signaled to stop. */
  stop: () => void;
  /** Resolves when the follower process exits. */
  done: Promise<void>;
}

export interface FollowerStarterOptions {
  ctx: ComposeContext;
  services: string[];
  observer: DeploymentObserver;
  tail?: number;
  /**
   * Spawn implementation; defaults to `Bun.spawn`. Tests inject a fake.
   * The spawned process is expected to expose `kill()` and `exited`.
   */
  spawn?: SpawnFn;
  /**
   * Optional process environment forwarded to every follower process. Used
   * in compose mode so `docker compose logs --follow` sees the same
   * configured env-file/inline environment as `up` and `status` commands.
   */
  env?: Record<string, string>;
}

export type ProcessHandle = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: string | number) => void;
};

export type SpawnFn = (
  args: string[],
  opts?: { env?: Record<string, string> },
) => ProcessHandle;

const DEFAULT_TAIL = 1000;

export function followableServices(services: string[]): string[] {
  return services.filter((s) => s !== INIT_SERVICE_NAME);
}

export function serviceChannel(service: string): LogChannel {
  return `service:${service}` as const;
}

export function startServiceFollowers(opts: FollowerStarterOptions): ServiceFollower[] {
  const tail = opts.tail ?? DEFAULT_TAIL;
  const spawn = opts.spawn ?? defaultSpawn;
  const followers: ServiceFollower[] = [];
  const spawnOpts = opts.env ? { env: opts.env } : undefined;
  for (const service of followableServices(opts.services)) {
    const args = composeLogsFollowArgs(opts.ctx, service, tail);
    const proc = spawn(args, spawnOpts);
    const channel = serviceChannel(service);
    const sinks = logSink(opts.observer, channel);
    const decoder = new TextDecoder();
    const pump = async (
      stream: ReadableStream<Uint8Array> | null,
      onChunk?: (text: string) => void,
    ) => {
      if (!stream || !onChunk) return;
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text.length > 0) onChunk(text);
        }
        const tail = decoder.decode();
        if (tail.length > 0) onChunk(tail);
      } catch {
        // Reader cancelled while shutting down — silent.
      } finally {
        reader.releaseLock();
      }
    };
    const done = (async () => {
      await Promise.all([pump(proc.stdout, sinks.onStdout), pump(proc.stderr, sinks.onStderr)]);
      await proc.exited.catch(() => 0);
    })();
    followers.push({
      service,
      channel,
      stop: () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // Already exited; ignore.
        }
      },
      done,
    });
  }
  return followers;
}

export async function stopServiceFollowers(followers: ServiceFollower[]): Promise<void> {
  for (const f of followers) f.stop();
  await Promise.allSettled(followers.map((f) => f.done));
}

export function defaultSpawn(
  args: string[],
  opts?: { env?: Record<string, string> },
): ProcessHandle {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts?.env ? { env: opts.env } : {}),
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array> | null,
    stderr: proc.stderr as ReadableStream<Uint8Array> | null,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal as any),
  };
}

// Re-export for callers that build their own followers off the same runner.
export { defaultStreamingDockerRunner };
export type { StreamingDockerRunner };
