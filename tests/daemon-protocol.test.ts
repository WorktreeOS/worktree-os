import { test, expect, describe } from "bun:test";
import {
  decodeEnvelope,
  encodeEnvelope,
  isConflictResponse,
  isTerminalEnvelope,
  splitEnvelopeStream,
  type OperationEventEnvelope,
  type OperationTerminalEnvelope,
} from "@worktreeos/daemon/daemon-protocol";
import type { DeploymentEvent } from "@worktreeos/core/events";

function envelope(event: DeploymentEvent, sequence = 1): OperationEventEnvelope {
  return {
    operationId: "op-123",
    sessionName: "session",
    sequence,
    timestamp: "2026-05-13T12:00:00.000Z",
    event,
  };
}

describe("envelope round-trip", () => {
  const cases: Array<{ name: string; event: DeploymentEvent }> = [
    {
      name: "step running",
      event: { type: "step", id: "compose-up", state: "running" },
    },
    {
      name: "step failed with message",
      event: { type: "step", id: "init-script", state: "failed", message: "exit 1" },
    },
    {
      name: "log stdout to deployment",
      event: { type: "log", channel: "deployment", stream: "stdout", chunk: "abc\n" },
    },
    {
      name: "log stderr to init",
      event: { type: "log", channel: "init", stream: "stderr", chunk: "err\n" },
    },
    {
      name: "log to service channel",
      event: { type: "log", channel: "service:api", stream: "stdout", chunk: "ok\n" },
    },
    {
      name: "volume-clone start",
      event: { type: "volume-clone", phase: "start", path: ".data", index: 1, total: 2 },
    },
    {
      name: "retry",
      event: { type: "retry", attempt: 2, maxAttempts: 3, reason: "port busy" },
    },
    {
      name: "services-discovered",
      event: {
        type: "services-discovered",
        services: ["api", "db"],
        composeContext: { projectName: "p", composeFile: "/c.yaml" },
      },
    },
    {
      name: "complete",
      event: { type: "complete", lastUp: "2026-05-13T12:00:00.000Z" },
    },
    {
      name: "failure",
      event: { type: "failure", message: "boom" },
    },
  ];

  for (const c of cases) {
    test(`${c.name} survives encode + decode without losing data`, () => {
      const env = envelope(c.event);
      const decoded = decodeEnvelope(encodeEnvelope(env));
      expect(decoded).toEqual(env);
    });
  }

  test("encode emits a single NDJSON line ending with \\n", () => {
    const line = encodeEnvelope(envelope({ type: "failure", message: "x" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  test("terminal envelope round-trips with status flag", () => {
    const term: OperationTerminalEnvelope = {
      operationId: "op",
      sessionName: "s",
      sequence: 99,
      timestamp: "2026-05-13T12:00:00.000Z",
      terminal: { status: "succeeded" },
    };
    const decoded = decodeEnvelope(encodeEnvelope(term));
    expect(isTerminalEnvelope(decoded)).toBe(true);
    expect(decoded).toEqual(term);
  });
});

describe("decodeEnvelope error cases", () => {
  test("rejects empty input", () => {
    expect(() => decodeEnvelope("")).toThrow();
    expect(() => decodeEnvelope("   ")).toThrow();
  });

  test("rejects non-object payloads", () => {
    expect(() => decodeEnvelope("42")).toThrow();
    expect(() => decodeEnvelope('"text"')).toThrow();
  });

  test("rejects envelopes missing required fields", () => {
    expect(() => decodeEnvelope(JSON.stringify({ sequence: 1 }))).toThrow();
    expect(() => decodeEnvelope(JSON.stringify({ operationId: "x" }))).toThrow();
  });
});

describe("splitEnvelopeStream", () => {
  test("splits multiple lines and keeps trailing partial", () => {
    const env1 = encodeEnvelope(envelope({ type: "failure", message: "a" }, 1));
    const env2 = encodeEnvelope(envelope({ type: "failure", message: "b" }, 2));
    const partial = '{"operationId":"x"';
    const { envelopes, rest } = splitEnvelopeStream(env1 + env2 + partial);
    expect(envelopes.length).toBe(2);
    expect((envelopes[0] as OperationEventEnvelope).event.type).toBe("failure");
    expect(rest).toBe(partial);
  });

  test("ignores blank lines between envelopes", () => {
    const env = encodeEnvelope(envelope({ type: "failure", message: "x" }, 1));
    const { envelopes } = splitEnvelopeStream(env + "\n\n" + env);
    expect(envelopes.length).toBe(2);
  });
});

describe("isConflictResponse", () => {
  test("recognises a session-busy payload", () => {
    expect(
      isConflictResponse({
        error: "session-busy",
        sessionName: "s",
        active: {
          operationId: "x",
          kind: "up",
          sessionName: "s",
          status: "running",
          startedAt: "2026-05-13T12:00:00.000Z",
        },
      }),
    ).toBe(true);
  });

  test("rejects unrelated payloads", () => {
    expect(isConflictResponse({ ok: true })).toBe(false);
    expect(isConflictResponse(null)).toBe(false);
    expect(isConflictResponse("session-busy")).toBe(false);
  });
});
