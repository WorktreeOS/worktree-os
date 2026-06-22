import { useEffect } from "react";
import { useLocation } from "react-router";
import { useUnifiedEvents } from "./events-context";
import {
  evaluateNotification,
  getNotifyOnDeployFailure,
  type NotificationPermissionState,
} from "./deploy-notifications";

function currentPermission(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission as NotificationPermissionState;
}

/**
 * Determine the worktree currently foregrounded by the user: the document is
 * visible AND the route is the worktree detail for some `?path=`. Returns the
 * worktree path, or null when not foregrounded on a worktree.
 */
function foregroundedWorktreePath(
  pathname: string,
  search: string,
): string | null {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return null;
  }
  if (pathname !== "/worktree") return null;
  const params = new URLSearchParams(search);
  return params.get("path");
}

/**
 * Bridge live SSE events to OS notifications for deploy failures and
 * healthcheck degradation. Gated on the per-device opt-in and granted browser
 * permission; suppressed when the affected worktree is foregrounded. Existing
 * in-app toast behavior is left untouched.
 */
export function useDeployFailureNotifications(): void {
  const events = useUnifiedEvents();
  const location = useLocation();

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const unsubscribe = events.subscribe((env) => {
      const enabled = getNotifyOnDeployFailure(
        typeof localStorage !== "undefined" ? localStorage : null,
      );
      const foregroundedPath = foregroundedWorktreePath(
        location.pathname,
        location.search,
      );
      const plan = evaluateNotification(env, {
        enabled,
        permission: currentPermission(),
        foregroundedWorktreePath: foregroundedPath,
      });
      if (!plan) return;

      void navigator.serviceWorker.ready
        .then((registration) =>
          registration.showNotification(plan.title, {
            body: plan.body,
            tag: plan.tag,
            data: { path: plan.path },
          }),
        )
        .catch(() => {
          // Notification delivery is best-effort; never surface failures.
        });
    });

    return unsubscribe;
  }, [events, location.pathname, location.search]);
}
