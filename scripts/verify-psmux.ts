#!/usr/bin/env bun
/**
 * End-to-end verification of the Windows psmux tmux-backend.
 *
 * Drives the REAL tmux backend (createTmuxTerminalBackend) against the REAL
 * psmux binary and the REAL Bun.Terminal ConPTY runtime — no mocks — and
 * asserts the regressions are fixed:
 *
 *   1. the attach-client PTY stays alive (does NOT "start and instantly die"),
 *      renders the shell, and echoes typed input;
 *   2. terminateSession actually kills the psmux session (no leak) and the
 *      psmux.exe process count returns to baseline;
 *   3. two concurrently open sessions DO NOT cross-attach — each attach client
 *      renders only its OWN session. This is the reported bug: psmux#324, where
 *      `attach-session`'s `-t` target fails to resolve and psmux silently
 *      connects to the most-recently created session instead, so every new
 *      terminal shows the previous one. Each session now lives in its own
 *      `-L <name>` psmux server namespace, so the target can never resolve to a
 *      sibling and the cross-attach is structurally impossible.
 *
 * Exits non-zero on the first failed assertion.
 *
 * Usage:  bun scripts/verify-psmux.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunTerminalRuntime } from "@worktreeos/daemon/terminal-layer/bun-terminal-runtime";
import { createTmuxTerminalBackend } from "@worktreeos/daemon/terminal-layer/tmux-backend";

const PSMUX = "psmux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (args: string[]) =>
  spawnSync(PSMUX, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
// Each session lives in its OWN `-L <tmuxSessionName>` psmux server namespace
// (see tmux-backend.ts), so raw psmux probes MUST carry the matching `-L` or
// they would query a different (empty) server. Mirror the backend exactly.
const shNs = (name: string, args: string[]) => sh(["-L", name, ...args]);

function psmuxProcessCount(): number {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq psmux.exe", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const out = r.stdout ?? "";
  return /psmux\.exe/i.test(out)
    ? out.split(/\r?\n/).filter((l) => /psmux\.exe/i.test(l)).length
    : 0;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log(`platform=${process.platform}  bun=${Bun.version}  psmux="${(sh(["-V"]).stdout ?? "").trim()}"`);

  const baseline = psmuxProcessCount();
  console.log(`psmux baseline processes = ${baseline}\n`);

  const home = await mkdtemp(join(tmpdir(), "wos-psmux-verify-"));
  // `socketName` is honored only by the POSIX shared socket; on Windows the
  // backend derives a per-session `-L` namespace from each session name and
  // ignores it. Passed here purely so a stray POSIX run can never touch the
  // daemon's production `worktreeos` server.
  const backend = createTmuxTerminalBackend({
    runtime: bunTerminalRuntime,
    wosHome: home,
    socketName: "worktreeos-verify",
  });
  const shell = process.env.COMSPEC || "cmd.exe";

  console.log("== createSession ==");
  const created = await backend.createSession({
    id: "verify1",
    worktreePath: process.cwd(),
    cwd: process.cwd(),
    shell,
    env: {},
    extraEnv: { WOS_VERIFY: "1" },
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
  });
  const tmuxName = (created.session.meta as Record<string, unknown>)?.tmuxSessionName as string;
  check("createSession returned a pane PID", typeof created.session.processId === "number", `pid=${created.session.processId}`);
  check("psmux session exists", shNs(tmuxName, ["has-session", "-t", tmuxName]).status === 0, tmuxName);

  // Observe the attach transport: it must STAY ALIVE and render output.
  let exited = false;
  let bytes = 0;
  let text = "";
  created.transport.onExit(() => { exited = true; });
  created.transport.onData((c) => {
    bytes += c.byteLength;
    text += new TextDecoder().decode(c);
  });
  await sleep(1500);
  check("attach transport stays alive (does not instantly die)", !exited, exited ? "transport EXITED" : "alive");
  check("attach transport rendered output", bytes > 0, `${bytes} bytes`);

  // Type a command and confirm the shell echoes it back (interactive).
  console.log("\n== interactive input ==");
  created.transport.write("echo wos_psmux_ok\r");
  await sleep(1500);
  check("typed command produced output", text.includes("wos_psmux_ok"), text.includes("wos_psmux_ok") ? "saw echo" : "no echo seen");

  console.log(`\npsmux processes while running = ${psmuxProcessCount()}`);

  console.log("\n== terminateSession (must actually kill, no leak) ==");
  await backend.terminateSession(created.session, created.transport);
  await sleep(600);
  const gone = shNs(tmuxName, ["has-session", "-t", tmuxName]).status !== 0;
  check("session is gone after terminateSession (no leak)", gone, gone ? "killed" : "LEAKED — still present");

  // The actual reported bug: two sessions open AT ONCE must not cross-attach.
  // Each attach client must render only its OWN session's marker. With shared
  // servers psmux#324 routed the second attach to the most-recent session.
  console.log("\n== two concurrent sessions do not cross-attach (psmux#324) ==");
  const sessions = await Promise.all(
    (["alpha", "beta"] as const).map((tag) =>
      backend.createSession({
        id: `concurrent_${tag}`,
        worktreePath: process.cwd(),
        cwd: process.cwd(),
        shell,
        env: {},
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  const seen: Record<string, string> = { alpha: "", beta: "" };
  sessions.forEach((s, i) => {
    const tag = i === 0 ? "alpha" : "beta";
    s.transport.onData((c) => { seen[tag] += new TextDecoder().decode(c); });
  });
  await sleep(800);
  sessions[0]!.transport.write("echo wos_marker_alpha\r");
  sessions[1]!.transport.write("echo wos_marker_beta\r");
  await sleep(1800);
  check(
    "session alpha shows only its own marker",
    seen.alpha!.includes("wos_marker_alpha") && !seen.alpha!.includes("wos_marker_beta"),
    `alpha=${seen.alpha!.includes("wos_marker_alpha")} beta-bleed=${seen.alpha!.includes("wos_marker_beta")}`,
  );
  check(
    "session beta shows only its own marker",
    seen.beta!.includes("wos_marker_beta") && !seen.beta!.includes("wos_marker_alpha"),
    `beta=${seen.beta!.includes("wos_marker_beta")} alpha-bleed=${seen.beta!.includes("wos_marker_alpha")}`,
  );
  for (const s of sessions) {
    await backend.terminateSession(s.session, s.transport);
  }
  await sleep(600);

  // Per-session servers exit with their last session, so the process count
  // returns to baseline after teardown — there is no shared server lingering
  // and, crucially, no PER-SESSION accumulation as session count grows.
  console.log("\n== no per-session accumulation (create+terminate x3) ==");
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await backend.createSession({
      id: `loop${i}`,
      worktreePath: process.cwd(),
      cwd: process.cwd(),
      shell,
      env: {},
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
    });
    await sleep(400);
    await backend.terminateSession(s.session, s.transport);
    await sleep(500);
    const c = psmuxProcessCount();
    counts.push(c);
    console.log(`  cycle ${i + 1}: psmuxProcs=${c}`);
  }
  const settled = psmuxProcessCount();
  const maxCount = Math.max(...counts);
  check("process count returns to baseline after teardown", settled <= baseline, `settled=${settled} baseline=${baseline}`);
  // A live cycle runs one session server + one attach client; bound the peak so
  // accumulation (the original symptom) would trip the assertion.
  check("process count stays bounded across cycles (no accumulation)", maxCount <= baseline + 2, `peak=${maxCount} (≤ ${baseline + 2})`);

  // Cleanup: each namespace's server is its own; kill any that survived.
  for (const name of [tmuxName, ...sessions.map((s) => (s.session.meta as Record<string, unknown>)?.tmuxSessionName as string)]) {
    if (name) shNs(name, ["kill-server"]);
  }
  await rm(home, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
