/* WorktreeOS service worker
 * App-shell caching only. Daemon API, event streams, and WebSocket traffic
 * MUST NOT be cached because WorktreeOS state is live and local-machine-specific.
 */

const CACHE_VERSION = "wos-app-shell-v1";
const APP_SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.add(APP_SHELL_URL)).catch(() => {
      // App-shell pre-cache is opportunistic; failing it must not block install.
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("wos-") && key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiPath(pathname) {
  return (
    pathname === "/ui/v1" ||
    pathname.startsWith("/ui/v1/") ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/")
  );
}

function isWebSocketUpgrade(request) {
  const upgrade = request.headers.get("upgrade");
  return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

self.addEventListener("push", (event) => {
  // Daemon-sent Web Push: the payload carries the rendered notification so the
  // worker shows it without any lookup. Tolerate a missing/garbled payload.
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  const title = payload.title || "WorktreeOS";
  const path = (payload.data && payload.data.path) || "/";
  const options = {
    body: payload.body || "",
    tag: payload.kind || payload.tag,
    data: { path },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.path) || "/";
  event.waitUntil(
    (async () => {
      const url = new URL(target, self.location.origin).href;
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // Cross-origin or detached client: focus alone is the fallback.
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") return;
  if (isWebSocketUpgrade(request)) return;
  if (isApiPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(APP_SHELL_URL);
        if (cached) return cached;
        return Response.error();
      }),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })(),
  );
});
