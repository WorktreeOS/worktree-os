import { test, expect, describe } from "bun:test";
import {
  cloudflareRunner,
  resolveCloudflareToken,
} from "@worktreeos/daemon/acme/dns-cloudflare";
import type {
  CloudflareClient,
  CloudflareTxtRecord,
} from "@worktreeos/daemon/acme/cloudflare-client";
import type { LetsEncryptCloudflareChallenge } from "@worktreeos/core/global-config";

function makeChallenge(
  overrides: Partial<LetsEncryptCloudflareChallenge> = {},
): LetsEncryptCloudflareChallenge {
  return {
    type: "dns-01",
    provider: "cloudflare",
    propagationSeconds: 0,
    apiTokenEnv: "CF_API_TOKEN",
    ...overrides,
  };
}

function makeContext(overrides: Partial<{
  recordName: string;
  recordValue: string;
  baseDomain: string;
}> = {}) {
  return {
    recordName: overrides.recordName ?? "_acme-challenge.example.com",
    recordValue: overrides.recordValue ?? "token-value",
    baseDomain: overrides.baseDomain ?? "example.com",
    listenerKind: "tunnel" as const,
    certificateNames: ["example.com", "*.example.com"],
  };
}

class FakeClient implements CloudflareClient {
  zones = new Map<string, string>(); // name -> id
  recordsByZone = new Map<string, CloudflareTxtRecord[]>();
  nextRecordId = 1;
  calls: Array<{ op: string; args: unknown[] }> = [];
  /** Force findZoneByName to throw. */
  zoneError?: Error;
  /** Force createTxtRecord to throw. */
  createError?: Error;
  /** Force deleteRecord to throw on the next call only. */
  oneShotDeleteError?: Error;

  async findZoneByName(name: string): Promise<string | undefined> {
    this.calls.push({ op: "findZoneByName", args: [name] });
    if (this.zoneError) throw this.zoneError;
    return this.zones.get(name);
  }
  async createTxtRecord(
    zoneId: string,
    name: string,
    content: string,
  ): Promise<string> {
    this.calls.push({ op: "createTxtRecord", args: [zoneId, name, content] });
    if (this.createError) throw this.createError;
    const id = `rec-${this.nextRecordId++}`;
    const list = this.recordsByZone.get(zoneId) ?? [];
    list.push({ id, name, content });
    this.recordsByZone.set(zoneId, list);
    return id;
  }
  async listTxtRecords(
    zoneId: string,
    name: string,
  ): Promise<CloudflareTxtRecord[]> {
    this.calls.push({ op: "listTxtRecords", args: [zoneId, name] });
    return (this.recordsByZone.get(zoneId) ?? []).filter((r) => r.name === name);
  }
  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    this.calls.push({ op: "deleteRecord", args: [zoneId, recordId] });
    if (this.oneShotDeleteError) {
      const e = this.oneShotDeleteError;
      this.oneShotDeleteError = undefined;
      throw e;
    }
    const list = this.recordsByZone.get(zoneId) ?? [];
    this.recordsByZone.set(
      zoneId,
      list.filter((r) => r.id !== recordId),
    );
  }
}

describe("resolveCloudflareToken", () => {
  test("returns env token when apiTokenEnv is set", () => {
    const result = resolveCloudflareToken(makeChallenge(), {
      CF_API_TOKEN: "env-token",
    } as NodeJS.ProcessEnv);
    if (!result.ok) throw new Error("expected success");
    expect(result.source).toBe("env");
    expect(result.token).toBe("env-token");
    expect(result.envName).toBe("CF_API_TOKEN");
  });

  test("env wins over direct token", () => {
    const result = resolveCloudflareToken(
      makeChallenge({ apiToken: "direct" }),
      { CF_API_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.token).toBe("env-token");
    expect(result.source).toBe("env");
  });

  test("falls back to direct token when env var is missing", () => {
    const result = resolveCloudflareToken(
      makeChallenge({ apiTokenEnv: undefined, apiToken: "direct" }),
      {} as NodeJS.ProcessEnv,
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.token).toBe("direct");
    expect(result.source).toBe("direct");
  });

  test("missing env var fails", () => {
    const result = resolveCloudflareToken(
      makeChallenge({ apiTokenEnv: "CF_MISSING" }),
      {} as NodeJS.ProcessEnv,
    );
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("CF_MISSING");
  });

  test("missing both token sources fails", () => {
    const result = resolveCloudflareToken(
      makeChallenge({ apiTokenEnv: undefined, apiToken: undefined }),
      {} as NodeJS.ProcessEnv,
    );
    if (result.ok) throw new Error("expected failure");
  });
});

describe("cloudflareRunner zone discovery", () => {
  test("uses explicit zoneId without API discovery", async () => {
    const fake = new FakeClient();
    const runner = cloudflareRunner(
      makeChallenge({ zoneId: "explicit-zone" }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.create(makeContext());
    expect(result.ok).toBe(true);
    expect(
      fake.calls.find((c) => c.op === "findZoneByName"),
    ).toBeUndefined();
    expect(fake.calls[0]?.op).toBe("createTxtRecord");
  });

  test("discovers zone by progressive suffix trim", async () => {
    const fake = new FakeClient();
    fake.zones.set("example.com", "discovered-zone");
    const runner = cloudflareRunner(
      makeChallenge(),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.create(
      makeContext({ recordName: "_acme-challenge.app.example.com" }),
    );
    expect(result.ok).toBe(true);
    const lookups = fake.calls
      .filter((c) => c.op === "findZoneByName")
      .map((c) => c.args[0]);
    expect(lookups).toContain("example.com");
  });

  test("zone discovery failure surfaces actionable error", async () => {
    const fake = new FakeClient();
    // no zones configured -> all lookups return undefined
    const runner = cloudflareRunner(
      makeChallenge(),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.create(makeContext());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not discover Cloudflare zone");
  });
});

describe("cloudflareRunner create/delete", () => {
  test("create publishes a TXT record", async () => {
    const fake = new FakeClient();
    fake.zones.set("example.com", "zone-1");
    const runner = cloudflareRunner(
      makeChallenge(),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.create(makeContext());
    expect(result.ok).toBe(true);
    expect(fake.recordsByZone.get("zone-1")).toHaveLength(1);
    expect(fake.recordsByZone.get("zone-1")?.[0]?.content).toBe("token-value");
  });

  test("create API failure is reported", async () => {
    const fake = new FakeClient();
    fake.zones.set("example.com", "zone-1");
    fake.createError = new Error("rate limited");
    const runner = cloudflareRunner(
      makeChallenge(),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.create(makeContext());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("rate limited");
  });

  test("delete removes the tracked record", async () => {
    const fake = new FakeClient();
    fake.zones.set("example.com", "zone-1");
    const runner = cloudflareRunner(
      makeChallenge({ zoneId: "zone-1" }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    await runner.create(makeContext());
    const result = await runner.delete(makeContext());
    expect(result.ok).toBe(true);
    expect(fake.recordsByZone.get("zone-1")).toHaveLength(0);
  });

  test("delete falls back to list+match when no tracked id", async () => {
    const fake = new FakeClient();
    fake.zones.set("example.com", "zone-1");
    // Pre-seed a stale record as if a previous attempt left it behind.
    fake.recordsByZone.set("zone-1", [
      { id: "stale", name: "_acme-challenge.example.com", content: "token-value" },
    ]);
    const runner = cloudflareRunner(
      makeChallenge({ zoneId: "zone-1" }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.delete(makeContext());
    expect(result.ok).toBe(true);
    expect(fake.recordsByZone.get("zone-1")).toHaveLength(0);
  });

  test("delete treats missing record as success", async () => {
    const fake = new FakeClient();
    const runner = cloudflareRunner(
      makeChallenge({ zoneId: "zone-1" }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.delete(makeContext());
    expect(result.ok).toBe(true);
  });

  test("delete falls back to list+match when tracked id is stale", async () => {
    const fake = new FakeClient();
    fake.zones.set("example.com", "zone-1");
    const runner = cloudflareRunner(
      makeChallenge({ zoneId: "zone-1" }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    await runner.create(makeContext());
    fake.oneShotDeleteError = new Error("404 record gone");
    const result = await runner.delete(makeContext());
    // Tracked delete failed, list cleanup finds the still-present record we
    // created above and removes it -> overall success.
    expect(result.ok).toBe(true);
    expect(fake.recordsByZone.get("zone-1")).toHaveLength(0);
  });
});

describe("cloudflareRunner failing runner", () => {
  test("missing token env var fails create with actionable message", async () => {
    const fake = new FakeClient();
    const runner = cloudflareRunner(
      makeChallenge({ apiTokenEnv: "CF_MISSING" }),
      {} as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.create(makeContext());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("CF_MISSING");
    // No API calls happened.
    expect(fake.calls).toHaveLength(0);
  });

  test("missing token env var treats delete as success", async () => {
    const fake = new FakeClient();
    const runner = cloudflareRunner(
      makeChallenge({ apiTokenEnv: "CF_MISSING" }),
      {} as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const result = await runner.delete(makeContext());
    expect(result.ok).toBe(true);
  });
});

describe("cloudflareRunner propagation", () => {
  test("waitForPropagation sleeps when configured", async () => {
    const fake = new FakeClient();
    const runner = cloudflareRunner(
      makeChallenge({ propagationSeconds: 1 }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const start = Date.now();
    await runner.waitForPropagation();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  test("waitForPropagation is a no-op when 0", async () => {
    const fake = new FakeClient();
    const runner = cloudflareRunner(
      makeChallenge({ propagationSeconds: 0 }),
      { CF_API_TOKEN: "t" } as NodeJS.ProcessEnv,
      { createClient: () => fake },
    );
    const start = Date.now();
    await runner.waitForPropagation();
    expect(Date.now() - start).toBeLessThan(100);
  });
});
