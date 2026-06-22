/**
 * tmux terminal backend.
 *
 * Creates one tmux session per wos terminal session, persists backend
 * metadata under `<wos-home>/terminal-sessions/`, and attaches each
 * daemon transport through a `tmux attach-session` client PTY. Daemon
 * shutdown detaches the client without killing the tmux session; explicit
 * terminate kills the tmux session and removes the persisted record.
 *
 * Availability is detected via `tmux -V`. If tmux is unavailable, the
 * adapter still loads but every `createSession` fails with a clear
 * `TerminalRuntimeUnavailableError` so the daemon can return a typed
 * `terminal-unavailable` error to clients without crashing on startup.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { wosHome } from "@worktreeos/core/paths";
import type {
  TerminalBackendAdapter,
  TerminalBackendAvailability,
  TerminalBackendCreateOptions,
  TerminalBackendCreateResult,
  TerminalBackendOpenTransportOptions,
  TerminalBackendRestoreResult,
  TerminalBackendSession,
  TerminalBackendTransport,
  TerminalScreenSnapshotResult,
  TerminalTranscriptBinding,
} from "./backend";
import type { TerminalTitleSource } from "./types";
import {
  TerminalRuntimeUnavailableError,
  type TerminalRuntime,
  type TerminalSpawnOptions,
} from "./runtime";
import { loginShellArgs, selectSessionEnv } from "./session-env";

/**
 * `spawnSync` for the multiplexer that never flashes a console window on
 * Windows. The daemon runs detached (no console), so a bare console child like
 * psmux would otherwise pop a window for every command; `windowsHide`
 * (CREATE_NO_WINDOW) suppresses it. No-op on POSIX.
 */
function spawnSync(
  bin: string,
  args: string[],
  opts: Parameters<typeof nodeSpawnSync>[2] = {},
): ReturnType<typeof nodeSpawnSync> {
  return nodeSpawnSync(bin, args, { windowsHide: true, ...opts });
}

/**
 * Async, non-blocking analog of `spawnSync` for the multiplexer. Mission
 * Control captures screen snapshots on a sub-second cadence across many panes;
 * the synchronous `spawnSync` the rest of this backend uses for one-shot
 * lifecycle commands would stall the daemon event loop under that load, so
 * capture MUST use this instead (design Decision 3). Collects stdout/stderr
 * and resolves with the exit status; never rejects.
 */
function spawnAsync(
  bin: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolveResult({ status: 1, stdout: "", stderr: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (e) => {
      resolveResult({ status: 1, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      resolveResult({ status: code, stdout, stderr });
    });
  });
}

const METADATA_DIRNAME = "terminal-sessions";

/**
 * Scrollback retained per pane. tmux defaults to 2000 lines; wos sessions
 * keep the same order of magnitude as the web terminal's scrollback ceiling.
 * `history-limit` only affects panes created after it is set, so it must be
 * configured at `new-session` time for the first pane to inherit it.
 */
const HISTORY_LIMIT = 50000;

/**
 * Dedicated tmux socket name for the wos terminal backend (POSIX only).
 *
 * Running every wos tmux command against `tmux -L worktreeos` isolates wos
 * sessions on their own tmux server: `set-option -g` never touches the user's
 * default tmux, session names can never collide, and — because the wos server
 * is always started by the daemon's own `new-session` — the server's global
 * environment is seeded only with the narrow session allowlist the manager
 * composes (no daemon-private vars, no stale PATH; the pane's login shell
 * rebuilds PATH from dotfiles). psmux on Windows uses named pipes rather than
 * unix sockets, so the socket flag is POSIX-only.
 */
const TMUX_SOCKET_NAME = "worktreeos";

export interface CreateTmuxTerminalBackendOptions {
  /** Underlying PTY runtime used to host tmux attach-client processes. */
  runtime: TerminalRuntime;
  /** Override the wos-home root (tests). */
  wosHome?: string;
  /** Override the environment used to resolve tmux (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override tmux binary lookup (tests). */
  tmuxBinary?: string;
  /**
   * Override the dedicated tmux socket name (POSIX only; tests / verification).
   * Defaults to `TMUX_SOCKET_NAME`. Tests and one-off verification harnesses
   * MUST set this to an isolated name so their destructive cleanup
   * (`kill-server`, `kill-session`) can never touch the production daemon's
   * `worktreeos` server and its live terminal sessions.
   */
  socketName?: string;
  /** Override the host platform (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override the tmux availability probe (tests). */
  probeAvailability?: () => TerminalBackendAvailability;
}

interface PersistedRecord {
  id: string;
  backend: "tmux";
  worktreePath: string;
  cwd: string;
  shell: string;
  tmuxSessionName: string;
  cols: number;
  rows: number;
  createdAt: string;
  /** Display title; absent until the session is renamed. */
  title?: string;
  /** Provenance of `title`; records predating provenance omit it (= user). */
  titleSource?: TerminalTitleSource;
  /** Unread marker (ISO timestamp); absent = read. */
  unreadSince?: string;
  /**
   * Transcript-telemetry binding; absent for sessions without a bound
   * transcript and for records written before this field existed.
   */
  transcript?: TerminalTranscriptBinding;
}

function metadataDir(home: string): string {
  return resolve(home, METADATA_DIRNAME);
}

function metadataPathFor(home: string, id: string): string {
  return resolve(metadataDir(home), `${sanitizeFileName(id)}.json`);
}

function sanitizeFileName(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "_");
}

function defaultWhich(name: string): string | null {
  const bun = (globalThis as { Bun?: { which?: (n: string) => string | null } }).Bun;
  try {
    return bun?.which?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the multiplexer binary for the tmux backend.
 *
 * `TMUX_BINARY` overrides on every platform. Otherwise POSIX probes `tmux`;
 * Windows probes `psmux` (the tmux-command-language-compatible ConPTY
 * multiplexer) first and then its `tmux` alias — the winget/scoop/cargo psmux
 * package installs both. `platform`/`which` are injectable for tests.
 */
export function defaultTmuxBinary(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => string | null = defaultWhich,
): string {
  if (typeof env.TMUX_BINARY === "string" && env.TMUX_BINARY.length > 0) {
    return env.TMUX_BINARY;
  }
  if (platform === "win32") {
    for (const name of ["psmux", "tmux"]) {
      const resolved = which(name);
      if (resolved) return resolved;
    }
    return "psmux";
  }
  return which("tmux") ?? "tmux";
}

function unavailableReason(
  tmuxBin: string,
  isWindows: boolean,
  detail: string,
): string {
  if (isWindows) {
    return (
      `psmux is required for the tmux terminal backend on Windows but could not be run ` +
      `(resolved binary "${tmuxBin}": ${detail}). Install psmux with \`winget install psmux\`, ` +
      `\`scoop install psmux\`, or \`cargo install psmux\`, or set TMUX_BINARY to a ` +
      `tmux-compatible multiplexer.`
    );
  }
  return `tmux is not available: ${detail}`;
}

export function probeTmux(tmuxBin: string, isWindows: boolean): TerminalBackendAvailability {
  try {
    const result = spawnSync(tmuxBin, ["-V"], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (result.error || result.status !== 0) {
      return {
        available: false,
        reason: unavailableReason(
          tmuxBin,
          isWindows,
          result.error?.message ?? `exit ${result.status}`,
        ),
      };
    }
    return { available: true };
  } catch (e) {
    return {
      available: false,
      reason: unavailableReason(tmuxBin, isWindows, (e as Error).message),
    };
  }
}

/**
 * Availability of the tmux backend multiplexer, enriched with the resolved
 * binary and host platform. Returned by the standalone on-demand detection so
 * callers (the UI API availability endpoint) can report what was probed.
 */
export interface TerminalBackendAvailabilityDetail extends TerminalBackendAvailability {
  binary: string;
  platform: NodeJS.Platform;
}

export interface DetectTerminalBackendAvailabilityOptions {
  /** Override the environment used to resolve the binary (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override the host platform (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override the binary lookup (tests). */
  which?: (name: string) => string | null;
  /** Override the version probe (tests). */
  probe?: (tmuxBin: string, isWindows: boolean) => TerminalBackendAvailability;
}

/**
 * Standalone, on-demand multiplexer availability detection.
 *
 * Resolves the multiplexer binary with the same rules as the tmux backend
 * (`defaultTmuxBinary`) and runs the same version probe (`probeTmux`), so a
 * caller can learn whether the tmux backend can run without constructing a
 * backend adapter. Each call probes the host freshly — it does not consult or
 * populate any adapter-instance availability cache. `env`/`platform`/`which`/
 * `probe` are injectable for tests.
 */
export function detectTerminalBackendAvailability(
  opts: DetectTerminalBackendAvailabilityOptions = {},
): TerminalBackendAvailabilityDetail {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? defaultWhich;
  const probe = opts.probe ?? probeTmux;
  const binary = defaultTmuxBinary(env, platform, which);
  const result = probe(binary, platform === "win32");
  return { ...result, binary, platform };
}

function tmuxSessionNameFor(id: string): string {
  return `wos-term-${sanitizeFileName(id)}`;
}

/**
 * Build the `-t` target spec for a session name.
 *
 * POSIX tmux: prefix with `=` so the name matches exactly and can never be
 * treated as a prefix of a longer session name.
 *
 * psmux (Windows) does NOT understand the `=` exact-match prefix. Its
 * `attach-session`/`kill-session` take `=name` literally: attach dies
 * immediately with `can't find session '=name'` (exit 1) — the "terminal
 * starts and instantly dies" symptom — and kill silently no-ops (exit 0)
 * while leaving the session and its server alive, which is what piles up
 * stray psmux processes. `has-session` happens to tolerate the prefix, which
 * is why availability/restore partly worked and masked the bug. Session names
 * are already unique (`wos-term-<sanitized-id>`), so the bare name on Windows
 * is unambiguous. Verified against psmux v3.3.5.
 */
function sessionTarget(name: string, isWindows: boolean): string {
  return isWindows ? name : `=${name}`;
}

function hasTmuxSession(
  tmuxBin: string,
  name: string,
  isWindows: boolean,
  socketArgs: readonly string[],
): boolean {
  const result = spawnSync(
    tmuxBin,
    [...socketArgs, "has-session", "-t", sessionTarget(name, isWindows)],
    { timeout: 1000 },
  );
  return result.status === 0;
}

/**
 * Return the PID of the first pane in a tmux session — the shell process
 * tmux is hosting. Active-command detection walks descendants of this PID
 * to find the user's foreground command (e.g. `claude`), so this is the
 * tmux equivalent of the spawned PTY pid in the default backend.
 *
 * On Windows the spike confirmed psmux's `#{pane_pid}` is a real Windows PID
 * whose process tree is walkable via CIM, so the same descendant-walk drives
 * active-command metadata there. psmux's `#{pane_current_command}` was also
 * confirmed available, but it reports only the foreground *basename* (e.g.
 * `node` for a node-wrapped agent), so the argv-matching CIM walk in
 * `process-detection.ts` is the more reliable signal and is used instead
 * (task 4.4 / Decision 4).
 */
function panePidFor(
  tmuxBin: string,
  sessionName: string,
  isWindows: boolean,
  socketArgs: readonly string[],
): number | undefined {
  const result = spawnSync(
    tmuxBin,
    [...socketArgs, "list-panes", "-t", sessionTarget(sessionName, isWindows), "-F", "#{pane_pid}"],
    { encoding: "utf8", timeout: 1000 },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const line = result.stdout.trim().split("\n")[0];
  if (!line) return undefined;
  const pid = Number.parseInt(line, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Apply session-scoped tmux options the web terminal depends on:
 *
 * - `status off` hides tmux's status bar so the web terminal renders its
 *   own chrome.
 * - `mouse on` enables mouse reporting on the outer terminal so xterm.js
 *   stops translating wheel/touch scroll into arrow keys; tmux scrolls pane
 *   scrollback for non-mouse apps and forwards wheel events to mouse-aware
 *   TUIs.
 *
 * Session-scoped, so it never touches the user's other tmux sessions.
 *
 * NOTE: `set-option` parses `-t` as a target-pane and rejects the `=`
 * exact-match prefix that `has-session`/`kill-session`/`list-panes` accept —
 * passing `=name` fails with "no such session", which is why the earlier
 * fix silently did nothing. Use the bare session name. Best-effort and
 * idempotent: re-applied on every attach (create + reconnect) so even
 * tmux sessions that predate this fix pick the options up, and failures are
 * ignored so they can never block a session.
 */
function applySessionOptions(
  tmuxBin: string,
  sessionName: string,
  socketArgs: readonly string[],
): void {
  spawnSync(tmuxBin, [...socketArgs, "set-option", "-t", sessionName, "status", "off"]);
  spawnSync(tmuxBin, [...socketArgs, "set-option", "-t", sessionName, "mouse", "on"]);
}

export function createTmuxTerminalBackend(
  opts: CreateTmuxTerminalBackendOptions,
): TerminalBackendAdapter {
  const home = opts.wosHome ?? wosHome(opts.env ?? process.env);
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === "win32";
  const tmuxBin = opts.tmuxBinary ?? defaultTmuxBinary(env, platform);
  // Every server-touching command for a given session must carry the SAME
  // socket flag or it would talk to a different server. `-V` (version) is
  // exempt — it never connects to a server.
  //
  // POSIX: one shared dedicated server (`-L worktreeos`) hosts every session;
  // real tmux resolves the `-t` target against that server unambiguously.
  //
  // Windows (psmux): a single server CANNOT be used. psmux does not reliably
  // disambiguate multiple sessions on one server — when `attach-session`'s
  // `-t` target fails to resolve it SILENTLY connects to the most-recently
  // created session instead of erroring (psmux#324), so every freshly created
  // terminal would attach to the previous one ("all terminals show the same
  // session"). We therefore isolate each session in its OWN psmux server
  // namespace keyed by its unique session name (psmux supports `-L` for
  // isolated instances): within that namespace exactly one session exists, so
  // the target can never resolve to a sibling and the bug is structurally
  // impossible regardless of the psmux version. psmux already runs one process
  // per session (psmux#323), so this adds isolation, not overhead, and a
  // terminated session's server exits with its last session — no per-session
  // accumulation. `socketName` overrides only apply to the POSIX shared socket.
  function socketArgsFor(tmuxSessionName: string): readonly string[] {
    return isWindows
      ? ["-L", tmuxSessionName]
      : ["-L", opts.socketName ?? TMUX_SOCKET_NAME];
  }
  const probe = opts.probeAvailability ?? (() => probeTmux(tmuxBin, isWindows));

  let availabilityCache: TerminalBackendAvailability | null = null;
  function availability(): TerminalBackendAvailability {
    if (availabilityCache !== null) return availabilityCache;
    availabilityCache = probe();
    return availabilityCache;
  }

  async function persist(record: PersistedRecord): Promise<void> {
    await mkdir(metadataDir(home), { recursive: true });
    await writeFile(
      metadataPathFor(home, record.id),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
  }

  async function dropMetadata(id: string): Promise<void> {
    try {
      await rm(metadataPathFor(home, id), { force: true });
    } catch {
      /* best-effort */
    }
  }

  async function readRecord(id: string): Promise<PersistedRecord | null> {
    try {
      const text = await readFile(metadataPathFor(home, id), "utf8");
      return JSON.parse(text) as PersistedRecord;
    } catch {
      return null;
    }
  }

  async function attachTransport(
    record: PersistedRecord,
    transportOpts: { cols: number; rows: number },
  ): Promise<TerminalBackendTransport> {
    const runtime = opts.runtime;
    if (!runtime.isAvailable()) {
      throw new TerminalRuntimeUnavailableError(
        `tmux attach client requires PTY runtime ${runtime.name} which is not available`,
      );
    }
    const socketArgs = socketArgsFor(record.tmuxSessionName);
    // Re-assert session options (status bar off, mouse on) right before each
    // attach so both new and reconnected sessions behave consistently.
    applySessionOptions(tmuxBin, record.tmuxSessionName, socketArgs);
    // The attach client only runs `tmux attach-session`; it never needs (and
    // must not carry) the daemon's full env. Restrict it to the session
    // allowlist so no daemon-private var or stale PATH rides into the client.
    const spawn: TerminalSpawnOptions = {
      shell: tmuxBin,
      args: [...socketArgs, "attach-session", "-t", sessionTarget(record.tmuxSessionName, isWindows)],
      cwd: record.cwd,
      env: selectSessionEnv(env),
      cols: transportOpts.cols,
      rows: transportOpts.rows,
    };
    return runtime.spawn(spawn);
  }

  return {
    id: "tmux",
    label: "tmux",
    isAvailable: availability,
    async createSession(
      createOpts: TerminalBackendCreateOptions,
    ): Promise<TerminalBackendCreateResult> {
      const avail = availability();
      if (!avail.available) {
        throw new TerminalRuntimeUnavailableError(
          avail.reason ?? "tmux backend is unavailable on this host",
        );
      }
      const tmuxSessionName = tmuxSessionNameFor(createOpts.id);
      const socketArgs = socketArgsFor(tmuxSessionName);
      const newSessionArgs = [
        "new-session",
        "-d",
        "-s",
        tmuxSessionName,
        "-x",
        String(createOpts.cols),
        "-y",
        String(createOpts.rows),
        "-c",
        createOpts.cwd,
        // Agent bindings (`WOS_DAEMON_URL`, `WOS_TERMINAL_SESSION_ID`,
        // `WOS_AGENT_TOKEN`) are set explicitly with `-e` so they reach the
        // pane regardless of how it inherits its environment. PATH is no longer
        // among them — it is never propagated; the pane's login shell rebuilds
        // it from dotfiles — so the command stays well under tmux's
        // MAX_IMSGSIZE (16 KiB) command-buffer limit.
        ...Object.entries(createOpts.extraEnv ?? {})
          .flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        createOpts.shell,
        // The default interactive shell runs as a login shell (POSIX `-l`) so
        // `.zprofile`/`path_helper` rebuild PATH; an explicit program passes
        // through unchanged. tmux runs an explicit `new-session` command rather
        // than the configured shell, so login mode must be requested here.
        ...loginShellArgs(createOpts, isWindows),
      ];
      // A pane's history limit is fixed at creation, so on POSIX tmux the option
      // is chained as a `-g` pre-set in the same invocation so the first pane
      // inherits it. psmux rejects `set-option -g` before a server exists
      // ("no server running"), so on Windows we create the session first and
      // raise `history-limit` as a session option afterward (spike 4.2).
      const createArgs = isWindows
        ? newSessionArgs
        : [
            "set-option",
            "-g",
            "history-limit",
            String(HISTORY_LIMIT),
            ";",
            ...newSessionArgs,
          ];
      // Create a detached multiplexer session anchored to the worktree's shell.
      // POSIX: spawn the `new-session` client with ONLY the composed session
      // env (the manager's allowlist + agent bindings — no daemon-private vars,
      // no PATH). This is the env that seeds the tmux server's global
      // environment, so a clean env here keeps every future pane clean. Windows
      // (psmux) inherits the daemon env; the allowlist still reaches the pane
      // via `-e`.
      const create = spawnSync(tmuxBin, [...socketArgs, ...createArgs], {
        encoding: "utf8",
        ...(isWindows ? {} : { env: createOpts.env }),
      });
      if (create.status === 0 && isWindows) {
        spawnSync(tmuxBin, [
          ...socketArgs,
          "set-option",
          "-t",
          tmuxSessionName,
          "history-limit",
          String(HISTORY_LIMIT),
        ]);
      }
      if (create.status !== 0) {
        throw new TerminalRuntimeUnavailableError(
          `tmux new-session failed: ${create.stderr || `exit ${create.status}`}`,
        );
      }
      const record: PersistedRecord = {
        id: createOpts.id,
        backend: "tmux",
        worktreePath: createOpts.worktreePath,
        cwd: createOpts.cwd,
        shell: createOpts.shell,
        tmuxSessionName,
        cols: createOpts.cols,
        rows: createOpts.rows,
        createdAt: createOpts.createdAt,
      };
      try {
        await persist(record);
      } catch (e) {
        // Best-effort cleanup of the tmux session if metadata write fails.
        spawnSync(tmuxBin, [...socketArgs, "kill-session", "-t", sessionTarget(tmuxSessionName, isWindows)]);
        throw new TerminalRuntimeUnavailableError(
          `tmux backend could not persist metadata: ${(e as Error).message}`,
        );
      }
      let transport: TerminalBackendTransport;
      try {
        transport = await attachTransport(record, {
          cols: createOpts.cols,
          rows: createOpts.rows,
        });
      } catch (e) {
        spawnSync(tmuxBin, [...socketArgs, "kill-session", "-t", sessionTarget(tmuxSessionName, isWindows)]);
        await dropMetadata(record.id);
        throw e;
      }
      const panePid = panePidFor(tmuxBin, record.tmuxSessionName, isWindows, socketArgs);
      const session: TerminalBackendSession = {
        id: record.id,
        backend: "tmux",
        worktreePath: record.worktreePath,
        cwd: record.cwd,
        shell: record.shell,
        cols: record.cols,
        rows: record.rows,
        createdAt: record.createdAt,
        ...(typeof panePid === "number" ? { processId: panePid } : {}),
        meta: { tmuxSessionName: record.tmuxSessionName },
      };
      return { session, transport };
    },
    async openTransport(
      session: TerminalBackendSession,
      transportOpts: TerminalBackendOpenTransportOptions,
    ): Promise<TerminalBackendTransport> {
      const tmuxSessionName =
        (session.meta?.["tmuxSessionName"] as string | undefined) ?? "";
      if (!tmuxSessionName) {
        throw new TerminalRuntimeUnavailableError(
          `tmux session ${session.id} is missing a tmux session name`,
        );
      }
      const record: PersistedRecord = {
        id: session.id,
        backend: "tmux",
        worktreePath: session.worktreePath,
        cwd: session.cwd,
        shell: session.shell,
        tmuxSessionName,
        cols: transportOpts.cols,
        rows: transportOpts.rows,
        createdAt: session.createdAt,
      };
      return attachTransport(record, transportOpts);
    },
    async restoreSessions(): Promise<TerminalBackendRestoreResult[]> {
      const avail = availability();
      if (!avail.available) return [];
      let entries: string[];
      try {
        entries = await readdir(metadataDir(home));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const out: TerminalBackendRestoreResult[] = [];
      for (const fileName of entries) {
        if (!fileName.endsWith(".json")) continue;
        const filePath = resolve(metadataDir(home), fileName);
        let record: PersistedRecord;
        try {
          const text = await readFile(filePath, "utf8");
          record = JSON.parse(text) as PersistedRecord;
        } catch {
          await rm(filePath, { force: true });
          continue;
        }
        const socketArgs = socketArgsFor(record.tmuxSessionName);
        if (
          record.backend !== "tmux" ||
          !hasTmuxSession(tmuxBin, record.tmuxSessionName, isWindows, socketArgs)
        ) {
          await rm(filePath, { force: true });
          continue;
        }
        const panePid = panePidFor(tmuxBin, record.tmuxSessionName, isWindows, socketArgs);
        const session: TerminalBackendSession = {
          id: record.id,
          backend: "tmux",
          worktreePath: record.worktreePath,
          cwd: record.cwd,
          shell: record.shell,
          cols: record.cols,
          rows: record.rows,
          createdAt: record.createdAt,
          ...(record.title
            ? { title: record.title, titleSource: record.titleSource ?? "user" }
            : {}),
          ...(record.unreadSince ? { unreadSince: record.unreadSince } : {}),
          ...(typeof panePid === "number" ? { processId: panePid } : {}),
          meta: { tmuxSessionName: record.tmuxSessionName },
        };
        out.push({
          session,
          ...(record.transcript ? { transcript: record.transcript } : {}),
        });
      }
      return out;
    },
    async onDaemonShutdown(
      _session: TerminalBackendSession,
      transport: TerminalBackendTransport | null,
    ): Promise<void> {
      if (!transport) return;
      // Detach the daemon's attach-client only — leave the tmux session
      // alive so a new daemon can reattach later.
      try {
        transport.dispose();
      } catch {
        /* swallow */
      }
    },
    async terminateSession(
      session: TerminalBackendSession,
      transport: TerminalBackendTransport | null,
      _signal?: string,
    ): Promise<void> {
      const tmuxSessionName =
        (session.meta?.["tmuxSessionName"] as string | undefined) ?? "";
      // Kill the tmux session *before* touching the transport. The tmux
      // server going away causes the attach-client to exit through its
      // normal exit path, which lets the actor's exit listener observe
      // the transition and move the session to `exited`. Disposing the
      // transport up front would clear that listener and leave the actor
      // wedged in `terminating`.
      if (tmuxSessionName) {
        const socketArgs = socketArgsFor(tmuxSessionName);
        spawnSync(tmuxBin, [...socketArgs, "kill-session", "-t", sessionTarget(tmuxSessionName, isWindows)]);
      }
      await dropMetadata(session.id);
      // Transport handle is intentionally left to expire on its own.
      void transport;
    },
    async persistTitle(
      session: TerminalBackendSession,
      title: string | undefined,
      titleSource?: TerminalTitleSource,
    ): Promise<void> {
      // Prefer the persisted record so we keep the exact tmuxSessionName /
      // createdAt; fall back to reconstructing from the live session when the
      // record is somehow missing.
      const existing = await readRecord(session.id);
      const tmuxSessionName =
        existing?.tmuxSessionName ??
        (session.meta?.["tmuxSessionName"] as string | undefined) ??
        "";
      if (!tmuxSessionName) {
        throw new TerminalRuntimeUnavailableError(
          `tmux session ${session.id} is missing a tmux session name`,
        );
      }
      const record: PersistedRecord = existing ?? {
        id: session.id,
        backend: "tmux",
        worktreePath: session.worktreePath,
        cwd: session.cwd,
        shell: session.shell,
        tmuxSessionName,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt,
      };
      if (title === undefined) {
        delete record.title;
        delete record.titleSource;
      } else {
        record.title = title;
        record.titleSource = titleSource ?? "user";
      }
      // Re-persist atomically through the same write path; a failure here
      // propagates so the actor keeps the previous in-memory title.
      await persist(record);
    },
    async persistUnread(
      session: TerminalBackendSession,
      unreadSince: string | undefined,
    ): Promise<void> {
      // Prefer the persisted record so we keep the exact tmuxSessionName /
      // createdAt / title; fall back to reconstructing from the live session.
      const existing = await readRecord(session.id);
      const tmuxSessionName =
        existing?.tmuxSessionName ??
        (session.meta?.["tmuxSessionName"] as string | undefined) ??
        "";
      if (!tmuxSessionName) {
        throw new TerminalRuntimeUnavailableError(
          `tmux session ${session.id} is missing a tmux session name`,
        );
      }
      const record: PersistedRecord = existing ?? {
        id: session.id,
        backend: "tmux",
        worktreePath: session.worktreePath,
        cwd: session.cwd,
        shell: session.shell,
        tmuxSessionName,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt,
      };
      if (unreadSince === undefined) {
        delete record.unreadSince;
      } else {
        record.unreadSince = unreadSince;
      }
      await persist(record);
    },
    async persistTranscriptBinding(
      session: TerminalBackendSession,
      binding: TerminalTranscriptBinding | undefined,
    ): Promise<void> {
      // Prefer the persisted record so we keep the exact tmuxSessionName /
      // createdAt / title / unread; fall back to reconstructing from the live
      // session. Best-effort: the caller logs and keeps in-memory telemetry.
      const existing = await readRecord(session.id);
      const tmuxSessionName =
        existing?.tmuxSessionName ??
        (session.meta?.["tmuxSessionName"] as string | undefined) ??
        "";
      if (!tmuxSessionName) {
        throw new TerminalRuntimeUnavailableError(
          `tmux session ${session.id} is missing a tmux session name`,
        );
      }
      const record: PersistedRecord = existing ?? {
        id: session.id,
        backend: "tmux",
        worktreePath: session.worktreePath,
        cwd: session.cwd,
        shell: session.shell,
        tmuxSessionName,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt,
      };
      if (binding === undefined) {
        delete record.transcript;
      } else {
        record.transcript = binding;
      }
      await persist(record);
    },
    refreshScreenState(session: TerminalBackendSession): void {
      const tmuxSessionName =
        (session.meta?.["tmuxSessionName"] as string | undefined) ?? "";
      if (!tmuxSessionName) return;
      const socketArgs = socketArgsFor(tmuxSessionName);
      // Best-effort full redraw so a client that missed bytes (replay gap)
      // re-receives the screen contents.
      try {
        if (isWindows) {
          // psmux ignores `-F` on `list-clients` and rejects
          // `refresh-client -t <tty>` (Windows has no client ttys — it reports
          // a synthetic `/dev/pts/0`). An untargeted `refresh-client` triggers
          // a full redraw for the attached client, which is all we need here
          // (spike 1.1). Mode state is restored by the actor's replay prefix.
          spawnSync(tmuxBin, [...socketArgs, "refresh-client"]);
          return;
        }
        // POSIX: `refresh-client -t` takes a target *client*, not a session —
        // resolve the session's attached client ttys first and refresh each.
        const list = spawnSync(tmuxBin, [
          ...socketArgs,
          "list-clients",
          "-t",
          tmuxSessionName,
          "-F",
          "#{client_tty}",
        ]);
        const ttys = (list.stdout?.toString() ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        for (const tty of ttys) {
          spawnSync(tmuxBin, [...socketArgs, "refresh-client", "-t", tty]);
        }
      } catch {
        /* swallow */
      }
    },
    async captureScreenSnapshot(
      session: TerminalBackendSession,
    ): Promise<TerminalScreenSnapshotResult> {
      const avail = availability();
      if (!avail.available) {
        return { available: false, reason: avail.reason };
      }
      const tmuxSessionName =
        (session.meta?.["tmuxSessionName"] as string | undefined) ?? "";
      if (!tmuxSessionName) {
        return {
          available: false,
          reason: `tmux session ${session.id} is missing a tmux session name`,
        };
      }
      // `capture-pane` / `display-message` take a target-*pane*; passing the
      // (unique) session name selects that session's active pane. Unlike the
      // target-*session* commands (`has-session` / `kill-session` /
      // `list-panes`), the `=` exact-match prefix is NOT valid for pane targets
      // and makes tmux fail to resolve the pane — so use the bare name here.
      const target = tmuxSessionName;
      const socketArgs = socketArgsFor(tmuxSessionName);
      // `capture-pane -p -e` prints the current visible screen to stdout with
      // SGR color/attribute escapes only — tmux's own emulator has already
      // resolved cursor-addressing and the alternate-screen buffer of any
      // full-screen TUI into flat lines, so the result is directly renderable.
      //
      // Geometry comes from the same invocation: on POSIX `display-message`
      // is chained ahead of the capture with tmux's `;` command separator so
      // the pane's true width/height lands on the first stdout line in ONE
      // async spawn. psmux (Windows) does not chain via `;` (see the create
      // path), so there we capture content only and report the session's
      // last-known geometry.
      //
      // This is a one-shot, non-attaching command client: it imposes no client
      // size on the session, so it can never SIGWINCH / resize the live
      // interactive viewer (the hard constraint in design Risks). A persistent
      // control-mode client WOULD attach with its own size and risk shrinking
      // the real pane, so capture deliberately uses the async-spawn path
      // (task 1.3's stated fallback) rather than control-mode reuse.
      const args = isWindows
        ? [...socketArgs, "capture-pane", "-p", "-e", "-t", target]
        : [
            ...socketArgs,
            "display-message",
            "-p",
            "-t",
            target,
            "#{pane_width},#{pane_height}",
            ";",
            "capture-pane",
            "-p",
            "-e",
            "-t",
            target,
          ];
      const result = await spawnAsync(tmuxBin, args);
      if (result.status !== 0) {
        return {
          available: false,
          reason: result.stderr.trim() || `capture-pane exit ${result.status}`,
        };
      }
      // Drop only a single trailing newline so a genuinely blank bottom row is
      // preserved (split on the remainder keeps interior blanks intact).
      const raw = result.stdout.replace(/\n$/, "");
      let cols = session.cols;
      let rows = session.rows;
      let body = raw;
      if (!isWindows) {
        const firstBreak = raw.indexOf("\n");
        const head = firstBreak === -1 ? raw : raw.slice(0, firstBreak);
        const geometry = parseGeometryLine(head);
        if (geometry) {
          cols = geometry.cols;
          rows = geometry.rows;
          body = firstBreak === -1 ? "" : raw.slice(firstBreak + 1);
        }
      }
      const lines = body.length === 0 ? [] : body.split("\n");
      return { available: true, snapshot: { lines, cols, rows } };
    },
  };
}

/** Parse a `<width>,<height>` line from `display-message`; null when malformed. */
function parseGeometryLine(
  line: string,
): { cols: number; rows: number } | null {
  const match = /^(\d+),(\d+)$/.exec(line.trim());
  if (!match) return null;
  const cols = Number.parseInt(match[1]!, 10);
  const rows = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return null;
  }
  return { cols, rows };
}
