import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createTmuxTerminalBackend,
  defaultTmuxBinary,
  detectTerminalBackendAvailability,
} from "@worktreeos/daemon/terminal-layer/tmux-backend";
import { TerminalRuntimeUnavailableError } from "@worktreeos/daemon/terminal-layer/runtime";
import { createFakeTerminalRuntime } from "@worktreeos/daemon/terminal-layer/testing";

const IS_WIN = process.platform === "win32";
const posixOnly = IS_WIN ? test.skip : test;
const winOnly = IS_WIN ? test : test.skip;

// POSIX runs every wos tmux command against a dedicated socket; Windows (psmux)
// uses the default named-pipe server with no socket flag. Tests that shell tmux
// directly, or assert command shape, must mirror that prefix.
const SOCK = ["-L", "worktreeos"] as const;
const posixSock = IS_WIN ? [] : [...SOCK];

let home: string;
// Cross-platform stand-ins for the POSIX `true`/`false` always-exit fakes used
// as a `tmuxBinary` override: native Windows has no `true`/`false` binaries.
let okBin: string;
let failBin: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wos-tmux-backend-"));
  if (IS_WIN) {
    okBin = join(home, "ok.cmd");
    failBin = join(home, "fail.cmd");
    await writeFile(okBin, "@echo off\r\nexit /b 0\r\n", "utf8");
    await writeFile(failBin, "@echo off\r\nexit /b 1\r\n", "utf8");
  } else {
    okBin = "true";
    failBin = "false";
  }
});
afterEach(async () => {
  // On Windows a lingering psmux server / attach-client can briefly hold the
  // home dir (it is a process cwd / open metadata handle), so a single `rm`
  // races with EBUSY/ENOTEMPTY. Retry with a short backoff before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM")) {
        if (IS_WIN) return; // best-effort on Windows: never fail teardown on a held temp dir
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

const tmuxAvailableOnHost = (() => {
  try {
    // 3s, not 1s: psmux's first invocation can be slow to spin up its server,
    // which otherwise flakes the probe with ETIMEDOUT under parallel load.
    const r = spawnSync("tmux", ["-V"], { timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

// The live integration block is POSIX-only. It hardcodes a `/bin/sh` pane and
// shells the literal `tmux` binary with POSIX-tmux query semantics
// (`show-options -v`, `=` exact-match targets). On Windows `tmux` resolves to
// the psmux alias, whose CLI diverges and whose pane immediately self-destructs
// when handed a `/bin/sh` that does not exist — so these would run by accident
// (the `tmux -V` gate passes) and fail/flake against psmux. Real psmux coverage
// lives in the platform-injected unit tests above plus `scripts/repro-psmux.ts`.
const runLiveTmux = !IS_WIN && tmuxAvailableOnHost;

describe("createTmuxTerminalBackend — availability", () => {
  test("reports unavailable when the tmux probe fails", () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({
        available: false,
        reason: "tmux missing on this host",
      }),
    });
    const avail = backend.isAvailable();
    expect(avail.available).toBe(false);
    expect(avail.reason).toContain("tmux missing");
  });

  test("createSession throws TerminalRuntimeUnavailableError when probe fails", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({
        available: false,
        reason: "tmux missing",
      }),
    });
    await expect(
      backend.createSession({
        id: "t1",
        worktreePath: home,
        cwd: home,
        shell: "/bin/zsh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(TerminalRuntimeUnavailableError);
  });

  test("restoreSessions returns empty when the backend is unavailable", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: false, reason: "no tmux" }),
    });
    const restored = await backend.restoreSessions!();
    expect(restored).toEqual([]);
  });

  test("backend identity and label", () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
    });
    expect(backend.id).toBe("tmux");
    expect(backend.label).toBe("tmux");
  });
});

describe("createTmuxTerminalBackend — restore metadata cleanup", () => {
  test("ignores malformed metadata files and removes them", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: failBin, // every spawnSync invocation will return non-zero
    });
    await mkdir(join(home, "terminal-sessions"), { recursive: true });
    await writeFile(
      join(home, "terminal-sessions", "bad.json"),
      "{not-json",
      "utf8",
    );
    const restored = await backend.restoreSessions!();
    expect(restored).toEqual([]);
    const remaining = await readdir(join(home, "terminal-sessions"));
    expect(remaining).not.toContain("bad.json");
  });

  test("drops records whose tmux session no longer exists", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: failBin,
    });
    await mkdir(join(home, "terminal-sessions"), { recursive: true });
    const record = {
      id: "term_stale",
      backend: "tmux",
      worktreePath: home,
      cwd: home,
      shell: "/bin/zsh",
      tmuxSessionName: "wos-term-term_stale",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      join(home, "terminal-sessions", "stale.json"),
      JSON.stringify(record),
      "utf8",
    );
    const restored = await backend.restoreSessions!();
    expect(restored).toEqual([]);
    const remaining = await readdir(join(home, "terminal-sessions"));
    expect(remaining).not.toContain("stale.json");
  });
});

describe("createTmuxTerminalBackend — title persistence", () => {
  async function writeRecord(
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await mkdir(join(home, "terminal-sessions"), { recursive: true });
    await writeFile(
      join(home, "terminal-sessions", `${id}.json`),
      JSON.stringify({
        id,
        backend: "tmux",
        worktreePath: home,
        cwd: home,
        shell: "/bin/zsh",
        tmuxSessionName: `wos-term-${id}`,
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        ...extra,
      }),
      "utf8",
    );
  }

  async function readRecord(id: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(join(home, "terminal-sessions", `${id}.json`), "utf8"),
    );
  }

  function session(id: string) {
    return {
      id,
      backend: "tmux" as const,
      worktreePath: home,
      cwd: home,
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
      meta: { tmuxSessionName: `wos-term-${id}` },
    };
  }

  test("persistTitle writes a title into the metadata record", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
    });
    await writeRecord("term_named");
    await backend.persistTitle!(session("term_named"), "api logs");
    const record = await readRecord("term_named");
    expect(record.title).toBe("api logs");
    // No explicit source defaults to user.
    expect(record.titleSource).toBe("user");
    await backend.persistTitle!(session("term_named"), "Fix login bug", "agent");
    expect((await readRecord("term_named")).titleSource).toBe("agent");
  });

  test("persistTitle removes the title when cleared", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
    });
    await writeRecord("term_clear", { title: "old name", titleSource: "agent" });
    await backend.persistTitle!(session("term_clear"), undefined);
    const record = await readRecord("term_clear");
    expect("title" in record).toBe(false);
    expect("titleSource" in record).toBe(false);
  });

  test("persistTitle throws when no tmux session name can be resolved", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
    });
    // No persisted record and a session without meta → no tmuxSessionName.
    await expect(
      backend.persistTitle!(
        {
          id: "term_orphan",
          backend: "tmux",
          worktreePath: home,
          cwd: home,
          shell: "/bin/zsh",
          cols: 80,
          rows: 24,
          createdAt: new Date().toISOString(),
        },
        "x",
      ),
    ).rejects.toBeInstanceOf(TerminalRuntimeUnavailableError);
  });

  test("restore includes a persisted title", async () => {
    const r = createFakeTerminalRuntime();
    // `true` exits 0, so hasTmuxSession() reports the session still exists.
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: okBin,
    });
    await writeRecord("term_restore_title", { title: "migrations" });
    await writeRecord("term_restore_agent_title", {
      title: "Fix login bug",
      titleSource: "agent",
    });
    const restored = await backend.restoreSessions!();
    const match = restored.find((s) => s.session.id === "term_restore_title");
    expect(match).toBeDefined();
    expect(match!.session.title).toBe("migrations");
    // Legacy record without provenance restores as user-sourced.
    expect(match!.session.titleSource).toBe("user");
    const agentMatch = restored.find(
      (s) => s.session.id === "term_restore_agent_title",
    );
    expect(agentMatch!.session.titleSource).toBe("agent");
  });

  test("persistUnread writes and clears the unread marker", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
    });
    await writeRecord("term_unread", { title: "api logs" });
    await backend.persistUnread!(session("term_unread"), "2026-06-11T10:00:00.000Z");
    let record = await readRecord("term_unread");
    expect(record.unreadSince).toBe("2026-06-11T10:00:00.000Z");
    // Title and other fields survive the write-back.
    expect(record.title).toBe("api logs");
    await backend.persistUnread!(session("term_unread"), undefined);
    record = await readRecord("term_unread");
    expect("unreadSince" in record).toBe(false);
    expect(record.title).toBe("api logs");
  });

  test("restore includes a persisted unread marker; cleared marker stays cleared", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: okBin,
    });
    await writeRecord("term_restore_unread", {
      unreadSince: "2026-06-11T10:00:00.000Z",
    });
    await writeRecord("term_restore_read");
    const restored = await backend.restoreSessions!();
    const unread = restored.find((s) => s.session.id === "term_restore_unread");
    expect(unread!.session.unreadSince).toBe("2026-06-11T10:00:00.000Z");
    const read = restored.find((s) => s.session.id === "term_restore_read");
    expect(read!.session.unreadSince).toBeUndefined();
  });
});

describe("createTmuxTerminalBackend — transcript binding persistence", () => {
  async function writeRecord(
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await mkdir(join(home, "terminal-sessions"), { recursive: true });
    await writeFile(
      join(home, "terminal-sessions", `${id}.json`),
      JSON.stringify({
        id,
        backend: "tmux",
        worktreePath: home,
        cwd: home,
        shell: "/bin/zsh",
        tmuxSessionName: `wos-term-${id}`,
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        ...extra,
      }),
      "utf8",
    );
  }

  async function readRecord(id: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(join(home, "terminal-sessions", `${id}.json`), "utf8"),
    );
  }

  function session(id: string) {
    return {
      id,
      backend: "tmux" as const,
      worktreePath: home,
      cwd: home,
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
      meta: { tmuxSessionName: `wos-term-${id}` },
    };
  }

  const binding = {
    path: "/transcripts/sess-x.jsonl",
    agentSessionId: "sess-x",
    mainCarry: 40,
    subagentCarry: 7,
  };

  test("persistTranscriptBinding writes and clears the binding", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
    });
    await writeRecord("term_tx", { title: "api logs" });
    await backend.persistTranscriptBinding!(session("term_tx"), binding);
    let record = await readRecord("term_tx");
    expect(record.transcript).toEqual(binding);
    // Co-located fields survive the write-back.
    expect(record.title).toBe("api logs");
    await backend.persistTranscriptBinding!(session("term_tx"), undefined);
    record = await readRecord("term_tx");
    expect("transcript" in record).toBe(false);
    expect(record.title).toBe("api logs");
  });

  test("restore surfaces the persisted binding; a record without it is tolerated", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: okBin,
    });
    await writeRecord("term_tx_bound", { transcript: binding });
    await writeRecord("term_tx_plain");
    const restored = await backend.restoreSessions!();
    const bound = restored.find((s) => s.session.id === "term_tx_bound");
    expect(bound!.transcript).toEqual(binding);
    const plain = restored.find((s) => s.session.id === "term_tx_plain");
    expect(plain!.transcript).toBeUndefined();
  });
});

describe("createTmuxTerminalBackend — refreshScreenState", () => {
  posixOnly("refreshes each attached client tty resolved via list-clients", async () => {
    const r = createFakeTerminalRuntime();
    const log = join(home, "tmux-calls.log");
    const fakeTmux = join(home, "fake-tmux.sh");
    // `list-clients` is no longer $1 — the dedicated-socket flag (`-L worktreeos`)
    // precedes it — so match the subcommand anywhere in the arg list.
    await writeFile(
      fakeTmux,
      `#!/bin/sh\necho "$@" >> "${log}"\ncase " $* " in *" list-clients "*) printf '/dev/ttys001\\n/dev/ttys002\\n';; esac\n`,
      { mode: 0o755 },
    );
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      platform: "linux",
      probeAvailability: () => ({ available: true }),
      tmuxBinary: fakeTmux,
    });
    backend.refreshScreenState!({
      id: "term_refresh_fanout",
      backend: "tmux",
      worktreePath: home,
      cwd: home,
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
      meta: { tmuxSessionName: "wos-term-term_refresh_fanout" },
    });
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      "-L worktreeos list-clients -t wos-term-term_refresh_fanout -F #{client_tty}",
      "-L worktreeos refresh-client -t /dev/ttys001",
      "-L worktreeos refresh-client -t /dev/ttys002",
    ]);
  });

  test("stays silent when no clients are attached or meta is missing", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: okBin, // list-clients yields no output → no refresh calls
    });
    const base = {
      id: "term_refresh_quiet",
      backend: "tmux" as const,
      worktreePath: home,
      cwd: home,
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    };
    backend.refreshScreenState!({
      ...base,
      meta: { tmuxSessionName: "wos-term-term_refresh_quiet" },
    });
    backend.refreshScreenState!({ ...base, meta: {} });
  });

  winOnly(
    "Windows issues a single untargeted refresh-client (psmux conditional)",
    async () => {
      const r = createFakeTerminalRuntime();
      const log = join(home, "psmux-calls.log");
      const fake = join(home, "fake-psmux.cmd");
      // A .cmd fake records every invocation's args so we can assert the call
      // shape psmux receives. `>>` appends; `%*` is the full arg list.
      await writeFile(fake, `@echo off\r\necho %*>>"${log}"\r\n`, "utf8");
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        platform: "win32",
        probeAvailability: () => ({ available: true }),
        tmuxBinary: fake,
      });
      backend.refreshScreenState!({
        id: "term_win_refresh",
        backend: "tmux",
        worktreePath: home,
        cwd: home,
        shell: "powershell.exe",
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        meta: { tmuxSessionName: "wos-term-term_win_refresh" },
      });
      const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/);
      // No list-clients, no per-tty refresh: exactly one untargeted refresh,
      // scoped to this session's own `-L <name>` psmux server namespace.
      expect(calls).toEqual(["-L wos-term-term_win_refresh refresh-client"]);
    },
  );
});

describe("defaultTmuxBinary resolution", () => {
  test("TMUX_BINARY overrides on every platform", () => {
    expect(
      defaultTmuxBinary({ TMUX_BINARY: "/opt/mux" }, "linux", () => null),
    ).toBe("/opt/mux");
    expect(
      defaultTmuxBinary({ TMUX_BINARY: "C:\\mux.exe" }, "win32", () => "C:\\psmux.exe"),
    ).toBe("C:\\mux.exe");
  });

  test("POSIX probes tmux then falls back to the literal", () => {
    expect(defaultTmuxBinary({}, "linux", (n) => (n === "tmux" ? "/usr/bin/tmux" : null))).toBe(
      "/usr/bin/tmux",
    );
    expect(defaultTmuxBinary({}, "darwin", () => null)).toBe("tmux");
  });

  test("Windows probes psmux first, then the tmux alias, then the literal", () => {
    expect(
      defaultTmuxBinary({}, "win32", (n) => (n === "psmux" ? "C:\\psmux.exe" : null)),
    ).toBe("C:\\psmux.exe");
    expect(
      defaultTmuxBinary({}, "win32", (n) => (n === "tmux" ? "C:\\tmux.exe" : null)),
    ).toBe("C:\\tmux.exe");
    expect(defaultTmuxBinary({}, "win32", () => null)).toBe("psmux");
  });
});

describe("detectTerminalBackendAvailability", () => {
  test("resolves the binary and reports available", () => {
    const result = detectTerminalBackendAvailability({
      env: {},
      platform: "linux",
      which: (n) => (n === "tmux" ? "/usr/bin/tmux" : null),
      probe: () => ({ available: true }),
    });
    expect(result).toEqual({
      available: true,
      binary: "/usr/bin/tmux",
      platform: "linux",
    });
  });

  test("reports unavailable with the probe reason and resolved binary", () => {
    const result = detectTerminalBackendAvailability({
      env: {},
      platform: "linux",
      which: () => null,
      probe: () => ({ available: false, reason: "tmux is not available: exit 1" }),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("tmux is not available: exit 1");
    expect(result.binary).toBe("tmux");
    expect(result.platform).toBe("linux");
  });

  test("Windows resolves psmux and names it in the unavailable reason", () => {
    const result = detectTerminalBackendAvailability({
      env: {},
      platform: "win32",
      which: () => null,
    });
    expect(result.binary).toBe("psmux");
    expect(result.platform).toBe("win32");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("psmux");
  });

  test("probes fresh on each call rather than caching", () => {
    let available = false;
    const probe = () => ({ available });
    const first = detectTerminalBackendAvailability({
      env: {},
      platform: "linux",
      which: () => "/usr/bin/tmux",
      probe,
    });
    expect(first.available).toBe(false);
    available = true;
    const second = detectTerminalBackendAvailability({
      env: {},
      platform: "linux",
      which: () => "/usr/bin/tmux",
      probe,
    });
    expect(second.available).toBe(true);
  });
});

describe("createTmuxTerminalBackend — Windows unavailable diagnostic", () => {
  test("names psmux and its install channels when no multiplexer resolves", () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      platform: "win32",
      // A binary that cannot run forces the real probe down the failure path.
      tmuxBinary: join(home, "definitely-not-a-real-multiplexer.exe"),
    });
    const avail = backend.isAvailable();
    expect(avail.available).toBe(false);
    expect(avail.reason).toContain("psmux");
    expect(avail.reason).toContain("winget install psmux");
    expect(avail.reason).toContain("TMUX_BINARY");
  });
});

describe("createTmuxTerminalBackend — session target syntax (psmux `=` incompatibility)", () => {
  // Regression: psmux's attach-session/kill-session do NOT understand the `=`
  // exact-match prefix that POSIX tmux uses. Attaching with `-t =name` makes
  // psmux die immediately ("can't find session '=name'") — the "terminal
  // starts and instantly dies" bug — and kill-session with `=name` silently
  // no-ops, leaking the session/server and piling up psmux processes. Windows
  // must therefore target the bare session name; POSIX keeps `=`.

  test("Windows attaches with the bare session name (no `=` prefix)", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      platform: "win32",
      probeAvailability: () => ({ available: true }),
      tmuxBinary: okBin, // new-session / set-option / list-panes all exit 0
    });
    const created = await backend.createSession({
      id: "term_win_attach",
      worktreePath: home,
      cwd: home,
      shell: "cmd.exe",
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    expect(created.session.backend).toBe("tmux");
    // The attach client is spawned through the runtime — assert its args.
    // Windows isolates each session in its own `-L <name>` psmux server
    // namespace (psmux#324 silent-fallback-to-most-recent guard); the target
    // is still the bare name (no `=`).
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]!.spawn.args).toEqual([
      "-L",
      "wos-term-term_win_attach",
      "attach-session",
      "-t",
      "wos-term-term_win_attach",
    ]);
  });

  test("POSIX attaches with the `=` exact-match target", async () => {
    const r = createFakeTerminalRuntime();
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      platform: "linux",
      probeAvailability: () => ({ available: true }),
      tmuxBinary: okBin,
    });
    const created = await backend.createSession({
      id: "term_posix_attach",
      worktreePath: home,
      cwd: home,
      shell: "/bin/sh",
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    expect(r.spawned[0]!.spawn.args).toEqual([
      ...SOCK,
      "attach-session",
      "-t",
      "=wos-term-term_posix_attach",
    ]);
  });

  // kill-session/has-session go through spawnSync (not the runtime), so assert
  // their target via a logging fake binary. The binary must be runnable on the
  // host, so this test exercises whichever platform matches the host.
  const platform: NodeJS.Platform = IS_WIN ? "win32" : "linux";
  const expectedTarget = IS_WIN
    ? "wos-term-term_kill" // bare on Windows (psmux)
    : "=wos-term-term_kill"; // `=` on POSIX

  test(`kill-session and has-session target ${expectedTarget} on ${platform}`, async () => {
    const r = createFakeTerminalRuntime();
    const log = join(home, "mux-calls.log");
    const logger = IS_WIN ? join(home, "logger.cmd") : join(home, "logger.sh");
    if (IS_WIN) {
      // `echo %*` appends the full space-joined arg list; the shim exits 0.
      await writeFile(logger, `@echo off\r\necho %*>>"${log}"\r\n`, "utf8");
    } else {
      await writeFile(logger, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, {
        mode: 0o755,
      });
    }
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      platform,
      probeAvailability: () => ({ available: true }),
      tmuxBinary: logger,
    });

    // terminateSession → kill-session with the platform-correct target.
    await backend.terminateSession(
      {
        id: "term_kill",
        backend: "tmux",
        worktreePath: home,
        cwd: home,
        shell: IS_WIN ? "cmd.exe" : "/bin/sh",
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        meta: { tmuxSessionName: "wos-term-term_kill" },
      },
      null,
    );

    // restoreSessions → has-session with the platform-correct target.
    await mkdir(join(home, "terminal-sessions"), { recursive: true });
    await writeFile(
      join(home, "terminal-sessions", "term_kill.json"),
      JSON.stringify({
        id: "term_kill",
        backend: "tmux",
        worktreePath: home,
        cwd: home,
        shell: IS_WIN ? "cmd.exe" : "/bin/sh",
        tmuxSessionName: "wos-term-term_kill",
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await backend.restoreSessions!();

    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/).map((l) => l.trim());
    const killLine = calls.find((l) => l.includes("kill-session"));
    const hasLine = calls.find((l) => l.includes("has-session"));
    // POSIX uses one shared dedicated socket; Windows (psmux) isolates each
    // session in its own `-L <name>` server namespace (psmux#324 guard).
    const sockPrefix = IS_WIN ? "-L wos-term-term_kill " : "-L worktreeos ";
    expect(killLine).toBe(`${sockPrefix}kill-session -t ${expectedTarget}`);
    expect(hasLine).toBe(`${sockPrefix}has-session -t ${expectedTarget}`);
    if (IS_WIN) {
      // Hard guard: the `=` form must never reach psmux on Windows.
      expect(killLine).not.toContain("=wos-term");
      expect(hasLine).not.toContain("=wos-term");
    }
  });

  // Regression: tests and verification harnesses MUST be able to redirect the
  // dedicated socket away from production `worktreeos` so their destructive
  // cleanup can never kill the live daemon's terminal sessions. The override
  // applies to the POSIX shared socket only; Windows (psmux) derives the `-L`
  // namespace from each session's unique name and ignores `socketName`.
  posixOnly("socketName override redirects the dedicated socket flag", async () => {
    const r = createFakeTerminalRuntime();
    const log = join(home, "mux-calls.log");
    const logger = join(home, "logger.sh");
    await writeFile(logger, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, {
      mode: 0o755,
    });
    const backend = createTmuxTerminalBackend({
      runtime: r.runtime,
      wosHome: home,
      platform: "linux",
      probeAvailability: () => ({ available: true }),
      tmuxBinary: logger,
      socketName: "worktreeos-test",
    });
    await backend.terminateSession(
      {
        id: "term_sock",
        backend: "tmux",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        meta: { tmuxSessionName: "wos-term-term_sock" },
      },
      null,
    );
    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/).map((l) => l.trim());
    const killLine = calls.find((l) => l.includes("kill-session"));
    expect(killLine).toBe("-L worktreeos-test kill-session -t =wos-term-term_sock");
    // The production socket must never appear under an override.
    expect(killLine).not.toContain("-L worktreeos ");
  });
});

describe("createTmuxTerminalBackend — session env + login shell", () => {
  // The `new-session` client env seeds the tmux server's global environment,
  // which every pane inherits, so it must be ONLY the manager-composed env
  // (session allowlist + agent bindings): no daemon-private vars, no PATH. The
  // pane shell runs as a login shell so `.zprofile`/`path_helper` rebuild PATH.
  posixOnly(
    "login shell, agent vars via -e, no PATH, and a clean new-session client env",
    async () => {
      const r = createFakeTerminalRuntime();
      const argLog = join(home, "args.log");
      const envLog = join(home, "env.log");
      const fakeTmux = join(home, "fake-tmux.sh");
      // Log every invocation's args, plus the sentinel/PATH/HOME the client was
      // spawned with, then exit 0 so create/attach/pane-pid all "succeed".
      await writeFile(
        fakeTmux,
        `#!/bin/sh\necho "$@" >> "${argLog}"\nprintf 'SENTINEL=[%s] PATH=[%s] HOME=[%s]\\n' "$WOS_LEAK_SENTINEL" "$PATH" "$HOME" >> "${envLog}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        platform: "linux",
        probeAvailability: () => ({ available: true }),
        tmuxBinary: fakeTmux,
        // Base env the attach client filters through the allowlist.
        env: {
          HOME: "/home/u",
          TERM: "xterm-256color",
          PATH: "/usr/bin",
          WOS_HOME: "/leak",
        },
      });
      // A daemon-private sentinel in the real process env must never reach the
      // new-session client (which would seed it into the tmux server global env).
      process.env.WOS_LEAK_SENTINEL = "leak";
      try {
        await backend.createSession({
          id: "term_env",
          worktreePath: home,
          cwd: home,
          shell: "/bin/zsh",
          // The manager-composed allowlist env for the default shell.
          env: { HOME: "/home/u", TERM: "xterm-256color" },
          extraEnv: {
            WOS_TERMINAL_SESSION_ID: "sess-1",
            WOS_AGENT_TOKEN: "tok",
            WOS_DAEMON_URL: "http://127.0.0.1:4317",
          },
          login: true,
          cols: 80,
          rows: 24,
          createdAt: new Date().toISOString(),
        });
      } finally {
        delete process.env.WOS_LEAK_SENTINEL;
      }

      // The new-session invocation is the first logged call.
      const newSessionCall = (await readFile(argLog, "utf8")).split("\n")[0]!;
      // Agent bindings travel as -e.
      expect(newSessionCall).toContain("-e WOS_TERMINAL_SESSION_ID=sess-1");
      expect(newSessionCall).toContain("-e WOS_AGENT_TOKEN=tok");
      expect(newSessionCall).toContain("-e WOS_DAEMON_URL=http://127.0.0.1:4317");
      // PATH is never delivered: not via -e, not propagated.
      expect(newSessionCall).not.toContain("PATH=");
      // The pane shell is invoked as a login shell.
      expect(newSessionCall).toContain("/bin/zsh -l");

      // The new-session client env is ONLY the composed env — no process.env
      // spread — so the daemon's private sentinel never seeds the tmux server
      // global env, and HOME is exactly the value the manager composed. (PATH
      // is not asserted: with no PATH in the composed env the OS hands the
      // child a libc default exec PATH, which the pane's login shell discards
      // and rebuilds; the daemon's own PATH is never propagated.)
      const clientEnv = (await readFile(envLog, "utf8")).split("\n")[0]!;
      expect(clientEnv).toContain("SENTINEL=[]");
      expect(clientEnv).toContain("HOME=[/home/u]");

      // The attach client (runtime spawn) carries only the allowlist.
      const attachEnv = r.spawned[0]!.spawn.env;
      expect(attachEnv.HOME).toBe("/home/u");
      expect(attachEnv.TERM).toBe("xterm-256color");
      expect("WOS_HOME" in attachEnv).toBe(false);
      expect("PATH" in attachEnv).toBe(false);
    },
  );
});

(runLiveTmux ? describe : describe.skip)(
  "createTmuxTerminalBackend — live tmux integration",
  () => {
    // Isolate live integration onto a DEDICATED throwaway socket, never the
    // production `worktreeos` server. These tests create real tmux sessions and
    // the afterEach below runs `kill-server`, which tears down the ENTIRE server
    // on its socket — pointed at the production socket that would wipe every live
    // wos terminal. Shadowing SOCK/posixSock here redirects both the raw `tmux`
    // shell-outs and the backend (via `socketName`) onto the test socket.
    // eslint-disable-next-line no-shadow
    const LIVE_SOCKET = "worktreeos-test";
    // eslint-disable-next-line no-shadow
    const SOCK = ["-L", LIVE_SOCKET] as const;
    // eslint-disable-next-line no-shadow
    const posixSock = [...SOCK];

    // Clear the dedicated test server after each test so a failed assertion
    // can't leak a session and trip "duplicate session" on the next create.
    afterEach(() => {
      spawnSync("tmux", [...SOCK, "kill-server"]);
    });

    test("create persists metadata, attach reads tmux output, terminate removes metadata", async () => {
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        socketName: LIVE_SOCKET,
      });
      const createdAt = new Date().toISOString();
      const created = await backend.createSession({
        id: "term_live",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt,
      });
      try {
        expect(created.session.backend).toBe("tmux");
        const metaFiles = await readdir(join(home, "terminal-sessions"));
        expect(metaFiles).toContain("term_live.json");
        const persisted = JSON.parse(
          await readFile(
            join(home, "terminal-sessions", "term_live.json"),
            "utf8",
          ),
        ) as { tmuxSessionName: string };
        expect(persisted.tmuxSessionName).toBe("wos-term-term_live");
        expect(r.spawned).toHaveLength(1);
        // Windows (psmux) targets the bare name; POSIX tmux uses the `=`
        // exact-match prefix. psmux's attach-session treats `=name` as a
        // literal session name and dies immediately, so the bare form is
        // required there.
        expect(r.spawned[0]!.spawn.args).toEqual([
          ...posixSock,
          "attach-session",
          "-t",
          IS_WIN ? "wos-term-term_live" : "=wos-term-term_live",
        ]);
        // The session must expose the tmux pane PID (the shell inside tmux)
        // — not the daemon-owned attach-client PID — so the active-command
        // resolver can walk the real process tree (e.g. find `claude code`).
        expect(typeof created.session.processId).toBe("number");
        expect(created.session.processId).toBeGreaterThan(0);
      } finally {
        await backend.terminateSession(created.session, created.transport);
        const afterFiles = await readdir(join(home, "terminal-sessions")).catch(
          () => [] as string[],
        );
        expect(afterFiles).not.toContain("term_live.json");
      }
    });

    test("create applies session options: status off, mouse on, history limit", async () => {
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        socketName: LIVE_SOCKET,
      });
      const created = await backend.createSession({
        id: "term_status",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      });
      try {
        // Regression: set-option must use the bare session name. The `=`
        // exact-match target prefix that has-session/kill-session accept makes
        // set-option fail with "no such session", silently leaving the bar on.
        const status = spawnSync(
          "tmux",
          [...SOCK, "show-options", "-t", "wos-term-term_status", "-v", "status"],
          { encoding: "utf8" },
        );
        expect(status.status).toBe(0);
        expect(status.stdout.trim()).toBe("off");
        // Mouse mode keeps xterm.js from translating wheel/touch scroll into
        // arrow keys under the always-alt-screen tmux attach client.
        const mouse = spawnSync(
          "tmux",
          [...SOCK, "show-options", "-t", "wos-term-term_status", "-v", "mouse"],
          { encoding: "utf8" },
        );
        expect(mouse.status).toBe(0);
        expect(mouse.stdout.trim()).toBe("on");
        // The first pane must inherit the raised scrollback limit — the
        // option only affects panes created after it is set, hence the
        // pre-set chained before new-session.
        const limit = spawnSync(
          "tmux",
          [
            ...SOCK,
            "display-message",
            "-p",
            "-t",
            "wos-term-term_status",
            "#{history_limit}",
          ],
          { encoding: "utf8" },
        );
        expect(limit.status).toBe(0);
        expect(Number.parseInt(limit.stdout.trim(), 10)).toBeGreaterThanOrEqual(
          50000,
        );
      } finally {
        await backend.terminateSession(created.session, created.transport);
      }
    });

    test("openTransport re-applies session options on reconnect", async () => {
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        socketName: LIVE_SOCKET,
      });
      const created = await backend.createSession({
        id: "term_reattach_opts",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      });
      try {
        // Simulate a pre-existing session without the options (e.g. created
        // by an older daemon) and verify reattach restores them.
        spawnSync("tmux", [
          ...SOCK,
          "set-option",
          "-t",
          "wos-term-term_reattach_opts",
          "mouse",
          "off",
        ]);
        const reattached = await backend.openTransport!(created.session, {
          cols: 80,
          rows: 24,
        });
        const mouse = spawnSync(
          "tmux",
          [...SOCK, "show-options", "-t", "wos-term-term_reattach_opts", "-v", "mouse"],
          { encoding: "utf8" },
        );
        expect(mouse.stdout.trim()).toBe("on");
        await backend.terminateSession(created.session, reattached);
      } finally {
        spawnSync("tmux", [
          ...SOCK,
          "kill-session",
          "-t",
          "=wos-term-term_reattach_opts",
        ]);
      }
    });

    test("refreshScreenState issues a best-effort refresh-client", async () => {
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        socketName: LIVE_SOCKET,
      });
      const created = await backend.createSession({
        id: "term_refresh",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      });
      try {
        // Live session with an attached client: must not throw.
        backend.refreshScreenState!(created.session);
      } finally {
        await backend.terminateSession(created.session, created.transport);
      }
      // After the session is gone (and for sessions missing meta), the hook
      // stays best-effort and silent.
      backend.refreshScreenState!(created.session);
      backend.refreshScreenState!({ ...created.session, meta: {} });
    });

    test("daemon shutdown disposes the transport without killing the tmux session", async () => {
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        socketName: LIVE_SOCKET,
      });
      const created = await backend.createSession({
        id: "term_detach",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      });
      try {
        await backend.onDaemonShutdown(created.session, created.transport);
        expect(r.spawned[0]!.disposed).toBe(true);
        expect(r.spawned[0]!.kills.length).toBe(0);
        // tmux session must still exist.
        const has = spawnSync("tmux", [
          ...SOCK,
          "has-session",
          "-t",
          "=wos-term-term_detach",
        ]);
        expect(has.status).toBe(0);
        // openTransport should reopen a fresh attach client.
        const reattached = await backend.openTransport!(created.session, {
          cols: 80,
          rows: 24,
        });
        expect(r.spawned).toHaveLength(2);
        await backend.terminateSession(created.session, reattached);
      } finally {
        spawnSync("tmux", [...SOCK, "kill-session", "-t", "=wos-term-term_detach"]);
      }
    });

    test("restore returns sessions whose tmux session still exists", async () => {
      const r = createFakeTerminalRuntime();
      const backend = createTmuxTerminalBackend({
        runtime: r.runtime,
        wosHome: home,
        socketName: LIVE_SOCKET,
      });
      const created = await backend.createSession({
        id: "term_restore",
        worktreePath: home,
        cwd: home,
        shell: "/bin/sh",
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      });
      try {
        // Simulate daemon restart: detach the daemon-owned transport.
        await backend.onDaemonShutdown(created.session, created.transport);
        const restored = await backend.restoreSessions!();
        expect(restored).toHaveLength(1);
        expect(restored[0]!.session.id).toBe("term_restore");
        expect(restored[0]!.session.backend).toBe("tmux");
        // Restore must rediscover the pane PID so active-command detection
        // continues to work after daemon restart.
        expect(typeof restored[0]!.session.processId).toBe("number");
        expect(restored[0]!.session.processId).toBeGreaterThan(0);
      } finally {
        await backend.terminateSession(created.session, null);
      }
    });
  },
);
