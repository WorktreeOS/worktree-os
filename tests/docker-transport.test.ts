/**
 * Docker transport selection, parsing, and connection diagnostics.
 *
 * The parsing/selection tests are pure and run on every platform. The live
 * integration test is best-effort: it passes whether or not a Docker engine is
 * reachable, so CI without Docker stays green while a developer with Docker
 * Desktop running gets real coverage.
 */
import { describe, expect, test } from "bun:test";
import {
  DockerClient,
  DockerConnectionError,
  describeDockerTransport,
  parseDockerHost,
  resolveDockerTransport,
} from "@worktreeos/daemon/docker/docker-client";

describe("resolveDockerTransport — platform defaults", () => {
  test("Windows defaults to the docker_engine named pipe", () => {
    expect(resolveDockerTransport({ platform: "win32", env: {} })).toEqual({
      kind: "npipe",
      pipePath: "//./pipe/docker_engine",
    });
  });

  test("POSIX defaults to the Unix socket", () => {
    expect(resolveDockerTransport({ platform: "linux", env: {} })).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(resolveDockerTransport({ platform: "darwin", env: {} })).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
  });

  test("DOCKER_HOST overrides the platform default", () => {
    expect(
      resolveDockerTransport({ platform: "linux", env: { DOCKER_HOST: "tcp://10.0.0.5:2375" } }),
    ).toEqual({ kind: "tcp", host: "10.0.0.5", port: 2375 });
  });

  test("legacy socketPath / DOCKER_SOCKET still select a Unix socket", () => {
    expect(resolveDockerTransport({ platform: "linux", socketPath: "/run/docker.sock", env: {} })).toEqual(
      { kind: "unix", socketPath: "/run/docker.sock" },
    );
    expect(
      resolveDockerTransport({ platform: "linux", env: { DOCKER_SOCKET: "/run/d.sock" } }),
    ).toEqual({ kind: "unix", socketPath: "/run/d.sock" });
  });
});

describe("parseDockerHost", () => {
  test("npipe URL normalizes to the forward-slash pipe form net.connect needs", () => {
    expect(parseDockerHost("npipe:////./pipe/docker_engine")).toEqual({
      kind: "npipe",
      pipePath: "//./pipe/docker_engine",
    });
    expect(parseDockerHost("npipe:////./pipe/dockerDesktopLinuxEngine")).toEqual({
      kind: "npipe",
      pipePath: "//./pipe/dockerDesktopLinuxEngine",
    });
  });

  test("backslash UNC pipe normalizes to forward-slash form", () => {
    expect(parseDockerHost(String.raw`\\.\pipe\docker_engine`)).toEqual({
      kind: "npipe",
      pipePath: "//./pipe/docker_engine",
    });
  });

  test("tcp:// and http:// become a TCP transport", () => {
    expect(parseDockerHost("tcp://127.0.0.1:2375")).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 2375,
    });
    expect(parseDockerHost("http://docker.internal:2376")).toEqual({
      kind: "tcp",
      host: "docker.internal",
      port: 2376,
    });
  });

  test("unix:// and bare paths become a Unix socket transport", () => {
    expect(parseDockerHost("unix:///var/run/docker.sock", "linux")).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseDockerHost("/run/user/1000/docker.sock", "linux")).toEqual({
      kind: "unix",
      socketPath: "/run/user/1000/docker.sock",
    });
  });
});

describe("describeDockerTransport", () => {
  test("produces a transport-named description", () => {
    expect(describeDockerTransport({ kind: "unix", socketPath: "/var/run/docker.sock" })).toBe(
      "Unix socket /var/run/docker.sock",
    );
    expect(describeDockerTransport({ kind: "npipe", pipePath: "//./pipe/docker_engine" })).toBe(
      "Windows named pipe //./pipe/docker_engine",
    );
    expect(describeDockerTransport({ kind: "tcp", host: "h", port: 2375 })).toBe("TCP h:2375");
  });
});

describe("connection diagnostics", () => {
  test("an unreachable transport rejects with a transport-named DockerConnectionError", async () => {
    // A pipe that does not exist forces the connect failure path on every host
    // (net.connect treats the path as a missing socket/pipe).
    const client = new DockerClient({
      host: "npipe:////./pipe/wos-definitely-not-a-real-pipe-xyz",
    });
    let error: unknown;
    try {
      await client.listContainers();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DockerConnectionError);
    expect((error as DockerConnectionError).message).toContain("Windows named pipe");
    expect((error as DockerConnectionError).message).toContain("wos-definitely-not-a-real-pipe-xyz");
    expect((error as DockerConnectionError).transport.kind).toBe("npipe");
  });
});

describe("live Docker integration (best-effort)", () => {
  test("lists containers over the platform-default transport when Docker is reachable", async () => {
    const client = new DockerClient();
    try {
      const list = await client.listContainers();
      expect(Array.isArray(list)).toBe(true);
    } catch (e) {
      // No engine running (e.g. CI without Docker Desktop): the daemon must
      // surface a clear transport-named diagnostic, not crash.
      expect(e).toBeInstanceOf(DockerConnectionError);
    }
  });
});
