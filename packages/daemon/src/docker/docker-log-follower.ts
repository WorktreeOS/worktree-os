/**
 * Service log followers backed by the Docker Engine API. Replaces the
 * `docker compose logs --follow` subprocess followers for daemon service log
 * streams: each follower resolves the current managed container for a
 * (session, service) pair from the Docker state cache and streams its logs.
 *
 * Services without a current container in the cache get no follower — the
 * log channel stays quiet until a container exists, matching the on-demand
 * subscription contract in `DaemonSessionRegistry`.
 */
import {
  followableServices,
  serviceChannel,
  type ServiceFollower,
} from "@worktreeos/runtime/service-logs";
import type { FollowerStarter } from "../daemon-sessions";
import type { DockerClient, DockerLogStream } from "./docker-client";
import type { DockerStateStore } from "./docker-state-store";

/** Default trailing line count for newly opened Docker log streams. */
const DEFAULT_TAIL = 1000;

export interface DockerLogFollowerStarterDeps {
  client: DockerClient;
  store: DockerStateStore;
  /** Trailing line count requested from the Docker logs API. Defaults to 1000. */
  tail?: number;
}

/**
 * Build a {@link FollowerStarter} that streams managed service logs over the
 * Docker logs API. The Docker logs payload is demultiplexed by
 * {@link DockerLogStream}; wos surfaces it on the service channel as a single
 * `stdout` text stream.
 */
export function createDockerLogFollowerStarter(
  deps: DockerLogFollowerStarterDeps,
): FollowerStarter {
  const tail = deps.tail ?? DEFAULT_TAIL;
  return ({ services, sessionName, sink }) => {
    if (!sessionName) return [];
    const followers: ServiceFollower[] = [];
    for (const service of followableServices(services)) {
      const target = deps.store.findCurrent(sessionName, service);
      if (!target) continue;
      const channel = serviceChannel(service);
      let stream: DockerLogStream | undefined;
      let stopped = false;
      const done = (async () => {
        try {
          stream = await deps.client.streamLogs(target.containerId, {
            follow: true,
            tail,
          });
          for await (const chunk of stream) {
            if (stopped) break;
            if (chunk.length > 0) sink(service, "stdout", chunk);
          }
        } catch {
          // A log stream error ends the follower quietly; the subscriber can
          // reconnect through the request-scoped subscription path.
        }
      })();
      followers.push({
        service,
        channel,
        stop: () => {
          stopped = true;
          try {
            stream?.abort();
          } catch {
            // already closed
          }
        },
        done,
      });
    }
    return followers;
  };
}
