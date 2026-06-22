import { join, normalize, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DaemonWebTlsOptions {
  /** PEM-encoded certificate body. */
  cert: string;
  /** PEM-encoded private key body. */
  key: string;
}

export interface DaemonWebOptions {
  /** Override loopback host. Defaults to `127.0.0.1`. */
  host?: string;
  /** Override loopback port. Defaults to `0` (OS-assigned). */
  port?: number;
  /** Override the directory holding the built web assets. */
  assetRoot?: string;
  /**
   * Override the embedded asset source. Defaults to auto-detection from the
   * Bun standalone executable (`Bun.embeddedFiles` + the bundle registered via
   * `setEmbeddedWebBundle`). Pass `null` to explicitly disable embedded mode
   * even when the binary contains assets (tests).
   */
  embedded?: EmbeddedAssetSource | null;
  /**
   * When provided, replaces the default stderr warning emitted on bind failure
   * so the caller can emit a consolidated message (e.g. public-bind fallback
   * to loopback). The handler still returns `undefined` on bind failure.
   */
  onBindError?: (err: Error) => void;
  /**
   * Enable HTTPS for the listener. When provided, `Bun.serve` is started with
   * a `tls` option using the supplied PEM material.
   */
  tls?: DaemonWebTlsOptions;
}

export interface DaemonWebHandle {
  url: string;
  port: number;
  hostname: string;
  /** Effective listener scheme — `http` or `https`. */
  scheme: "http" | "https";
  stop: () => Promise<void>;
}

/**
 * Embedded web asset source used when the daemon runs from a Bun standalone
 * executable. The `bundle` field is registered on `Bun.serve` routes so that
 * Bun handles the bundled JS/CSS chunks with proper MIME types and cache
 * headers; `serveIndexHtml()` is used for the SPA fallback.
 */
export interface EmbeddedAssetSource {
  bundle?: unknown;
  serveIndexHtml: () => Promise<Response>;
  /**
   * Optional lookup for embedded static assets at stable root paths (e.g.
   * `/manifest.webmanifest`, `/service-worker.js`). Resolves to `undefined`
   * when the path is not a known embedded asset, in which case the embedded
   * handler falls back to the SPA index HTML.
   */
  serveAsset?: (pathname: string) => Promise<Response | undefined>;
}

const DEFAULT_HOST = "127.0.0.1";

export const DEFAULT_WEB_PORT = 4949;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Resolve the directory that contains the built web assets. We first honor an
 * explicit override, then walk up from this file looking for `apps/web/dist`
 * (source checkout) or `web-dist` (packaged install layout).
 */
export function resolveWebAssetRoot(override?: string): string | undefined {
  if (override) {
    return existsSync(override) ? resolve(override) : undefined;
  }
  // packages/daemon/src/daemon-web.ts → ../../apps/web/dist (source layout)
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "../../../apps/web/dist"),
    resolve(here, "../../web-dist"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

let registeredEmbeddedBundle: unknown;
let registeredEmbeddedAssets: Record<
  string,
  { body: string | ArrayBuffer | Uint8Array; contentType: string }
> = {};

/**
 * Register the Bun `HTMLBundle` reference imported at the CLI entrypoint. The
 * bundle is only used by the daemon when running inside a Bun standalone
 * executable; in dev (`bun apps/cli/index.ts`) the daemon still prefers the
 * filesystem `apps/web/dist` output.
 */
export function setEmbeddedWebBundle(bundle: unknown): void {
  registeredEmbeddedBundle = bundle;
}

export function getEmbeddedWebBundle(): unknown {
  return registeredEmbeddedBundle;
}

/**
 * Register additional embedded static assets that the daemon should serve at
 * stable browser-addressable paths (e.g. `/manifest.webmanifest`,
 * `/service-worker.js`). The CLI entrypoint calls this when running from the
 * compiled standalone binary so the daemon can answer those requests without
 * relying on `apps/web/dist`.
 */
export function setEmbeddedPwaAssets(
  assets: Record<
    string,
    { body: string | ArrayBuffer | Uint8Array; contentType: string }
  >,
): void {
  registeredEmbeddedAssets = assets;
}

/**
 * Auto-detect an embedded asset source. Returns `undefined` outside a Bun
 * standalone executable, or when the CLI entrypoint did not register a bundle.
 */
export function detectEmbeddedAssetSource(): EmbeddedAssetSource | undefined {
  const files = (Bun as { embeddedFiles?: ReadonlyArray<Blob> }).embeddedFiles;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  if (!registeredEmbeddedBundle) return undefined;
  let htmlBlob: Blob | undefined;
  for (const blob of files) {
    const name = typeof blob.name === "string" ? blob.name : "";
    if (!name.toLowerCase().endsWith(".html")) continue;
    if (!htmlBlob || name.toLowerCase().includes("index")) htmlBlob = blob;
  }
  if (!htmlBlob) return undefined;
  const indexHtmlBlob = htmlBlob;
  const assetSnapshot = registeredEmbeddedAssets;
  const hasAssets = Object.keys(assetSnapshot).length > 0;
  return {
    bundle: registeredEmbeddedBundle,
    serveIndexHtml: async () =>
      new Response(indexHtmlBlob, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    serveAsset: hasAssets
      ? async (pathname: string) => {
          const asset = assetSnapshot[pathname];
          if (!asset) return undefined;
          return new Response(asset.body, {
            status: 200,
            headers: { "content-type": asset.contentType },
          });
        }
      : undefined,
  };
}

function safeJoin(root: string, requested: string): string | undefined {
  const cleaned = decodeURIComponent(requested).replace(/^\/+/, "");
  const target = normalize(join(root, cleaned));
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) {
    return undefined;
  }
  return target;
}

async function fileResponse(path: string): Promise<Response | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return new Response(file, {
    status: 200,
    headers: { "content-type": contentTypeFor(path) },
  });
}

function missingBuildResponse(): Response {
  const body = [
    "wos web build is missing.",
    "Run `bun run build:web` in the wos monorepo to populate apps/web/dist,",
    "then restart the daemon.",
    "",
  ].join("\n");
  return new Response(body, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function uiApiNotFoundResponse(pathname: string): Response {
  return new Response(
    JSON.stringify({
      error: "not-found",
      message: `unknown UI API path ${pathname}`,
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

export type UiApiHandler = (
  req: Request,
  server?: import("bun").Server,
) => Promise<Response | null>;

/** Build the request handler for the web listener. Exported for tests. */
export function createWebRequestHandler(
  assetRoot: string | undefined,
  uiApiHandler?: UiApiHandler,
  embedded?: EmbeddedAssetSource,
): (req: Request, server?: import("bun").Server) => Promise<Response> {
  return async (
    req: Request,
    server?: import("bun").Server,
  ): Promise<Response> => {
    const url = new URL(req.url);
    // UI API routes are always considered first so that browser requests to
    // `/ui/v1/*` never fall through to the SPA fallback HTML — regardless of
    // whether assets come from the embedded bundle or the filesystem.
    if (uiApiHandler && url.pathname.startsWith("/ui/v1")) {
      const apiRes = await uiApiHandler(req, server);
      if (apiRes) return apiRes;
      return uiApiNotFoundResponse(url.pathname);
    }
    // Legacy `/v1/*` socket-era daemon API routes were removed together with
    // the Unix domain socket. Return a structured JSON 404 naming the
    // supported replacement so stale clients fail with a clear pointer
    // instead of receiving the SPA fallback HTML.
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      return new Response(
        JSON.stringify({
          error: "not-found",
          message: `legacy daemon API path ${url.pathname} was removed; use the /ui/v1/* HTTP API`,
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    if (embedded) {
      // The HTMLBundle route (when configured) serves `/` and all bundled
      // JS/CSS chunks. Stable PWA assets like `/manifest.webmanifest` and
      // `/service-worker.js` live outside the HTMLBundle, so try the explicit
      // embedded asset lookup before falling back to the SPA index HTML.
      if (embedded.serveAsset) {
        const asset = await embedded.serveAsset(url.pathname);
        if (asset) return asset;
      }
      return embedded.serveIndexHtml();
    }

    if (!assetRoot) return missingBuildResponse();

    let pathname = url.pathname;
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const target = safeJoin(assetRoot, pathname);
    if (target) {
      const res = await fileResponse(target);
      if (res) return res;
    }

    // SPA fallback for any non-file frontend route (e.g. /sessions/foo).
    const indexPath = join(assetRoot, "index.html");
    const indexRes = await fileResponse(indexPath);
    if (indexRes) return indexRes;

    return missingBuildResponse();
  };
}

export interface WebSocketHandlerSet {
  open?(ws: import("bun").ServerWebSocket<any>): void;
  message?(ws: import("bun").ServerWebSocket<any>, message: string | Buffer): void;
  close?(
    ws: import("bun").ServerWebSocket<any>,
    code: number,
    reason: string,
  ): void;
}

export interface StartDaemonWebExtraOptions {
  uiApiHandler?: UiApiHandler;
  /** Optional WebSocket lifecycle handlers (e.g. terminal session attach). */
  websocketHandlers?: WebSocketHandlerSet;
}

export async function startDaemonWeb(
  opts: DaemonWebOptions = {},
  extra: StartDaemonWebExtraOptions = {},
): Promise<DaemonWebHandle | undefined> {
  const hostname = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? 0;
  const embedded =
    opts.embedded === null
      ? undefined
      : (opts.embedded ?? detectEmbeddedAssetSource());
  // Compiled-binary mode owns frontend serving — never probe `apps/web/dist`
  // when an embedded bundle is in use.
  const assetRoot = embedded ? undefined : resolveWebAssetRoot(opts.assetRoot);
  const handler = createWebRequestHandler(assetRoot, extra.uiApiHandler, embedded);

  type ServeOpts = Parameters<typeof Bun.serve>[0] & {
    routes?: Record<string, unknown>;
    websocket?: unknown;
    tls?: { cert: string; key: string };
  };
  const serveOpts: ServeOpts = {
    hostname,
    port,
    // SSE event streams and long-running log streams must not be torn down
    // by Bun.serve's default 10s idle timeout.
    idleTimeout: 0,
    fetch: handler,
  };
  if (opts.tls) {
    serveOpts.tls = { cert: opts.tls.cert, key: opts.tls.key };
  }

  if (extra.websocketHandlers) {
    const ws = extra.websocketHandlers;
    serveOpts.websocket = {
      // Bun's default WS idle timeout is 120s. Terminal sessions are
      // expected to sit silent for long stretches (the user reads a man page,
      // walks away from the laptop, etc.), so the kernel sees no traffic and
      // Bun tears the socket down → the browser reports `1006 abnormal
      // closure`. We disable idle expiry on the server; keep-alive is then
      // handled by Bun's automatic PING frames (sendPings is on by default).
      idleTimeout: 0,
      open(socket: import("bun").ServerWebSocket<any>) {
        ws.open?.(socket);
      },
      message(
        socket: import("bun").ServerWebSocket<any>,
        message: string | Buffer,
      ) {
        ws.message?.(socket, message);
      },
      close(
        socket: import("bun").ServerWebSocket<any>,
        code: number,
        reason: string,
      ) {
        ws.close?.(socket, code, reason);
      },
    };
  }

  if (embedded?.bundle !== undefined) {
    serveOpts.routes = { "/": embedded.bundle };
  }

  let server: ReturnType<typeof Bun.serve> | undefined;
  let serveError: Error | undefined;
  try {
    server = Bun.serve(serveOpts);
  } catch (e) {
    serveError = e as Error;
  }
  // The embedded web-UI bundle route (compiled-binary mode) is what serves the
  // hashed JS/CSS chunks. If constructing the listener WITH that route throws
  // for any reason other than a port conflict, drop the route and retry so the
  // control plane — health, CLI, and the /ui/v1 API — still binds instead of
  // failing daemon startup outright. The SPA index keeps being served by the
  // embedded `serveIndexHtml` fetch handler; only hashed-chunk routing is
  // degraded until the bundle route is fixed. A real port conflict
  // (`EADDRINUSE`) is left untouched for the caller's bind-retry loop.
  if (
    !server &&
    serveOpts.routes &&
    (serveError as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE"
  ) {
    process.stderr.write(
      `wos daemon: web UI bundle route disabled — Bun.serve rejected it ` +
        `(${serveError?.message ?? "unknown error"}); serving the SPA index ` +
        `without hashed-chunk routing\n`,
    );
    const { routes: _unusedRoutes, ...withoutRoutes } = serveOpts;
    try {
      server = Bun.serve(withoutRoutes);
      serveError = undefined;
    } catch (e) {
      serveError = e as Error;
    }
  }
  if (!server) {
    if (opts.onBindError) {
      opts.onBindError(serveError as Error);
    } else {
      process.stderr.write(
        `wos daemon: web UI disabled — could not bind ${hostname}:${port} (${serveError?.message ?? "unknown error"})\n`,
      );
    }
    return undefined;
  }

  // The `url` field is the *client-facing* address for local consumers (the
  // CLI, the browser launcher, metadata readers). When the listener binds to
  // the wildcard `0.0.0.0`, surface `127.0.0.1` instead so opening the URL on
  // the same host always works. `hostname` continues to reflect the real
  // bind address so callers that care about the listener interface can read
  // it directly.
  const clientHost =
    server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname;
  const scheme: "http" | "https" = opts.tls ? "https" : "http";
  const url = `${scheme}://${clientHost}:${server.port}`;
  return {
    url,
    port: server.port,
    hostname: server.hostname,
    scheme,
    stop: async () => {
      try {
        server.stop(true);
      } catch {
        /* ignore */
      }
    },
  };
}
