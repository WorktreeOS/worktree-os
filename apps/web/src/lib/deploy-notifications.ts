// Pure logic for opt-in OS notifications on deploy failures and healthcheck
// degradation. Kept free of React/DOM-binding so it can be unit-tested: the
// React hook in `deploy-notifications-bridge.tsx` wires this to the live SSE
// stream and the service worker.

import type { UnifiedEventEnvelope } from "./unified-events";

/** Per-device opt-in flag key (localStorage). */
export const NOTIFY_ON_DEPLOY_FAILURE_KEY = "wos.notifyOnDeployFailure";

export type NotificationPermissionState = "granted" | "denied" | "default";

/** Read the per-device opt-in flag. Defaults to off. */
export function getNotifyOnDeployFailure(
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(NOTIFY_ON_DEPLOY_FAILURE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the per-device opt-in flag. */
export function setNotifyOnDeployFailure(
  storage: Pick<Storage, "setItem"> | null | undefined,
  enabled: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(NOTIFY_ON_DEPLOY_FAILURE_KEY, enabled ? "1" : "0");
  } catch {
    // Best-effort: a denied/full storage must not break the toggle.
  }
}

/** A healthcheck transition that enters a failed/unhealthy state. */
function isHealthcheckDegradation(
  previous: string | undefined,
  state: string,
): boolean {
  // `failed-allowed` is an expected, non-blocking state; we only notify on a
  // hard `failed` transition and only when it is a transition (the previous
  // state was not already failed), to avoid re-notifying on repeated probes.
  if (state !== "failed") return false;
  return previous !== "failed";
}

export interface NotificationPlan {
  /** Notification title. */
  title: string;
  /** Notification body. */
  body: string;
  /** Tag de-dupes repeated notifications for the same worktree+kind. */
  tag: string;
  /** Click-through route path. */
  path: string;
  /** Stable session identity of the affected worktree. */
  sessionName: string;
  /** Filesystem worktree path, when carried by the envelope. */
  worktreePath?: string;
}

export interface EvaluateContext {
  /** Whether the per-device opt-in is enabled. */
  enabled: boolean;
  /** Current browser Notification permission. */
  permission: NotificationPermissionState;
  /**
   * The session/worktree currently foregrounded by the user, if any: document
   * is visible AND routed to that worktree. Used to suppress redundant OS
   * notifications.
   */
  foregroundedSessionName?: string | null;
  foregroundedWorktreePath?: string | null;
}

/**
 * Decide whether an envelope should raise an OS notification, and if so build
 * its content. Returns `null` when no notification should fire.
 */
export function evaluateNotification(
  env: UnifiedEventEnvelope,
  ctx: EvaluateContext,
): NotificationPlan | null {
  if (!ctx.enabled) return null;
  if (ctx.permission !== "granted") return null;

  const sessionName = env.sessionName;
  if (!sessionName) return null;

  let title: string;
  let body: string;
  let tag: string;

  if (env.event.type === "deployment.failed") {
    title = `Deploy failed · ${sessionName}`;
    body = env.event.message || "The deployment failed.";
    tag = `wos-deploy-failed:${sessionName}`;
  } else if (env.event.type === "healthcheck.changed") {
    if (!isHealthcheckDegradation(env.event.previous, env.event.state)) {
      return null;
    }
    const service = env.event.service;
    title = `Healthcheck failed · ${sessionName}`;
    body = env.event.message
      ? `${service}: ${env.event.message}`
      : `${service} became unhealthy.`;
    tag = `wos-healthcheck-failed:${sessionName}:${service}`;
  } else {
    return null;
  }

  // Suppress when the affected worktree is already foregrounded.
  const foregroundedBySession =
    ctx.foregroundedSessionName != null &&
    ctx.foregroundedSessionName === sessionName;
  const foregroundedByPath =
    ctx.foregroundedWorktreePath != null &&
    env.worktreePath != null &&
    ctx.foregroundedWorktreePath === env.worktreePath;
  if (foregroundedBySession || foregroundedByPath) return null;

  const routePath = env.worktreePath ?? sessionName;
  const path = `/worktree?path=${encodeURIComponent(routePath)}`;

  return {
    title,
    body,
    tag,
    path,
    sessionName,
    ...(env.worktreePath != null ? { worktreePath: env.worktreePath } : {}),
  };
}
