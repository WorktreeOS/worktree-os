import { describe, expect, test } from "bun:test";
import {
  encodeTerminalClientFrame,
  encodeTerminalServerFrame,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalServerHelloAckFrame,
  type TerminalServerOutputFrame,
  type TerminalServerErrorFrame,
} from "@worktreeos/daemon/terminal-layer/protocol";
import { decodeTerminalClientFrame } from "@worktreeos/daemon/terminal-layer/protocol-validation";

describe("terminal protocol encoding", () => {
  test("round-trips client input frames", () => {
    const wire = encodeTerminalClientFrame({
      type: "input",
      v: TERMINAL_PROTOCOL_VERSION,
      data: "echo hi\n",
    });
    const res = decodeTerminalClientFrame(wire);
    expect(res.ok).toBe(true);
    if (res.ok && res.frame.type === "input") {
      expect(res.frame.data).toBe("echo hi\n");
    }
  });

  test("encodes a server hello-ack with replay metadata", () => {
    const frame: TerminalServerHelloAckFrame = {
      type: "hello-ack",
      v: TERMINAL_PROTOCOL_VERSION,
      attachmentId: "att-1",
      session: {
        id: "t1",
        worktreePath: "/wt",
        status: "running",
        shell: "/bin/zsh",
        cwd: "/wt",
        cols: 80,
        rows: 24,
        createdAt: "2026-05-23T00:00:00.000Z",
      },
      replay: {
        firstRetainedSeq: 0,
        latestSeq: 0,
        retainedBytes: 0,
      },
      control: {
        controllerAttachmentId: "att-1",
        changedAt: "2026-05-23T00:00:00.000Z",
      },
      willReplay: false,
    };
    const wire = encodeTerminalServerFrame(frame);
    const parsed = JSON.parse(wire);
    expect(parsed.type).toBe("hello-ack");
    expect(parsed.v).toBe(TERMINAL_PROTOCOL_VERSION);
    expect(parsed.replay.firstRetainedSeq).toBe(0);
  });

  test("encodes a server output frame with monotonic seq", () => {
    const a: TerminalServerOutputFrame = {
      type: "output",
      v: TERMINAL_PROTOCOL_VERSION,
      seq: 1,
      data: "$ ",
    };
    const b: TerminalServerOutputFrame = {
      type: "output",
      v: TERMINAL_PROTOCOL_VERSION,
      seq: 2,
      data: "ls\n",
      replay: true,
    };
    const pa = JSON.parse(encodeTerminalServerFrame(a));
    const pb = JSON.parse(encodeTerminalServerFrame(b));
    expect(pa.seq).toBe(1);
    expect(pb.seq).toBe(2);
    expect(pb.replay).toBe(true);
  });

  test("encodes a server error frame with fatal flag", () => {
    const frame: TerminalServerErrorFrame = {
      type: "error",
      v: TERMINAL_PROTOCOL_VERSION,
      code: "version-unsupported",
      message: "unsupported protocol",
      fatal: true,
    };
    const parsed = JSON.parse(encodeTerminalServerFrame(frame));
    expect(parsed.code).toBe("version-unsupported");
    expect(parsed.fatal).toBe(true);
  });

  test("declares protocol version 1", () => {
    expect(TERMINAL_PROTOCOL_VERSION).toBe(1);
  });
});
