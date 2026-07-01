import { test, expect } from "bun:test";
import { planFromDiscovery } from "./daemon-host";
import type { UiHealthResponse } from "@worktreeos/daemon/ui-protocol";

const health = { ok: true } as unknown as UiHealthResponse;

test("healthy daemon → adopt its URL", () => {
  expect(
    planFromDiscovery({ kind: "healthy", baseUrl: "http://127.0.0.1:4949", health }),
  ).toEqual({ action: "adopt", baseUrl: "http://127.0.0.1:4949" });
});

test("absent daemon → host in-process", () => {
  expect(planFromDiscovery({ kind: "absent" })).toEqual({ action: "host" });
});

test("incompatible daemon → replace (after confirmation)", () => {
  expect(
    planFromDiscovery({
      kind: "incompatible",
      baseUrl: "http://127.0.0.1:4949",
      health,
      pid: 123,
    }),
  ).toEqual({ action: "replace", baseUrl: "http://127.0.0.1:4949" });
});
