import { test, expect, describe, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

interface FetchEvent {
  request: Request;
  respondWith: (response: Response | Promise<Response>) => void;
  responded?: Response | Promise<Response>;
}

interface InstallEvent {
  waitUntil: (p: Promise<unknown>) => void;
}

interface ActivateEvent {
  waitUntil: (p: Promise<unknown>) => void;
}

interface FakeCache {
  store: Map<string, Response>;
  add: (req: string | Request) => Promise<void>;
  put: (req: Request, res: Response) => Promise<void>;
  match: (req: string | Request) => Promise<Response | undefined>;
}

interface FakeWindowClient {
  id: string;
  focused: boolean;
  navigatedTo?: string;
  focus: () => Promise<FakeWindowClient>;
  navigate: (url: string) => Promise<FakeWindowClient>;
}

interface SwEnv {
  fetchHandler?: (event: FetchEvent) => void;
  installHandler?: (event: InstallEvent) => void;
  activateHandler?: (event: ActivateEvent) => void;
  notificationClickHandler?: (event: any) => void;
  caches: Map<string, FakeCache>;
  deletedCaches: string[];
  skipWaitingCalled: boolean;
  claimCalled: boolean;
  windowClients: FakeWindowClient[];
  openedWindows: string[];
}

const TEST_ORIGIN = "http://127.0.0.1:4949";

function normalizeKey(req: string | Request): string {
  const raw = typeof req === "string" ? req : req.url;
  try {
    return new URL(raw, TEST_ORIGIN).toString();
  } catch {
    return raw;
  }
}

function makeCache(): FakeCache {
  const store = new Map<string, Response>();
  return {
    store,
    add: async (req) => {
      store.set(normalizeKey(req), new Response("cached", { status: 200 }));
    },
    put: async (req, res) => {
      store.set(normalizeKey(req), res);
    },
    match: async (req) => store.get(normalizeKey(req)),
  };
}

async function loadServiceWorker(): Promise<SwEnv> {
  const swPath = resolve(
    import.meta.dir,
    "..",
    "apps/web/public/service-worker.js",
  );
  const source = await readFile(swPath, "utf8");

  const env: SwEnv = {
    caches: new Map(),
    deletedCaches: [],
    skipWaitingCalled: false,
    claimCalled: false,
    windowClients: [],
    openedWindows: [],
  };

  const swSelf = {
    location: { origin: "http://127.0.0.1:4949" },
    addEventListener: (type: string, handler: (ev: any) => void) => {
      if (type === "fetch") env.fetchHandler = handler;
      if (type === "install") env.installHandler = handler;
      if (type === "activate") env.activateHandler = handler;
      if (type === "notificationclick") env.notificationClickHandler = handler;
    },
    skipWaiting: () => {
      env.skipWaitingCalled = true;
    },
    clients: {
      claim: async () => {
        env.claimCalled = true;
      },
      matchAll: async () => env.windowClients,
      openWindow: async (url: string) => {
        env.openedWindows.push(url);
        return null;
      },
    },
  };

  const fakeCaches = {
    open: async (name: string) => {
      let cache = env.caches.get(name);
      if (!cache) {
        cache = makeCache();
        env.caches.set(name, cache);
      }
      return cache;
    },
    keys: async () => Array.from(env.caches.keys()),
    delete: async (name: string) => {
      env.deletedCaches.push(name);
      return env.caches.delete(name);
    },
    match: async () => undefined,
  };

  const fakeFetch: typeof fetch = async () => {
    throw new Error("network unavailable in test");
  };
  const fn = new Function("self", "caches", "fetch", "Response", source);
  fn(swSelf, fakeCaches, fakeFetch, Response);
  return env;
}

let env: SwEnv;

beforeEach(async () => {
  env = await loadServiceWorker();
});

function makeFetchEvent(
  url: string,
  init: { method?: string; mode?: RequestMode; headers?: Record<string, string> } = {},
): FetchEvent {
  const request = new Request(url, {
    method: init.method ?? "GET",
    mode: init.mode,
    headers: init.headers,
  });
  const event: FetchEvent = {
    request,
    respondWith: (res) => {
      event.responded = res;
    },
  };
  return event;
}

describe("service worker fetch handling", () => {
  test("bypasses /ui/v1 API requests", () => {
    const ev = makeFetchEvent("http://127.0.0.1:4949/ui/v1/health");
    env.fetchHandler!(ev);
    expect(ev.responded).toBeUndefined();
  });

  test("bypasses /ui/v1/* subpaths", () => {
    const ev = makeFetchEvent("http://127.0.0.1:4949/ui/v1/sessions/abc");
    env.fetchHandler!(ev);
    expect(ev.responded).toBeUndefined();
  });

  test("bypasses /v1 legacy API requests", () => {
    const ev = makeFetchEvent("http://127.0.0.1:4949/v1/health");
    env.fetchHandler!(ev);
    expect(ev.responded).toBeUndefined();
  });

  test("bypasses non-GET requests", () => {
    const ev = makeFetchEvent("http://127.0.0.1:4949/index.html", {
      method: "POST",
    });
    env.fetchHandler!(ev);
    expect(ev.responded).toBeUndefined();
  });

  test("bypasses WebSocket upgrade requests", () => {
    const ev = makeFetchEvent("http://127.0.0.1:4949/ws", {
      headers: { upgrade: "websocket" },
    });
    env.fetchHandler!(ev);
    expect(ev.responded).toBeUndefined();
  });

  test("bypasses cross-origin requests", () => {
    const ev = makeFetchEvent("https://fonts.googleapis.com/css2");
    env.fetchHandler!(ev);
    expect(ev.responded).toBeUndefined();
  });

  test("navigation request prefers network and falls back to app shell", async () => {
    const cache = await (await env.caches.values().next()).value ??
      // ensure cache exists
      (await (async () => {
        const fakeCaches = {
          open: async () => makeCache(),
        };
        return fakeCaches.open();
      })());
    // Pre-seed app shell into the SW's cache.
    const shellCache = makeCache();
    await shellCache.put(
      new Request("http://127.0.0.1:4949/"),
      new Response("APP-SHELL", { status: 200 }),
    );
    env.caches.set("wos-app-shell-v1", shellCache);

    const ev = makeFetchEvent("http://127.0.0.1:4949/anything", {
      mode: "navigate",
    });
    env.fetchHandler!(ev);
    expect(ev.responded).toBeDefined();
    // Network handler will try real fetch, which will fail (no server). The SW
    // catches and serves the cached shell.
    const res = (await ev.responded) as Response;
    expect(await res.text()).toBe("APP-SHELL");
  });

  test("static GET request uses cache when available", async () => {
    const shellCache = makeCache();
    await shellCache.put(
      new Request("http://127.0.0.1:4949/assets/app.js"),
      new Response("console.log(1);", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    );
    env.caches.set("wos-app-shell-v1", shellCache);
    const ev = makeFetchEvent("http://127.0.0.1:4949/assets/app.js");
    env.fetchHandler!(ev);
    expect(ev.responded).toBeDefined();
    const res = (await ev.responded) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1);");
  });

  test("notificationclick focuses an existing client and navigates", async () => {
    const client: FakeWindowClient = {
      id: "c1",
      focused: false,
      focus() {
        this.focused = true;
        return Promise.resolve(this);
      },
      navigate(url: string) {
        this.navigatedTo = url;
        return Promise.resolve(this);
      },
    };
    env.windowClients.push(client);

    let captured: Promise<unknown> | undefined;
    const closed = { called: false };
    env.notificationClickHandler!({
      notification: {
        data: { path: "/worktree?path=feature-x" },
        close: () => {
          closed.called = true;
        },
      },
      waitUntil: (p: Promise<unknown>) => {
        captured = p;
      },
    });
    await captured;

    expect(closed.called).toBe(true);
    expect(client.focused).toBe(true);
    expect(client.navigatedTo).toBe(
      "http://127.0.0.1:4949/worktree?path=feature-x",
    );
    expect(env.openedWindows).toHaveLength(0);
  });

  test("notificationclick opens a window when no client exists", async () => {
    let captured: Promise<unknown> | undefined;
    env.notificationClickHandler!({
      notification: {
        data: { path: "/worktree?path=feature-y" },
        close: () => {},
      },
      waitUntil: (p: Promise<unknown>) => {
        captured = p;
      },
    });
    await captured;

    expect(env.openedWindows).toEqual([
      "http://127.0.0.1:4949/worktree?path=feature-y",
    ]);
  });

  test("activate clears stale wos caches", async () => {
    env.caches.set("wos-app-shell-v0", makeCache());
    env.caches.set("wos-app-shell-v1", makeCache());
    env.caches.set("other-app", makeCache());
    const ev: ActivateEvent = { waitUntil: (p) => p };
    env.activateHandler!(ev);
    // waitUntil receives a promise — flush it.
    let captured: Promise<unknown> | undefined;
    env.activateHandler!({
      waitUntil: (p) => {
        captured = p;
      },
    });
    await captured;
    expect(env.deletedCaches).toContain("wos-app-shell-v0");
    expect(env.deletedCaches).not.toContain("wos-app-shell-v1");
    expect(env.deletedCaches).not.toContain("other-app");
    expect(env.claimCalled).toBe(true);
  });
});
