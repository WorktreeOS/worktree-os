/**
 * Provider-agnostic Let's Encrypt DNS-01 challenge runner abstraction.
 *
 * The ACME manager depends on this small interface so it can dispatch to
 * either the hook runner (`dns-hook.ts`) or the Cloudflare runner
 * (`dns-cloudflare.ts`) without knowing the difference. Each runner is
 * responsible for publishing the `_acme-challenge` TXT record, waiting for
 * propagation, and removing it after validation completes.
 */

import type { LetsEncryptChallenge } from "@worktreeos/core/global-config";
import type { SslListenerKind } from "./storage";
import { hookRunner } from "./dns-hook";
import {
  cloudflareRunner,
  type CloudflareRunnerOptions,
} from "./dns-cloudflare";

export interface ChallengeRunContext {
  recordName: string;
  recordValue: string;
  baseDomain: string;
  listenerKind: SslListenerKind;
  certificateNames: string[];
}

export interface ChallengeRunResult {
  ok: boolean;
  /**
   * User-facing detail when `ok` is false. Empty string when the call
   * succeeded. Includes provider-specific phrasing — the caller passes this
   * straight through to certificate status / lifecycle events.
   */
  detail: string;
  durationMs: number;
}

export interface ChallengeRunner {
  create(ctx: ChallengeRunContext): Promise<ChallengeRunResult>;
  delete(ctx: ChallengeRunContext): Promise<ChallengeRunResult>;
  /** Sleep `propagationSeconds` after `create` so DNS can converge. */
  waitForPropagation(): Promise<void>;
}

export interface SelectChallengeRunnerOptions {
  env?: NodeJS.ProcessEnv;
  cloudflare?: CloudflareRunnerOptions;
}

/**
 * Select the runner that matches `challenge.provider`. Token resolution and
 * other one-time setup happens here so the manager loop sees a uniform
 * `ChallengeRunner` interface.
 */
export function selectChallengeRunner(
  challenge: LetsEncryptChallenge,
  opts: SelectChallengeRunnerOptions = {},
): ChallengeRunner {
  if (challenge.provider === "cloudflare") {
    return cloudflareRunner(challenge, opts.env ?? process.env, opts.cloudflare);
  }
  return hookRunner(challenge);
}

/** Render a challenge failure message for inclusion in certificate status. */
export function renderChallengeError(
  phase: "create" | "delete",
  provider: LetsEncryptChallenge["provider"],
  result: ChallengeRunResult,
): string {
  const detail = result.detail.trim() || "<no detail>";
  return `DNS ${phase} via ${provider} failed (${result.durationMs}ms): ${detail}`;
}
