/**
 * True when the UI is running inside the desktop window (the Electrobun shell
 * appends `?wosRuntime=desktop` to the loopback URL). Service workers / PWA
 * install are unreliable and unwanted inside a system webview, so desktop mode
 * skips registration.
 */
export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("wosRuntime") === "desktop";
}

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (isDesktopRuntime()) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js", { scope: "/" })
      .catch(() => {
        // Registration failure must not affect the running app — the daemon
        // still serves the UI without service-worker support.
      });
  });
}
