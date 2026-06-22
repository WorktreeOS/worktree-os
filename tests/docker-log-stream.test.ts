import { test, expect, describe, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { DockerLogStream } from "@worktreeos/daemon/docker/docker-client";

/** Build a Docker multiplexed log frame: [stream(1)|0,0,0|size(4 BE)|payload]. */
function frame(stream: number, payload: string): Buffer {
  const p = Buffer.from(payload, "utf-8");
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(p.length, 4);
  return Buffer.concat([head, p]);
}

/** Wrap a single body slice in one HTTP chunked-transfer chunk. */
function chunk(body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${body.length.toString(16)}\r\n`, "ascii"),
    body,
    Buffer.from("\r\n", "ascii"),
  ]);
}

const TERMINATOR = Buffer.from("0\r\n\r\n", "ascii");

let server: Server | undefined;
let sockPath = "";
let counter = 0;

/**
 * Start a one-shot fake Docker socket server that replies to the next request
 * with `header` then `writes` (each pushed as a separate socket write to
 * exercise partial-read handling).
 */
function startServer(
  header: string,
  writes: Buffer[],
  opts: { delayBodyMs?: number } = {},
): Promise<string> {
  // Short path: macOS caps unix socket paths near 104 chars.
  sockPath = join(tmpdir(), `wos-dls-${process.pid}-${counter++}.sock`);
  try {
    unlinkSync(sockPath);
  } catch {
    // not present
  }
  server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(header);
      const sendBody = () => {
        for (const w of writes) socket.write(w);
      };
      if (opts.delayBodyMs) setTimeout(sendBody, opts.delayBodyMs);
      else sendBody();
    });
  });
  return new Promise((resolve) => {
    server!.listen(sockPath, () => resolve(sockPath));
  });
}

async function collect(stream: DockerLogStream): Promise<string> {
  let out = "";
  for await (const c of stream) out += c;
  return out;
}

afterEach(() => {
  server?.close();
  server = undefined;
  try {
    if (sockPath) unlinkSync(sockPath);
  } catch {
    // already gone
  }
});

const MULTIPLEXED_HEADER =
  "HTTP/1.1 200 OK\r\n" +
  "Content-Type: application/vnd.docker.multiplexed-stream\r\n" +
  "Transfer-Encoding: chunked\r\n\r\n";

const RAW_HEADER =
  "HTTP/1.1 200 OK\r\n" +
  "Content-Type: application/vnd.docker.raw-stream\r\n" +
  "Transfer-Encoding: chunked\r\n\r\n";

describe("DockerLogStream chunked transfer decoding", () => {
  test("decodes chunked multiplexed frames into payload text", async () => {
    const body = Buffer.concat([
      frame(1, "hello\n"),
      frame(2, "err\n"),
      frame(1, "world\n"),
    ]);
    const path = await startServer(MULTIPLEXED_HEADER, [
      chunk(body),
      TERMINATOR,
    ]);
    const stream = new DockerLogStream(path, "/logs");
    await stream.ready;
    expect(await collect(stream)).toBe("hello\nerr\nworld\n");
  });

  test("reassembles a frame split across chunk boundaries and socket writes", async () => {
    const body = Buffer.concat([frame(1, "abcdefghij\n"), frame(1, "tail\n")]);
    // Split the body mid-frame into two chunks, and split the first chunk's
    // bytes across two socket writes to exercise partial size-line / payload.
    const c1 = chunk(body.slice(0, 5));
    const c2 = chunk(body.slice(5));
    const writes = [
      c1.slice(0, 2),
      c1.slice(2),
      c2.slice(0, 4),
      c2.slice(4),
      TERMINATOR,
    ];
    const path = await startServer(MULTIPLEXED_HEADER, writes);
    const stream = new DockerLogStream(path, "/logs");
    await stream.ready;
    expect(await collect(stream)).toBe("abcdefghij\ntail\n");
  });

  test("delivers data even when the terminating chunk arrives with a waiter pending", async () => {
    // Header first, then (after the consumer is already awaiting) the data
    // frame and the 0-length terminating chunk in a single write. The
    // terminating chunk must not race ahead of the buffered payload.
    const body = frame(1, "final\n");
    const path = await startServer(
      MULTIPLEXED_HEADER,
      [Buffer.concat([chunk(body), TERMINATOR])],
      { delayBodyMs: 40 },
    );
    const stream = new DockerLogStream(path, "/logs");
    await stream.ready;
    expect(await collect(stream)).toBe("final\n");
  });

  test("passes through chunked raw-stream (TTY) bytes unframed", async () => {
    const body = Buffer.from("plain tty output\n", "utf-8");
    const path = await startServer(RAW_HEADER, [chunk(body), TERMINATOR]);
    const stream = new DockerLogStream(path, "/logs");
    await stream.ready;
    expect(await collect(stream)).toBe("plain tty output\n");
  });
});
