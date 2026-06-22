import { test, expect, describe } from "bun:test";
import { runDnsHook } from "@worktreeos/daemon/acme/dns-hook";

describe("runDnsHook", () => {
  test("exit 0 with stdout/env propagation", async () => {
    const result = await runDnsHook(
      'echo "name=$WOS_ACME_RECORD_NAME phase=$WOS_ACME_HOOK_PHASE"',
      {
        phase: "create",
        recordName: "_acme-challenge.example.com",
        recordValue: "abc",
        baseDomain: "example.com",
        listenerKind: "tunnel",
        certificateNames: ["example.com", "*.example.com"],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("name=_acme-challenge.example.com");
    expect(result.stdout).toContain("phase=create");
  });

  test("non-zero exit reports failure with stderr", async () => {
    const result = await runDnsHook(
      'echo "boom" 1>&2; exit 17',
      {
        phase: "create",
        recordName: "_acme-challenge.example.com",
        recordValue: "abc",
        baseDomain: "example.com",
        listenerKind: "web",
        certificateNames: ["example.com"],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(17);
    expect(result.stderr).toContain("boom");
  });

  test("timeout kills the process", async () => {
    const result = await runDnsHook(
      "sleep 5",
      {
        phase: "create",
        recordName: "_acme-challenge.example.com",
        recordValue: "abc",
        baseDomain: "example.com",
        listenerKind: "web",
        certificateNames: ["example.com"],
      },
      { timeoutMs: 100 },
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("timed out");
  });
});
