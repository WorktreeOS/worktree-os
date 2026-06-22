import { statSync } from "node:fs";
import type { LogStream } from "@worktreeos/core/events";
import {
  serviceChannel,
  type ServiceFollower,
} from "@worktreeos/runtime/service-logs";
import type { ShellServiceRuntimeState } from "@worktreeos/core/state";
import type { FollowerStarter } from "../daemon-sessions";
import { readSessionState } from "./backend-selection";

const DEFAULT_POLL_MS = 200;
/** Initial tail window so a new subscriber sees recent context, not the whole file. */
const INITIAL_TAIL_BYTES = 256 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a `FollowerStarter` that streams shell service logs by tailing the
 * session-scoped log files the service processes write to directly. Because
 * the child processes own the file descriptors, log content survives daemon
 * restarts and these followers can re-attach to the persisted files.
 */
export function createShellFollowerStarter(
  opts: { env?: NodeJS.ProcessEnv; pollMs?: number } = {},
): FollowerStarter {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  return ({ services, sink, sessionName }) => {
    if (!sessionName) return [];
    const state = readSessionState(sessionName, opts.env);
    if (!state?.shell) return [];
    const followers: ServiceFollower[] = [];
    for (const service of services) {
      const meta = state.shell.services[service];
      if (!meta) continue;
      followers.push(tailService(service, meta, sink, pollMs));
    }
    return followers;
  };
}

function tailService(
  service: string,
  meta: ShellServiceRuntimeState,
  sink: (service: string, stream: LogStream, chunk: string) => void,
  pollMs: number,
): ServiceFollower {
  let stopped = false;

  const tailStream = async (path: string, stream: LogStream): Promise<void> => {
    let offset = 0;
    let initialized = false;
    while (!stopped) {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        // File not created yet (process may not have written) — keep waiting.
        await sleep(pollMs);
        continue;
      }
      if (!initialized) {
        offset = size > INITIAL_TAIL_BYTES ? size - INITIAL_TAIL_BYTES : 0;
        initialized = true;
      }
      if (size < offset) {
        // File was truncated (a fresh `up` reset the logs) — restart from 0.
        offset = 0;
      }
      if (size > offset) {
        try {
          const text = await Bun.file(path).slice(offset, size).text();
          if (text.length > 0) sink(service, stream, text);
          offset = size;
        } catch {
          // Transient read error — retry on the next poll.
        }
      }
      await sleep(pollMs);
    }
  };

  const done = Promise.all([
    tailStream(meta.logFiles.stdout, "stdout"),
    tailStream(meta.logFiles.stderr, "stderr"),
  ]).then(() => {});

  return {
    service,
    channel: serviceChannel(service),
    stop: () => {
      stopped = true;
    },
    done,
  };
}
