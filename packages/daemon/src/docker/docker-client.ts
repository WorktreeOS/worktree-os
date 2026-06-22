/**
 * Docker Engine API client over the local Docker transport.
 *
 * Talks HTTP/1.1 over one of three transports, selected from
 * `DOCKER_HOST`/`DOCKER_SOCKET`/options or the platform default:
 *
 *   - Unix socket (`/var/run/docker.sock`) — POSIX default.
 *   - Windows named pipe (`npipe:////./pipe/docker_engine`) — Windows default.
 *   - TCP (`tcp://host:port` / `http://host:port`) — explicit only.
 *
 * Only the small surface that wos needs is implemented:
 *
 *   - `/containers/json?all=true&filters=...` for the initial full sync.
 *   - `/containers/<id>/json` for inspect-on-event reconciliation.
 *   - `/events?filters=...` as a long-running stream.
 *   - `/containers/<id>/logs?follow=...` for log streaming.
 *   - `/containers/<id>/start|stop|restart` for service-level actions.
 *
 * All requests go through `node:net` (not `node:http`): Bun's `node:http`
 * `socketPath` cannot open Windows named pipes, whereas `net.connect` can —
 * provided the pipe is given in forward-slash form `//./pipe/<name>` (verified
 * against a live Docker Desktop engine). JSON requests use `Connection: close`
 * and read the whole response; the streaming classes keep the connection open.
 * It does not support TLS-secured remote daemons.
 */
import { connect as netConnect, type Socket } from "node:net";
import type { ModuleLogger } from "../logger";

/** Selected Docker transport. `npipe` paths are forward-slash `//./pipe/<name>`. */
export type DockerTransport =
  | { kind: "unix"; socketPath: string }
  | { kind: "npipe"; pipePath: string }
  | { kind: "tcp"; host: string; port: number };

export interface DockerClientOptions {
  /** Legacy explicit Unix socket path. */
  socketPath?: string;
  /** `DOCKER_HOST`-style endpoint: `unix://`, `npipe://`, `tcp://`, `http://`, or a path. */
  host?: string;
  /** Platform override (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Environment override (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Daemon `docker-http` module logger. When present, each engine API request
   * is timed under `op: "docker-http"`; absent leaves calls untimed.
   */
  logger?: ModuleLogger;
}

const DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";
const DEFAULT_WINDOWS_PIPE = "//./pipe/docker_engine";
const DEFAULT_TCP_PORT = 2375;

/** Normalize any pipe spelling to the forward-slash form `net.connect` accepts. */
function normalizePipePath(raw: string): string {
  const s = raw.replace(/\\/g, "/");
  const m = /\/pipe\/(.+)$/i.exec(s);
  const name = m ? m[1]! : s.replace(/^.*\//, "");
  return `//./pipe/${name}`;
}

function splitHostPort(authority: string): { host: string; port: number } {
  const cleaned = authority.replace(/\/.*$/, "");
  const idx = cleaned.lastIndexOf(":");
  if (idx < 0) return { host: cleaned, port: DEFAULT_TCP_PORT };
  const port = Number.parseInt(cleaned.slice(idx + 1), 10);
  return {
    host: cleaned.slice(0, idx),
    port: Number.isFinite(port) ? port : DEFAULT_TCP_PORT,
  };
}

/** Parse a `DOCKER_HOST`-style endpoint string into a transport. */
export function parseDockerHost(
  value: string,
  platform: NodeJS.Platform = process.platform,
): DockerTransport {
  const v = value.trim();
  if (/^npipe:/i.test(v)) {
    return { kind: "npipe", pipePath: normalizePipePath(v.replace(/^npipe:/i, "")) };
  }
  if (/^\\\\[.?]\\pipe\\/i.test(v)) {
    return { kind: "npipe", pipePath: normalizePipePath(v) };
  }
  const tcp = /^(?:tcp|http):\/\/(.+)$/i.exec(v);
  if (tcp) {
    const { host, port } = splitHostPort(tcp[1]!);
    return { kind: "tcp", host, port };
  }
  if (/^unix:\/\//i.test(v)) {
    return { kind: "unix", socketPath: v.replace(/^unix:\/\//i, "") || DEFAULT_UNIX_SOCKET };
  }
  if (platform === "win32" && /pipe/i.test(v)) {
    return { kind: "npipe", pipePath: normalizePipePath(v) };
  }
  return { kind: "unix", socketPath: v };
}

/** Resolve the effective transport from options, environment, and platform. */
export function resolveDockerTransport(opts: DockerClientOptions = {}): DockerTransport {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const explicit = opts.host ?? opts.socketPath ?? env.DOCKER_HOST ?? env.DOCKER_SOCKET;
  if (typeof explicit === "string" && explicit.length > 0) {
    return parseDockerHost(explicit, platform);
  }
  return platform === "win32"
    ? { kind: "npipe", pipePath: DEFAULT_WINDOWS_PIPE }
    : { kind: "unix", socketPath: DEFAULT_UNIX_SOCKET };
}

/** Human-readable transport description for diagnostics. */
export function describeDockerTransport(t: DockerTransport): string {
  switch (t.kind) {
    case "unix":
      return `Unix socket ${t.socketPath}`;
    case "npipe":
      return `Windows named pipe ${t.pipePath}`;
    case "tcp":
      return `TCP ${t.host}:${t.port}`;
  }
}

/** Open a raw socket to the Docker engine for the given transport. */
export function connectDockerTransport(t: DockerTransport): Socket {
  if (t.kind === "tcp") return netConnect({ host: t.host, port: t.port });
  return netConnect(t.kind === "npipe" ? t.pipePath : t.socketPath);
}

/** Connection-level failure naming the transport that could not be reached. */
export class DockerConnectionError extends Error {
  readonly transport: DockerTransport;
  constructor(transport: DockerTransport, cause: Error) {
    super(`Docker engine unreachable over ${describeDockerTransport(transport)}: ${cause.message}`);
    this.transport = transport;
  }
}

export interface DockerLabelFilter {
  /** Label keys that must be present (with optional `=value`). */
  labels: string[];
}

export interface DockerContainerListItem {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Labels: Record<string, string>;
  State: string;
  Status: string;
  Ports: Array<{
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: string;
  }>;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  RestartCount?: number;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    Dead: boolean;
    Pid: number;
    ExitCode: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: { Status: string };
  };
  Config: {
    Labels: Record<string, string>;
  };
  NetworkSettings: {
    Ports: Record<
      string,
      Array<{ HostIp: string; HostPort: string }> | null
    >;
  };
}

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: {
    ID: string;
    Attributes: Record<string, string>;
  };
  time: number;
  timeNano: number;
}

/**
 * Raw container stats payload from `/containers/<id>/stats?stream=false`. Only
 * the fields wos needs to compute CPU% and memory usage are typed; the engine
 * returns many more. All fields are optional because Docker omits CPU/memory
 * blocks for non-running containers or on the first sample.
 */
export interface DockerContainerStats {
  cpu_stats?: DockerCpuStats;
  precpu_stats?: DockerCpuStats;
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
}

interface DockerCpuStats {
  cpu_usage?: { total_usage?: number };
  system_cpu_usage?: number;
  online_cpus?: number;
}

export class DockerClient {
  private readonly transport: DockerTransport;
  private readonly log: ModuleLogger | undefined;

  constructor(opts: DockerClientOptions = {}) {
    this.transport = resolveDockerTransport(opts);
    this.log = opts.logger;
  }

  /** The resolved Docker transport (diagnostics / tests). */
  getTransport(): DockerTransport {
    return this.transport;
  }

  /** List containers matching the provided label filters. */
  async listContainers(
    filter?: DockerLabelFilter,
    opts?: { all?: boolean },
  ): Promise<DockerContainerListItem[]> {
    const all = opts?.all !== false;
    const search = new URLSearchParams();
    if (all) search.set("all", "true");
    if (filter && filter.labels.length > 0) {
      search.set(
        "filters",
        JSON.stringify({ label: filter.labels }),
      );
    }
    const path = `/containers/json?${search.toString()}`;
    const { body } = await this.requestJson("GET", path);
    return JSON.parse(body) as DockerContainerListItem[];
  }

  /** Inspect a single container by id. */
  async inspectContainer(id: string): Promise<DockerContainerInspect> {
    const { body } = await this.requestJson("GET", `/containers/${id}/json`);
    return JSON.parse(body) as DockerContainerInspect;
  }

  /**
   * Sample one-shot resource stats for a container. Uses `stream=false` so the
   * engine returns a single JSON object (containing the two CPU samples needed
   * to compute a percentage) instead of an open stream.
   */
  async statsContainer(id: string): Promise<DockerContainerStats> {
    const { body } = await this.requestJson(
      "GET",
      `/containers/${id}/stats?stream=false`,
    );
    return JSON.parse(body) as DockerContainerStats;
  }

  /**
   * Open a Docker events stream filtered to wos-managed containers.
   * The returned object exposes `events`: an async iterator of parsed JSON
   * events, and `abort()` to terminate the stream.
   */
  openEvents(
    filter?: DockerLabelFilter,
    opts?: { since?: string },
  ): DockerEventStream {
    const search = new URLSearchParams();
    if (opts?.since) search.set("since", opts.since);
    const filters: Record<string, string[]> = { type: ["container"] };
    if (filter && filter.labels.length > 0) {
      filters.label = filter.labels;
    }
    search.set("filters", JSON.stringify(filters));
    const path = `/events?${search.toString()}`;
    return new DockerEventStream(this.transport, path);
  }

  /** Stream container logs. The promise resolves with the response stream. */
  async streamLogs(
    id: string,
    opts: { follow?: boolean; tail?: number; stdout?: boolean; stderr?: boolean },
  ): Promise<DockerLogStream> {
    const search = new URLSearchParams();
    search.set("follow", opts.follow ? "true" : "false");
    search.set("stdout", opts.stdout === false ? "false" : "true");
    search.set("stderr", opts.stderr === false ? "false" : "true");
    if (typeof opts.tail === "number") {
      search.set("tail", String(opts.tail));
    }
    const path = `/containers/${id}/logs?${search.toString()}`;
    const stream = new DockerLogStream(this.transport, path);
    await stream.ready;
    return stream;
  }

  async startContainer(id: string): Promise<void> {
    await this.requestJson("POST", `/containers/${id}/start`);
  }

  async stopContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> {
    const search = new URLSearchParams();
    if (typeof opts?.timeoutSec === "number") {
      search.set("t", String(opts.timeoutSec));
    }
    const path = `/containers/${id}/stop${search.toString() ? "?" + search.toString() : ""}`;
    await this.requestJson("POST", path);
  }

  async restartContainer(
    id: string,
    opts?: { timeoutSec?: number },
  ): Promise<void> {
    const search = new URLSearchParams();
    if (typeof opts?.timeoutSec === "number") {
      search.set("t", String(opts.timeoutSec));
    }
    const path = `/containers/${id}/restart${search.toString() ? "?" + search.toString() : ""}`;
    await this.requestJson("POST", path);
  }

  /**
   * Internal helper: issue a JSON request over `node:net` and read the full
   * body. `Connection: close` lets us read until the socket ends, then parse
   * status + body (Content-Length or chunked). Goes through `net.connect`
   * rather than `node:http` so the Windows named-pipe transport works.
   */
  private requestJson(
    method: string,
    path: string,
  ): Promise<{ status: number; body: string }> {
    if (!this.log) return this.requestJsonRaw(method, path);
    return this.log.span("docker-http", `${method} ${path}`, () =>
      this.requestJsonRaw(method, path),
    );
  }

  private requestJsonRaw(
    method: string,
    path: string,
  ): Promise<{ status: number; body: string }> {
    const transport = this.transport;
    return new Promise((resolve, reject) => {
      let socket: Socket;
      try {
        socket = connectDockerTransport(transport);
      } catch (e) {
        reject(new DockerConnectionError(transport, e as Error));
        return;
      }
      let raw = Buffer.alloc(0);
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        reject(
          e instanceof DockerApiError ? e : new DockerConnectionError(transport, e),
        );
      };
      socket.on("connect", () => {
        socket.write(
          `${method} ${path} HTTP/1.1\r\n` +
            `Host: docker\r\n` +
            `Accept: application/json\r\n` +
            `Connection: close\r\n\r\n`,
        );
      });
      socket.on("data", (c: Buffer) => {
        raw = Buffer.concat([raw, c]);
      });
      socket.on("error", (e: Error) => fail(e));
      socket.on("end", () => {
        if (settled) return;
        settled = true;
        let parsed: { status: number; body: string };
        try {
          parsed = parseHttpResponse(raw);
        } catch (e) {
          reject(new DockerConnectionError(transport, e as Error));
          return;
        }
        if (parsed.status >= 400) {
          reject(
            new DockerApiError(
              `Docker API ${method} ${path} returned ${parsed.status}: ${parsed.body}`,
              parsed.status,
            ),
          );
          return;
        }
        resolve(parsed);
      });
    });
  }
}

/** Parse a complete buffered HTTP/1.1 response into status + decoded body. */
function parseHttpResponse(raw: Buffer): { status: number; body: string } {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) throw new Error("malformed HTTP response (no header terminator)");
  const headerText = raw.slice(0, sep).toString("utf-8");
  const bodyBuf = raw.slice(sep + 4);
  const statusLine = headerText.split("\r\n")[0] ?? "";
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  const status = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : 0;
  const body = /transfer-encoding:\s*chunked/i.test(headerText)
    ? decodeChunkedBody(bodyBuf)
    : bodyBuf.toString("utf-8");
  return { status, body };
}

/** Decode an HTTP chunked-transfer body (Docker uses it for JSON responses). */
function decodeChunkedBody(buf: Buffer): string {
  const out: Buffer[] = [];
  let off = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", off);
    if (nl < 0) break;
    const sizeLine = buf.slice(off, nl).toString("ascii");
    const semi = sizeLine.indexOf(";"); // ignore chunk extensions
    const sizeHex = (semi >= 0 ? sizeLine.slice(0, semi) : sizeLine).trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size === 0) break;
    const dataStart = nl + 2;
    const dataEnd = dataStart + size;
    if (buf.length < dataEnd) break;
    out.push(buf.slice(dataStart, dataEnd));
    off = dataEnd + 2; // skip the trailing CRLF
  }
  return Buffer.concat(out).toString("utf-8");
}

export class DockerApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Streaming Docker events. Connects to the engine socket, then yields parsed
 * event objects until aborted or the connection is closed.
 */
export class DockerEventStream {
  readonly events: AsyncIterableIterator<DockerEvent>;
  private socket?: Socket;
  private aborted = false;
  private pending: DockerEvent[] = [];
  private waiters: Array<(value: IteratorResult<DockerEvent>) => void> = [];
  private done = false;

  constructor(target: string | DockerTransport, path: string) {
    this.events = this.iterate();
    this.connect(target, path);
  }

  private connect(target: string | DockerTransport, path: string): void {
    const socket =
      typeof target === "string" ? netConnect(target) : connectDockerTransport(target);
    this.socket = socket;
    const req =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: docker\r\n` +
      `Accept: application/json\r\n` +
      `Connection: keep-alive\r\n\r\n`;
    socket.write(req);
    let buffer = "";
    let headersDone = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      if (!headersDone) {
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx < 0) return;
        buffer = buffer.slice(idx + 4);
        headersDone = true;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const ev = JSON.parse(line) as DockerEvent;
          this.push(ev);
        } catch {
          // Ignore chunked-transfer length lines and malformed fragments.
        }
      }
    });
    socket.on("end", () => this.finish());
    socket.on("error", () => this.finish());
    socket.on("close", () => this.finish());
  }

  private push(ev: DockerEvent): void {
    if (this.aborted) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: ev, done: false });
    } else {
      this.pending.push(ev);
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters) {
      w({ value: undefined as never, done: true });
    }
    this.waiters = [];
  }

  abort(): void {
    this.aborted = true;
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.finish();
  }

  private iterate(): AsyncIterableIterator<DockerEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<DockerEvent>> {
        if (self.pending.length > 0) {
          return Promise.resolve({ value: self.pending.shift()!, done: false });
        }
        if (self.done) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<DockerEvent>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<DockerEvent>> {
        self.abort();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    } as AsyncIterableIterator<DockerEvent>;
  }
}

/**
 * Streaming Docker container logs. Yields raw text chunks. Docker multiplexes
 * stdout/stderr in a tiny 8-byte header frame; for wos's needs we strip
 * those frames and emit only the payload bytes.
 */
export class DockerLogStream {
  readonly ready: Promise<void>;
  private socket?: Socket;
  /** Raw socket bytes awaiting HTTP header parse / chunked-transfer decode. */
  private raw = Buffer.alloc(0);
  /** Decoded HTTP body bytes awaiting Docker frame parse. */
  private buffer = Buffer.alloc(0);
  private pending: string[] = [];
  private waiters: Array<(value: IteratorResult<string>) => void> = [];
  private done = false;
  private headersDone = false;
  private chunked = false;
  private tty = false;

  constructor(target: string | DockerTransport, path: string) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const socket =
        typeof target === "string" ? netConnect(target) : connectDockerTransport(target);
      this.socket = socket;
      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: docker\r\n` +
        `Accept: application/octet-stream\r\n` +
        `Connection: keep-alive\r\n\r\n`;
      socket.write(req);
      socket.on("data", (chunk: Buffer) => {
        this.raw = Buffer.concat([this.raw, chunk]);
        if (!this.headersDone) {
          const idx = this.raw.indexOf("\r\n\r\n");
          if (idx < 0) return;
          const headerText = this.raw.slice(0, idx).toString("utf-8");
          // Heuristic: TTY containers send raw bytes (no 8-byte frame).
          // Non-TTY containers use the multiplexed framing.
          this.tty = /Content-Type:\s*application\/vnd\.docker\.raw-stream/i.test(headerText);
          // Docker streams the logs body with HTTP chunked transfer encoding.
          // Its chunk framing must be stripped before Docker's own framing.
          this.chunked = /Transfer-Encoding:\s*chunked/i.test(headerText);
          this.raw = this.raw.slice(idx + 4);
          this.headersDone = true;
          resolveReady();
        }
        const ended = this.ingest();
        this.drain();
        if (ended) this.finish();
      });
      socket.on("end", () => this.finish());
      socket.on("error", (e: Error) => {
        if (!this.headersDone) rejectReady(e);
        this.finish();
      });
      socket.on("close", () => this.finish());
    });
  }

  /**
   * Move available body bytes from the raw socket buffer into the body buffer,
   * decoding HTTP chunked transfer framing when the response uses it. Partial
   * size lines or partial chunk bodies stay in `raw` until more bytes arrive.
   * Returns `true` once the chunked terminating frame is reached so the caller
   * can finish the stream — but only after draining the bytes decoded so far.
   */
  private ingest(): boolean {
    if (!this.chunked) {
      if (this.raw.length > 0) {
        this.buffer = Buffer.concat([this.buffer, this.raw]);
        this.raw = Buffer.alloc(0);
      }
      return false;
    }
    for (;;) {
      const nl = this.raw.indexOf("\r\n");
      if (nl < 0) return false; // incomplete size line
      const sizeLine = this.raw.slice(0, nl).toString("ascii");
      const semi = sizeLine.indexOf(";"); // ignore chunk extensions
      const sizeHex = (semi >= 0 ? sizeLine.slice(0, semi) : sizeLine).trim();
      const size = parseInt(sizeHex, 16);
      if (!Number.isFinite(size)) return false; // malformed framing
      if (size === 0) return true; // terminating chunk: body complete
      const dataStart = nl + 2;
      const dataEnd = dataStart + size;
      if (this.raw.length < dataEnd + 2) return false; // wait for data + trailing CRLF
      this.buffer = Buffer.concat([this.buffer, this.raw.slice(dataStart, dataEnd)]);
      this.raw = this.raw.slice(dataEnd + 2);
    }
  }

  private drain(): void {
    if (this.tty) {
      if (this.buffer.length > 0) {
        const text = this.buffer.toString("utf-8");
        this.buffer = Buffer.alloc(0);
        this.push(text);
      }
      return;
    }
    // Multiplexed framing: [stream(1) | reserved(3) | size(4 BE)] then payload
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + size) return;
      const payload = this.buffer.slice(8, 8 + size);
      this.buffer = this.buffer.slice(8 + size);
      this.push(payload.toString("utf-8"));
    }
  }

  private push(text: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: text, done: false });
    } else {
      this.pending.push(text);
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters) {
      w({ value: undefined as never, done: true });
    }
    this.waiters = [];
  }

  abort(): void {
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<string>> {
        if (self.pending.length > 0) {
          return Promise.resolve({ value: self.pending.shift()!, done: false });
        }
        if (self.done) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<string>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<string>> {
        self.abort();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    } as AsyncIterableIterator<string>;
  }
}
