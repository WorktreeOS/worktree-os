import { spawn } from "node:child_process";
import type { LetsEncryptHookChallenge } from "@worktreeos/core/global-config";
import type {
  ChallengeRunResult,
  ChallengeRunner,
} from "./challenge-runner";
import type { SslListenerKind } from "./storage";

export interface DnsHookEnv {
  WOS_ACME_HOOK_PHASE: "create" | "delete";
  WOS_ACME_RECORD_NAME: string;
  WOS_ACME_RECORD_VALUE: string;
  WOS_ACME_BASE_DOMAIN: string;
  WOS_ACME_LISTENER_KIND: SslListenerKind;
  WOS_ACME_CERTIFICATE_NAMES: string;
}

export interface DnsHookContext {
  phase: "create" | "delete";
  recordName: string;
  recordValue: string;
  baseDomain: string;
  listenerKind: SslListenerKind;
  certificateNames: string[];
}

export interface DnsHookResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Execute a DNS-01 hook command. The command runs under the user's default
 * shell so users can compose pipelines or call provider CLIs without wos
 * understanding their tooling. Inputs are passed as environment variables; the
 * command is NEVER given user-controlled values on its argv to avoid shell
 * injection from challenge tokens.
 */
export async function runDnsHook(
  command: string,
  ctx: DnsHookContext,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DnsHookResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WOS_ACME_HOOK_PHASE: ctx.phase,
    WOS_ACME_RECORD_NAME: ctx.recordName,
    WOS_ACME_RECORD_VALUE: ctx.recordValue,
    WOS_ACME_BASE_DOMAIN: ctx.baseDomain,
    WOS_ACME_LISTENER_KIND: ctx.listenerKind,
    WOS_ACME_CERTIFICATE_NAMES: ctx.certificateNames.join(","),
  };
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  return await new Promise<DnsHookResult>((resolveProm) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, [], {
      shell: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (code: number | null, killedByTimeout: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProm({
        ok: !killedByTimeout && code === 0,
        stdout: stdout.slice(-8192),
        stderr: killedByTimeout
          ? (stderr + "\n[hook] timed out").slice(-8192)
          : stderr.slice(-8192),
        exitCode: code,
        durationMs: Date.now() - start,
      });
    };
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err: Error) => {
      stderr += `\n[hook] spawn error: ${err.message}`;
      settle(null, false);
    });
    child.on("close", (code: number | null) => {
      settle(code, false);
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      settle(null, true);
    }, timeoutMs);
    opts.signal?.addEventListener("abort", () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      settle(null, false);
    });
  });
}

/**
 * Wrap a configured DNS-01 hook challenge so the ACME manager can call
 * `create` / `waitForPropagation` / `delete` without re-deriving env contracts.
 */
export function hookRunner(challenge: LetsEncryptHookChallenge): ChallengeRunner {
  return {
    async create(ctx) {
      return hookResultToChallengeResult(
        await runDnsHook(challenge.createCommand, { ...ctx, phase: "create" }),
      );
    },
    async delete(ctx) {
      return hookResultToChallengeResult(
        await runDnsHook(challenge.deleteCommand, { ...ctx, phase: "delete" }),
      );
    },
    async waitForPropagation() {
      if (challenge.propagationSeconds > 0) {
        await new Promise((r) => setTimeout(r, challenge.propagationSeconds * 1000));
      }
    },
  };
}

function hookResultToChallengeResult(result: DnsHookResult): ChallengeRunResult {
  if (result.ok) {
    return { ok: true, detail: "", durationMs: result.durationMs };
  }
  const exit = result.exitCode === null ? "no-exit" : String(result.exitCode);
  const stderrSnippet =
    result.stderr.trim().split("\n").slice(-3).join(" | ") || "<no stderr>";
  return {
    ok: false,
    detail: `exit=${exit} ${stderrSnippet}`,
    durationMs: result.durationMs,
  };
}
