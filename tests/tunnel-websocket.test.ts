import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { startTunnelServer, type TunnelServer } from "@worktreeos/runtime/tunnel";

interface UpstreamWsData {
  cookie: string;
  xfh: string;
  protocol: string;
}

describe("tunnel WebSocket proxy", () => {
  let upstream: Server<UpstreamWsData>;
  let tunnel: TunnelServer;
  let tunnelPort: number;

  beforeAll(async () => {
    upstream = Bun.serve<UpstreamWsData>({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req, srv) {
        const protocol = req.headers.get("sec-websocket-protocol");
        const upgraded = srv.upgrade(req, {
          data: {
            cookie: req.headers.get("cookie") ?? "",
            xfh: req.headers.get("x-forwarded-host") ?? "",
            protocol: protocol ? protocol.split(",")[0]!.trim() : "",
          },
          headers: protocol
            ? { "sec-websocket-protocol": protocol.split(",")[0]!.trim() }
            : undefined,
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        idleTimeout: 0,
        open(ws: ServerWebSocket<UpstreamWsData>) {
          ws.send(
            JSON.stringify({
              hello: true,
              cookie: ws.data.cookie,
              xfh: ws.data.xfh,
              protocol: ws.data.protocol,
            }),
          );
        },
        message(ws: ServerWebSocket<UpstreamWsData>, msg: string | Buffer) {
          if (typeof msg === "string") {
            ws.send(`echo:${msg}`);
          } else {
            // Flip bytes so binary identity is verifiable on the receiver.
            const out = Buffer.alloc(msg.byteLength);
            for (let i = 0; i < msg.byteLength; i += 1) {
              out[i] = msg[i]! ^ 0xff;
            }
            ws.send(out);
          }
        },
      },
    });

    tunnel = await startTunnelServer({
      port: 0,
      domain: "example.com",
      hostname: "127.0.0.1",
    });
    tunnelPort = tunnel.port;
    tunnel.registerRoute({
      hostname: "ws.example.com",
      hostPort: upstream.port!,
      policy: { routeType: "service", whitelistIps: [] },
    });
  });

  afterAll(async () => {
    await tunnel.stop();
    upstream.stop(true);
  });

  /**
   * Open a WS connection to the tunnel pretending to come from the public
   * hostname (the tunnel routes by Host header).
   */
  function openClient(opts: {
    cookie?: string;
    protocol?: string;
    path?: string;
  } = {}): WebSocket {
    const headers: Record<string, string> = { host: "ws.example.com" };
    if (opts.cookie) headers["cookie"] = opts.cookie;
    const WS = globalThis.WebSocket as unknown as new (
      url: string,
      options: {
        headers?: Record<string, string>;
        protocols?: string[];
      },
    ) => WebSocket;
    const wsOpts: {
      headers: Record<string, string>;
      protocols?: string[];
    } = { headers };
    if (opts.protocol) wsOpts.protocols = [opts.protocol];
    return new WS(
      `ws://127.0.0.1:${tunnelPort}${opts.path ?? "/ui/v1/x"}`,
      wsOpts,
    );
  }

  test("proxies text frames and forwards Cookie + X-Forwarded-Host", async () => {
    const ws = openClient({ cookie: "wos_public_auth=abc" });
    const messages: string[] = [];
    await new Promise<void>((res, rej) => {
      const fail = setTimeout(() => rej(new Error("ws test timed out")), 5_000);
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (ev) => {
        messages.push(String(ev.data));
        if (messages.length === 2) {
          clearTimeout(fail);
          ws.close();
          res();
        }
      };
      ws.onerror = () => {
        clearTimeout(fail);
        rej(new Error("client ws error"));
      };
    });
    const hello = JSON.parse(messages[0]!) as {
      hello: boolean;
      cookie: string;
      xfh: string;
      protocol: string;
    };
    expect(hello.hello).toBe(true);
    expect(hello.cookie).toBe("wos_public_auth=abc");
    expect(hello.xfh).toBe("ws.example.com");
    expect(hello.protocol).toBe("");
    expect(messages[1]).toBe("echo:hi");
  });

  test("proxies binary frames byte-identical", async () => {
    const ws = openClient();
    ws.binaryType = "arraybuffer";
    const payload = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
    const binary = await new Promise<Uint8Array>((res, rej) => {
      const fail = setTimeout(() => rej(new Error("ws test timed out")), 5_000);
      let sawHello = false;
      ws.onopen = () => ws.send(payload);
      ws.onmessage = (ev) => {
        if (!sawHello) {
          sawHello = true;
          return;
        }
        clearTimeout(fail);
        ws.close();
        res(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onerror = () => {
        clearTimeout(fail);
        rej(new Error("client ws error"));
      };
    });
    expect(Array.from(binary)).toEqual(
      Array.from(payload).map((b) => b ^ 0xff),
    );
  });

  test("negotiates subprotocol end-to-end", async () => {
    const ws = openClient({ protocol: "wos.v1" });
    await new Promise<void>((res, rej) => {
      const fail = setTimeout(() => rej(new Error("ws test timed out")), 5_000);
      ws.onopen = () => {
        try {
          expect(ws.protocol).toBe("wos.v1");
          clearTimeout(fail);
          ws.close();
          res();
        } catch (e) {
          clearTimeout(fail);
          rej(e as Error);
        }
      };
      ws.onerror = () => {
        clearTimeout(fail);
        rej(new Error("client ws error"));
      };
    });
  });

  test("returns 404 when host is not registered", async () => {
    const WS = globalThis.WebSocket as unknown as new (
      url: string,
      options: { headers?: Record<string, string> },
    ) => WebSocket;
    const ws = new WS(`ws://127.0.0.1:${tunnelPort}/`, {
      headers: { host: "unknown.example.com" },
    });
    const closed = await new Promise<{ code: number }>((res, rej) => {
      const fail = setTimeout(() => rej(new Error("ws test timed out")), 5_000);
      ws.onclose = (ev) => {
        clearTimeout(fail);
        res({ code: ev.code });
      };
      ws.onerror = () => {
        // Some platforms emit `error` before `close`; the close handler will
        // still fire and resolve the promise.
      };
    });
    // A non-101 response triggers a close with one of the standard "abnormal"
    // codes — we don't pin the exact code, just confirm the bridge didn't
    // establish.
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
