import { describe, expect, test } from "bun:test";
import {
  decodeTerminalClientFrame,
  TERMINAL_PROTOCOL_VERSION,
} from "@worktreeos/daemon/terminal-layer/protocol-validation";

describe("decodeTerminalClientFrame", () => {
  test("accepts a well-formed hello frame", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({
        type: "hello",
        v: TERMINAL_PROTOCOL_VERSION,
        clientId: "c1",
        cols: 100,
        rows: 30,
        lastSeenOutputSeq: 0,
        desiredControl: "controller",
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.frame.type).toBe("hello");
      if (res.frame.type === "hello") {
        expect(res.frame.clientId).toBe("c1");
        expect(res.frame.cols).toBe(100);
        expect(res.frame.desiredControl).toBe("controller");
        expect(res.frame.lastSeenOutputSeq).toBe(0);
      }
    }
  });

  test("rejects hello with invalid desiredControl", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "c1",
        cols: 80,
        rows: 24,
        desiredControl: "owner",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid-shape");
  });

  test("rejects hello with non-positive dimensions", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "c1",
        cols: 0,
        rows: 24,
        desiredControl: "viewer",
      }),
    );
    expect(res.ok).toBe(false);
  });

  test("rejects unsupported protocol versions with a typed error", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({
        type: "hello",
        v: 99,
        clientId: "c1",
        cols: 80,
        rows: 24,
        desiredControl: "viewer",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("version-unsupported");
      if (res.error.code === "version-unsupported") {
        expect(res.error.requested).toBe(99);
      }
    }
  });

  test("rejects malformed JSON", () => {
    const res = decodeTerminalClientFrame("{this is not json}");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid-json");
  });

  test("rejects unknown frame types", () => {
    const res = decodeTerminalClientFrame(JSON.stringify({ type: "explode", v: 1 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid-shape");
  });

  test("rejects frames missing the version", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "input", data: "x" }),
    );
    expect(res.ok).toBe(false);
  });

  test("accepts a well-formed input frame", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "input", v: 1, data: "ls\n" }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.frame.type === "input") {
      expect(res.frame.data).toBe("ls\n");
    }
  });

  test("rejects input frame without string data", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "input", v: 1, data: 42 }),
    );
    expect(res.ok).toBe(false);
  });

  test("accepts a resize frame", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "resize", v: 1, cols: 120, rows: 40 }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.frame.type === "resize") {
      expect(res.frame.cols).toBe(120);
      expect(res.frame.rows).toBe(40);
    }
  });

  test("rejects resize with non-integer dimensions", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "resize", v: 1, cols: 1.5, rows: 40 }),
    );
    expect(res.ok).toBe(false);
  });

  test("accepts an ack frame", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "ack", v: 1, ackSeq: 7 }),
    );
    expect(res.ok).toBe(true);
  });

  test("rejects ack with negative sequence", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "ack", v: 1, ackSeq: -1 }),
    );
    expect(res.ok).toBe(false);
  });

  test("accepts each control action", () => {
    for (const action of ["request", "release", "revoke"]) {
      const res = decodeTerminalClientFrame(
        JSON.stringify({ type: "control", v: 1, action }),
      );
      expect(res.ok).toBe(true);
    }
  });

  test("rejects unknown control actions", () => {
    const res = decodeTerminalClientFrame(
      JSON.stringify({ type: "control", v: 1, action: "steal" }),
    );
    expect(res.ok).toBe(false);
  });

  test("rejects binary frames that do not decode to valid JSON", () => {
    const res = decodeTerminalClientFrame(new Uint8Array([0, 1, 2, 3]).buffer);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid-json");
  });

  test("accepts UTF-8 JSON delivered in a Uint8Array", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "input", v: 1, data: "ok" }),
    );
    const res = decodeTerminalClientFrame(bytes);
    expect(res.ok).toBe(true);
  });

  test("rejects JSON arrays at the top level", () => {
    const res = decodeTerminalClientFrame(JSON.stringify([{}, {}]));
    expect(res.ok).toBe(false);
  });
});
