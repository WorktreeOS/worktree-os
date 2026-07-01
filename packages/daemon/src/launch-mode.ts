/**
 * Launch-mode detection and persistent-CLI materialization for the npm
 * distribution of wos.
 *
 * The agent plugins fire the literal `wos agent-hook <event>` on a hot path
 * (`PostToolUse` after every tool call), so `wos` must resolve to a persistent,
 * fast binary in the agent's login shell — never an ephemeral `bunx`
 * re-resolution. The hook command string is fixed (a committed `hooks.json`),
 * so detection does not template it; instead it decides whether a persistent
 * `wos` already exists or must be established.
 *
 * When wos was launched ephemerally (`bunx @worktreeos/cli`), `init` runs
 * `ensurePersistentCli()`, which silently `bun install -g`s the package so a
 * persistent `wos` lands in Bun's global bin directory — already on the user's
 * login `PATH` because Bun is a hard prerequisite. It is best-effort: a failed
 * install logs an actionable line and never throws.
 */

import { isCompiledStandalone } from "./daemon-bootstrap";
import { publishedCliVersion } from "./packaged-layout";

export const CLI_PACKAGE_NAME = "@worktreeos/cli";

/**
 * Whether the current runtime is Bun. The published bin is hard-gated to Bun;
 * this is the canonical marker (`process.versions.bun`). Pure over an injected
 * `versions` map so the CLI entry guard can be unit-tested without a
 * non-Bun runtime.
 */
export function isBunRuntime(
  versions: NodeJS.ProcessVersions | Record<string, string | undefined> = process
    .versions,
): boolean {
  return typeof versions?.bun === "string" && versions.bun.length > 0;
}

export type LaunchMode =
  | "compiled-binary"
  | "global-install"
  | "bunx-ephemeral"
  | "dev-source";

export interface LaunchModeInputs {
  /** Override compiled-standalone detection (tests). */
  compiled?: boolean;
  /** Override `process.argv[1]` (tests). */
  argv1?: string;
  /** Override `process.execPath` (tests). */
  execPath?: string;
}

/** Bun extracts a `bunx` package into its install cache before running it. */
function isBunxCachePath(path: string): boolean {
  return /[/\\]install[/\\]cache[/\\]/.test(path);
}

/** A `bun install -g` package lives under Bun's global install / bin dirs. */
function isGlobalInstallPath(path: string): boolean {
  return (
    /[/\\]install[/\\]global[/\\]/.test(path) ||
    /[/\\]\.bun[/\\]bin[/\\]/.test(path)
  );
}

/**
 * Classify how wos was launched, so `init` knows whether the persistent `wos`
 * the hook hot path needs already exists. Mirrors the compiled-vs-source split
 * `resolveDaemonSpawnCommand()` makes, reusing the same `isCompiledStandalone()`
 * marker, and adds the `bunx`-ephemeral vs persistent-global distinction by
 * inspecting `process.argv[1]`.
 */
export function detectLaunchMode(inputs: LaunchModeInputs = {}): LaunchMode {
  const compiled = inputs.compiled ?? isCompiledStandalone();
  if (compiled) return "compiled-binary";
  const argv1 = inputs.argv1 ?? process.argv[1] ?? "";
  if (isBunxCachePath(argv1)) return "bunx-ephemeral";
  if (isGlobalInstallPath(argv1)) return "global-install";
  return "dev-source";
}

export type PersistentCliOutcome = "installed" | "skipped" | "failed";

export interface EnsurePersistentCliDeps {
  /** Resolved launch mode (defaults to `detectLaunchMode()`). */
  mode?: LaunchMode;
  /** Version to pin the global install to (defaults to the running version). */
  version?: string | null;
  /** Resolve the `wos` command on the login `PATH` (defaults to `Bun.which`). */
  whichWos?: () => string | null;
  /** The running script path, to tell a persistent `wos` from this ephemeral one. */
  runningScript?: string;
  /** Run `bun install -g <spec>`; defaults to a real spawn. */
  install?: (spec: string) => Promise<{ ok: boolean; message?: string }>;
  /** Informational logger (defaults to stderr). */
  log?: (message: string) => void;
}

const ACTIONABLE_INSTALL_HINT =
  `could not establish a persistent wos; run \`bun install -g ${CLI_PACKAGE_NAME}\` ` +
  `so agent hooks resolve in future shells.`;

function defaultInstall(
  spec: string,
): Promise<{ ok: boolean; message?: string }> {
  return (async () => {
    try {
      const proc = Bun.spawn(["bun", "install", "-g", spec], {
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
        windowsHide: true,
      });
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return exitCode === 0
        ? { ok: true }
        : { ok: false, message: stderr.trim() };
    } catch (e) {
      return { ok: false, message: (e as Error).message ?? String(e) };
    }
  })();
}

/**
 * Establish a persistent `wos` when launched ephemerally, so the static
 * `wos agent-hook` command keeps resolving after the `bunx` process exits.
 *
 * No-op unless the mode is `bunx-ephemeral` and `wos` does not already resolve
 * to a persistent command on the login `PATH`. Idempotent: an existing
 * persistent `wos` is left alone. Best-effort: a failed install logs the
 * actionable hint and resolves `failed` rather than throwing — setup continues.
 */
export async function ensurePersistentCli(
  deps: EnsurePersistentCliDeps = {},
): Promise<PersistentCliOutcome> {
  const mode = deps.mode ?? detectLaunchMode();
  if (mode !== "bunx-ephemeral") return "skipped";

  const whichWos = deps.whichWos ?? (() => Bun.which("wos"));
  const runningScript = deps.runningScript ?? process.argv[1] ?? "";
  const resolved = whichWos();
  // Already persistent when `wos` resolves to anything other than the very
  // script we are running ephemerally (the bunx cache copy).
  if (resolved && resolved !== runningScript && !isBunxCachePath(resolved)) {
    return "skipped";
  }

  const version =
    deps.version === undefined ? publishedCliVersion() : deps.version;
  const spec = version ? `${CLI_PACKAGE_NAME}@${version}` : CLI_PACKAGE_NAME;
  const install = deps.install ?? defaultInstall;
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));

  let result: { ok: boolean; message?: string };
  try {
    result = await install(spec);
  } catch (e) {
    result = { ok: false, message: (e as Error).message ?? String(e) };
  }
  if (result.ok) {
    log(`Installed a persistent ${CLI_PACKAGE_NAME} so agent hooks resolve.`);
    return "installed";
  }
  log(`wos: ${ACTIONABLE_INSTALL_HINT}`);
  return "failed";
}
