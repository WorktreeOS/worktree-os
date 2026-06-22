import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { AgentActivityEvent } from "@worktreeos/core/agent-activity";

const SEND_TIMEOUT_MS = 1000;

function wosHome(env: Record<string, string | undefined>): string {
  const raw = env.WOS_HOME;
  if (raw && raw.length > 0) return resolve(raw.replace(/^~(?=\/|$)/, homedir()));
  return resolve(homedir(), ".wos");
}

function readFirstLine(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const line = text.split("\n", 1)[0]?.trim();
    return line && line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the daemon URL from env or the persisted daemon metadata. */
export function resolveDaemonUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.WOS_DAEMON_URL) return env.WOS_DAEMON_URL;
  try {
    const meta = JSON.parse(
      readFileSync(resolve(wosHome(env), "daemon.json"), "utf8"),
    ) as { webUrl?: string };
    return meta.webUrl || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the agent token from env or the persisted token file. */
export function resolveAgentToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.WOS_AGENT_TOKEN) return env.WOS_AGENT_TOKEN;
  return readFirstLine(resolve(wosHome(env), "agent-token"));
}

/**
 * Fire-and-forget delivery to the daemon. Never throws and never blocks the
 * caller beyond building the request: the network promise is detached and
 * failures (daemon down, timeout, missing URL/token) are silently ignored.
 */
export function sendActivityEvent(
  event: AgentActivityEvent,
  env: Record<string, string | undefined> = process.env,
): void {
  const url = resolveDaemonUrl(env);
  const token = resolveAgentToken(env);
  if (!url || !token) return;
  void fetch(`${url.replace(/\/$/, "")}/ui/v1/agent-events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  }).catch(() => {});
}
