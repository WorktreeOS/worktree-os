import { test, expect, describe } from "bun:test";
import { parseComposePs } from "@worktreeos/compose/ps";

describe("parseComposePs", () => {
  test("returns empty array for empty output", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("\n\n")).toEqual([]);
  });

  test("parses NDJSON output with Publishers", () => {
    const ndjson = [
      JSON.stringify({
        Service: "app",
        State: "running",
        Status: "Up 5 seconds",
        Publishers: [
          { URL: "127.0.0.1", TargetPort: 3000, PublishedPort: 32769, Protocol: "tcp" },
        ],
      }),
      JSON.stringify({
        Service: "db",
        State: "running",
        Status: "Up 5 seconds",
        Publishers: [],
      }),
    ].join("\n");
    const parsed = parseComposePs(ndjson);
    expect(parsed).toEqual([
      {
        service: "app",
        state: "running",
        status: "Up 5 seconds",
        ports: [
          {
            containerPort: 3000,
            hostPort: 32769,
            hostIp: "127.0.0.1",
            protocol: "tcp",
          },
        ],
      },
      {
        service: "db",
        state: "running",
        status: "Up 5 seconds",
        ports: [],
      },
    ]);
  });

  test("parses JSON array output", () => {
    const out = JSON.stringify([
      {
        Service: "app",
        State: "running",
        Publishers: [
          { URL: "127.0.0.1", TargetPort: 80, PublishedPort: 50000, Protocol: "tcp" },
        ],
      },
    ]);
    const parsed = parseComposePs(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.ports[0]).toEqual({
      containerPort: 80,
      hostPort: 50000,
      hostIp: "127.0.0.1",
      protocol: "tcp",
    });
  });

  test("treats PublishedPort=0 as unpublished", () => {
    const out = JSON.stringify({
      Service: "app",
      State: "running",
      Publishers: [{ URL: "", TargetPort: 3000, PublishedPort: 0, Protocol: "tcp" }],
    });
    const parsed = parseComposePs(out);
    expect(parsed[0]!.ports[0]!.hostPort).toBeUndefined();
    expect(parsed[0]!.ports[0]!.containerPort).toBe(3000);
  });

  test("parses string-form Ports field", () => {
    const out = JSON.stringify({
      Service: "app",
      State: "running",
      Ports: "0.0.0.0:32770->3000/tcp",
    });
    const parsed = parseComposePs(out);
    expect(parsed[0]!.ports).toEqual([
      { containerPort: 3000, hostPort: 32770, hostIp: "0.0.0.0", protocol: "tcp" },
    ]);
  });
});
