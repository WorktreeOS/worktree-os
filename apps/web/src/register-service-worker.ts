export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
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
