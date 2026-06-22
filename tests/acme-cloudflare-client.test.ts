import { test, expect, describe } from "bun:test";
import { createCloudflareClient } from "@worktreeos/daemon/acme/cloudflare-client";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function makeFetch(
  responder: (
    call: FetchCall,
  ) => { status?: number; body: Record<string, unknown> },
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const init2 = init ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init2.headers ?? {})) {
      if (typeof v === "string") headers[k] = v;
    }
    const body =
      typeof init2.body === "string"
        ? JSON.parse(init2.body as string)
        : undefined;
    const call: FetchCall = {
      url,
      method: init2.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    const res = responder(call);
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("Cloudflare client", () => {
  test("findZoneByName returns id when found", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: { success: true, result: [{ id: "zone-1", name: "example.com" }] },
    }));
    const client = createCloudflareClient({
      apiToken: "secret",
      fetchImpl,
    });
    const id = await client.findZoneByName("example.com");
    expect(id).toBe("zone-1");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer secret");
    expect(calls[0]?.url).toContain("/zones?name=example.com");
  });

  test("findZoneByName returns undefined when not found", async () => {
    const { fetchImpl } = makeFetch(() => ({
      body: { success: true, result: [] },
    }));
    const client = createCloudflareClient({ apiToken: "t", fetchImpl });
    expect(await client.findZoneByName("nope.example.com")).toBeUndefined();
  });

  test("createTxtRecord posts and returns id", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: { success: true, result: { id: "rec-7" } },
    }));
    const client = createCloudflareClient({ apiToken: "t", fetchImpl });
    const id = await client.createTxtRecord(
      "zone-1",
      "_acme-challenge.example.com",
      "value",
    );
    expect(id).toBe("rec-7");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/zones/zone-1/dns_records");
    expect(calls[0]?.body).toEqual({
      type: "TXT",
      name: "_acme-challenge.example.com",
      content: "value",
      ttl: 60,
      proxied: false,
    });
  });

  test("listTxtRecords filters by type and name", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: {
        success: true,
        result: [
          { id: "a", name: "_acme-challenge.example.com", content: "v1" },
        ],
      },
    }));
    const client = createCloudflareClient({ apiToken: "t", fetchImpl });
    const records = await client.listTxtRecords(
      "zone-1",
      "_acme-challenge.example.com",
    );
    expect(records).toHaveLength(1);
    expect(calls[0]?.url).toContain("type=TXT");
    expect(calls[0]?.url).toContain(
      `name=${encodeURIComponent("_acme-challenge.example.com")}`,
    );
  });

  test("deleteRecord issues DELETE", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      body: { success: true, result: { id: "rec-7" } },
    }));
    const client = createCloudflareClient({ apiToken: "t", fetchImpl });
    await client.deleteRecord("zone-1", "rec-7");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/zones/zone-1/dns_records/rec-7");
  });

  test("API envelope errors surface code and message", async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 403,
      body: {
        success: false,
        errors: [{ code: 6003, message: "invalid token" }],
      },
    }));
    const client = createCloudflareClient({ apiToken: "t", fetchImpl });
    try {
      await client.findZoneByName("example.com");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("6003");
      expect((e as Error).message).toContain("invalid token");
    }
  });

  test("network errors surface actionable message", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = createCloudflareClient({ apiToken: "t", fetchImpl });
    try {
      await client.findZoneByName("example.com");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("ECONNREFUSED");
    }
  });
});
