/**
 * Validation helpers for inbound terminal-protocol client messages. Validation
 * is strict: anything that is not a well-formed frame of a known type at a
 * supported protocol version is rejected with a structured reason. The actor
 * layer translates the reason into the corresponding `error` frame and decides
 * whether the attachment is closed.
 */

import {
  TERMINAL_PROTOCOL_VERSION,
  type TerminalClientFrame,
  type TerminalControlMode,
} from "./protocol";

export type TerminalValidationError =
  | { code: "invalid-json"; message: string }
  | { code: "invalid-shape"; message: string }
  | { code: "version-unsupported"; message: string; requested: number };

export type TerminalValidationResult =
  | { ok: true; frame: TerminalClientFrame }
  | { ok: false; error: TerminalValidationError };

const CONTROL_MODES: ReadonlySet<TerminalControlMode> = new Set([
  "controller",
  "viewer",
]);

const CONTROL_ACTIONS = new Set(["request", "release", "revoke"]);

function fail(
  code: TerminalValidationError["code"],
  message: string,
  requested?: number,
): TerminalValidationResult {
  return {
    ok: false,
    error:
      code === "version-unsupported"
        ? { code, message, requested: requested ?? 0 }
        : ({ code, message } as TerminalValidationError),
  };
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isPositiveDim(value: unknown): value is number {
  return isFiniteInt(value) && value > 0 && value <= 100000;
}

/**
 * Decode a raw string or binary message into a validated client frame.
 * Binary input is not yet defined by the protocol; binary frames return an
 * `invalid-shape` error so the actor can reject them with a typed error.
 */
export function decodeTerminalClientFrame(
  raw: string | ArrayBufferView | ArrayBuffer | Buffer,
): TerminalValidationResult {
  const text =
    typeof raw === "string" ? raw : decodeBinaryToText(raw);
  if (text == null) {
    return fail("invalid-shape", "binary frames are not supported in protocol v1");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return fail("invalid-json", `could not parse JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("invalid-shape", "frame must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.type !== "string") {
    return fail("invalid-shape", "frame is missing string `type`");
  }
  if (!isFiniteInt(obj.v)) {
    return fail("invalid-shape", "frame is missing integer `v`");
  }
  if (obj.v > TERMINAL_PROTOCOL_VERSION) {
    return fail(
      "version-unsupported",
      `unsupported protocol version ${obj.v}; daemon supports up to ${TERMINAL_PROTOCOL_VERSION}`,
      obj.v as number,
    );
  }

  switch (obj.type) {
    case "hello": {
      if (typeof obj.clientId !== "string" || obj.clientId.length === 0) {
        return fail("invalid-shape", "hello: clientId must be a non-empty string");
      }
      if (!isPositiveDim(obj.cols) || !isPositiveDim(obj.rows)) {
        return fail("invalid-shape", "hello: cols/rows must be positive integers");
      }
      if (
        obj.lastSeenOutputSeq !== undefined &&
        !(isFiniteInt(obj.lastSeenOutputSeq) && obj.lastSeenOutputSeq >= 0)
      ) {
        return fail("invalid-shape", "hello: lastSeenOutputSeq must be a non-negative integer");
      }
      if (
        typeof obj.desiredControl !== "string" ||
        !CONTROL_MODES.has(obj.desiredControl as TerminalControlMode)
      ) {
        return fail("invalid-shape", "hello: desiredControl must be 'controller' or 'viewer'");
      }
      return {
        ok: true,
        frame: {
          type: "hello",
          v: obj.v as number,
          clientId: obj.clientId,
          cols: obj.cols as number,
          rows: obj.rows as number,
          desiredControl: obj.desiredControl as TerminalControlMode,
          ...(typeof obj.lastSeenOutputSeq === "number"
            ? { lastSeenOutputSeq: obj.lastSeenOutputSeq }
            : {}),
        },
      };
    }
    case "input": {
      if (typeof obj.data !== "string") {
        return fail("invalid-shape", "input: data must be a string");
      }
      return { ok: true, frame: { type: "input", v: obj.v as number, data: obj.data } };
    }
    case "resize": {
      if (!isPositiveDim(obj.cols) || !isPositiveDim(obj.rows)) {
        return fail("invalid-shape", "resize: cols/rows must be positive integers");
      }
      return {
        ok: true,
        frame: {
          type: "resize",
          v: obj.v as number,
          cols: obj.cols as number,
          rows: obj.rows as number,
        },
      };
    }
    case "ack": {
      if (!(isFiniteInt(obj.ackSeq) && obj.ackSeq >= 0)) {
        return fail("invalid-shape", "ack: ackSeq must be a non-negative integer");
      }
      return { ok: true, frame: { type: "ack", v: obj.v as number, ackSeq: obj.ackSeq as number } };
    }
    case "control": {
      if (typeof obj.action !== "string" || !CONTROL_ACTIONS.has(obj.action)) {
        return fail(
          "invalid-shape",
          "control: action must be one of 'request' | 'release' | 'revoke'",
        );
      }
      return {
        ok: true,
        frame: {
          type: "control",
          v: obj.v as number,
          action: obj.action as "request" | "release" | "revoke",
        },
      };
    }
    default:
      return fail("invalid-shape", `unknown frame type ${String(obj.type)}`);
  }
}

function decodeBinaryToText(
  raw: ArrayBufferView | ArrayBuffer | Buffer,
): string | null {
  try {
    if (raw instanceof ArrayBuffer) {
      return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(raw));
    }
    if (ArrayBuffer.isView(raw)) {
      return new TextDecoder("utf-8", { fatal: false }).decode(raw);
    }
  } catch {
    return null;
  }
  return null;
}

export { TERMINAL_PROTOCOL_VERSION };
