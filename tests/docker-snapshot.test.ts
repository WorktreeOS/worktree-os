import { test, expect, describe } from "bun:test";
import {
  normalizeInspect,
  normalizeListItem,
  normalizeStats,
} from "@worktreeos/daemon/docker/docker-snapshot";
import type {
  DockerContainerInspect,
  DockerContainerListItem,
  DockerContainerStats,
} from "@worktreeos/daemon/docker/docker-client";

const LABELS = {
  "dev.wos.managed": "true",
  "dev.wos.schema": "1",
  "dev.wos.home-hash": "H",
  "dev.wos.session": "s",
  "dev.wos.project": "proj",
  "dev.wos.mode": "generated",
  "dev.wos.service": "api",
};

function inspect(
  overrides: Partial<DockerContainerInspect> = {},
): DockerContainerInspect {
  return {
    Id: "c1",
    Name: "/c1",
    Image: "node:22",
    RestartCount: 3,
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: 1,
      ExitCode: 0,
      StartedAt: "2026-05-29T00:00:00.000Z",
    },
    Config: { Labels: LABELS },
    NetworkSettings: { Ports: {} },
    ...overrides,
  };
}

describe("normalizeInspect lifecycle fields", () => {
  test("captures start time and restart count", () => {
    const snap = normalizeInspect(inspect());
    expect(snap?.startedAt).toBe("2026-05-29T00:00:00.000Z");
    expect(snap?.restartCount).toBe(3);
  });

  test("leaves fields unset when inspect omits them", () => {
    const snap = normalizeInspect(
      inspect({
        RestartCount: undefined,
        State: {
          Status: "running",
          Running: true,
          Paused: false,
          Restarting: false,
          OOMKilled: false,
          Dead: false,
          Pid: 1,
          ExitCode: 0,
        },
      }),
    );
    expect(snap?.startedAt).toBeUndefined();
    expect(snap?.restartCount).toBeUndefined();
  });
});

describe("normalizeStats resource usage", () => {
  function stats(overrides: Partial<DockerContainerStats> = {}): DockerContainerStats {
    return {
      cpu_stats: {
        cpu_usage: { total_usage: 200 },
        system_cpu_usage: 2000,
        online_cpus: 4,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 100 },
        system_cpu_usage: 1000,
      },
      memory_stats: { usage: 200 * 1024 * 1024, limit: 512 * 1024 * 1024 },
      ...overrides,
    };
  }

  test("computes CPU% via the standard delta formula", () => {
    // cpuDelta=100, systemDelta=1000 -> 0.1 * 4 cores * 100 = 40%
    const usage = normalizeStats(stats());
    expect(usage?.cpuPercent).toBeCloseTo(40, 5);
    expect(usage?.memUsedBytes).toBe(200 * 1024 * 1024);
    expect(usage?.memLimitBytes).toBe(512 * 1024 * 1024);
  });

  test("subtracts page cache from memory usage when present", () => {
    const usage = normalizeStats(
      stats({
        memory_stats: {
          usage: 200 * 1024 * 1024,
          limit: 512 * 1024 * 1024,
          stats: { inactive_file: 50 * 1024 * 1024 },
        },
      }),
    );
    expect(usage?.memUsedBytes).toBe(150 * 1024 * 1024);
  });

  test("omits CPU% when systemDelta is zero (first sample)", () => {
    const usage = normalizeStats(
      stats({
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 1000,
          online_cpus: 4,
        },
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 1000 },
      }),
    );
    expect(usage?.cpuPercent).toBeUndefined();
    expect(usage?.memUsedBytes).toBe(200 * 1024 * 1024);
  });

  test("omits CPU% when online_cpus is missing", () => {
    const usage = normalizeStats(
      stats({
        cpu_stats: {
          cpu_usage: { total_usage: 200 },
          system_cpu_usage: 2000,
        },
      }),
    );
    expect(usage?.cpuPercent).toBeUndefined();
  });

  test("returns null for an empty payload", () => {
    expect(normalizeStats({})).toBeNull();
    expect(normalizeStats(null)).toBeNull();
  });
});

describe("normalizeListItem lifecycle fields", () => {
  test("list-only data omits start time and restart count", () => {
    const item: DockerContainerListItem = {
      Id: "c1",
      Names: ["/c1"],
      Image: "node:22",
      ImageID: "",
      Labels: LABELS,
      State: "running",
      Status: "Up",
      Ports: [],
    };
    const snap = normalizeListItem(item);
    expect(snap?.startedAt).toBeUndefined();
    expect(snap?.restartCount).toBeUndefined();
  });
});
