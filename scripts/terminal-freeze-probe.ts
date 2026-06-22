#!/usr/bin/env bun
/**
 * Terminal freeze probe.
 *
 * Reproduces and quantifies the periodic terminal stalls seen on Windows by
 * driving the daemon exactly the way the web UI does and measuring how long the
 * daemon's (single-threaded) event loop goes unresponsive.
 *
 * Why this exists: the UI polls `GET /ui/v1/terminal-layer/sessions` every
 * ~2.5s. Building that response resolves each session's active command, which
 * (on Windows) used to run `Get-CimInstance Win32_Process` via a SYNCHRONOUS
 * spawn. A full process enumeration costs hundreds of milliseconds and, being
 * synchronous, froze the whole Bun event loop for that window — stalling every
 * terminal's WebSocket I/O. See packages/daemon/src/terminal-layer/process-detection.ts.
 *
 * What it measures, concurrently, for `--duration` seconds:
 *   1. Event-loop stall  — latency of a cheap `GET /ui/v1/health` every 100ms.
 *                          Spikes here == the loop was blocked. Shell-agnostic,
 *                          the rigorous signal.
 *   2. UI list poll      — latency of `GET /ui/v1/terminal-layer/sessions`
 *                          every 2.5s. This is the *trigger*; its own slow calls
 *                          are the ones doing the process scan.
 *   3. Terminal echo     — round-trip of a tiny keystroke sent over the terminal
 *                          WebSocket to its echo. The user-visible "the terminal
 *                          froze while I was typing" latency.
 *
 * It NEVER touches your live sessions: it creates a dedicated throwaway terminal
 * for the echo probe and terminates it on exit.
 *
 * Usage:
 *   bun scripts/terminal-freeze-probe.ts
 *   bun scripts/terminal-freeze-probe.ts --duration 20 --worktree C:\dev\depboy
 *   bun scripts/terminal-freeze-probe.ts --url http://127.0.0.1:4949
 *
 * Before/after workflow:
 *   1. Run it against the currently-running daemon  -> see the freezes.
 *   2. Restart the daemon with the fixed source (`bun run apps/cli/index.ts restart`).
 *   3. Run it again -> freezes should be gone.
 *
 * Exits 0 when no event-loop freeze over the threshold is observed, 1 otherwise,
 * so it can gate CI / release smoke.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------- CLI args ----------

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DURATION_MS = Number(argValue("duration") ?? "30") * 1000;
const STALL_THRESHOLD_MS = Number(argValue("threshold") ?? "150");
const HEALTH_INTERVAL_MS = 100;
const LIST_INTERVAL_MS = 2500;
const ECHO_INTERVAL_MS = 150;

// ---------- daemon discovery ----------

function wosHome(): string {
  const raw = process.env.WOS_HOME;
  return raw && raw.length > 0 ? resolve(raw) : resolve(homedir(), ".wos");
}

async function resolveBaseUrl(): Promise<string> {
  const override = argValue("url");
  if (override) return override.replace(/\/+$/, "");
  const metaPath = resolve(wosHome(), "daemon.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as { webUrl?: string };
  if (!meta.webUrl) throw new Error(`daemon.json has no webUrl (${metaPath})`);
  return meta.webUrl.replace(/\/+$/, "");
}

// ---------- stats ----------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function summarize(label: string, samples: number[]): { max: number; freezes: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const max = sorted.length ? sorted[sorted.length - 1]! : 0;
  const freezes = samples.filter((v) => v >= STALL_THRESHOLD_MS).length;
  const f = (n: number) => `${n.toFixed(0)}ms`;
  console.log(
    `${label}\n` +
      `  samples=${samples.length}  p50=${f(percentile(sorted, 50))}  ` +
      `p90=${f(percentile(sorted, 90))}  p99=${f(percentile(sorted, 99))}  ` +
      `max=${f(max)}  over-${STALL_THRESHOLD_MS}ms=${freezes}`,
  );
  return { max, freezes };
}

// ---------- probe loops ----------

const deadline = () => performance.now() >= stopAt;
let stopAt = 0;

async function timedFetch(url: string): Promise<number> {
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    await res.arrayBuffer(); // drain body so timing includes full response
  } catch {
    /* count nothing on transport error */
  }
  return performance.now() - t0;
}

async function healthLoop(baseUrl: string, out: number[]): Promise<void> {
  const url = `${baseUrl}/ui/v1/health`;
  while (!deadline()) {
    out.push(await timedFetch(url));
    await Bun.sleep(HEALTH_INTERVAL_MS);
  }
}

async function listLoop(baseUrl: string, out: number[]): Promise<void> {
  const url = `${baseUrl}/ui/v1/terminal-layer/sessions`;
  while (!deadline()) {
    out.push(await timedFetch(url));
    await Bun.sleep(LIST_INTERVAL_MS);
  }
}

// ---------- terminal echo probe over the WebSocket ----------

interface EchoState {
  samples: number[];
  buffer: string;
  pending: { token: string; sentAt: number } | null;
  lastSeq: number;
}

function attachEcho(wsUrl: string, state: EchoState): WebSocket {
  const ws = new WebSocket(wsUrl);
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        v: 1,
        clientId: "freeze-probe",
        cols: 80,
        rows: 24,
        desiredControl: "controller",
      }),
    );
  });
  ws.addEventListener("message", (ev) => {
    let frame: { type?: string; seq?: number; data?: string };
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (frame.type === "output" && typeof frame.data === "string") {
      if (typeof frame.seq === "number") state.lastSeq = frame.seq;
      state.buffer = (state.buffer + frame.data).slice(-4096);
      if (state.pending && state.buffer.includes(state.pending.token)) {
        state.samples.push(performance.now() - state.pending.sentAt);
        state.pending = null;
      }
    }
  });
  return ws;
}

async function echoLoop(ws: WebSocket, state: EchoState): Promise<void> {
  // Wait for the socket to be open + the hello handshake to settle.
  const openBy = performance.now() + 3000;
  while (ws.readyState !== WebSocket.OPEN && performance.now() < openBy) {
    await Bun.sleep(50);
  }
  let n = 0;
  while (!deadline()) {
    if (ws.readyState !== WebSocket.OPEN) break;
    // Periodically ack so the server's journal advances and we stay well-behaved.
    if (state.lastSeq > 0) {
      ws.send(JSON.stringify({ type: "ack", v: 1, ackSeq: state.lastSeq }));
    }
    if (!state.pending) {
      const token = `zZ${n++}Zz`;
      state.pending = { token, sentAt: performance.now() };
      // Type the token (echoed by the shell), then Ctrl-C to discard the line
      // so nothing is ever executed in the throwaway session.
      ws.send(JSON.stringify({ type: "input", v: 1, data: token }));
      await Bun.sleep(40);
      ws.send(JSON.stringify({ type: "input", v: 1, data: "" }));
    } else {
      // Echo didn't come back yet (the loop may be frozen) — give up on this
      // token after a beat and record the stall.
      if (performance.now() - state.pending.sentAt > 2000) {
        state.samples.push(performance.now() - state.pending.sentAt);
        state.pending = null;
      }
    }
    await Bun.sleep(ECHO_INTERVAL_MS);
  }
}

// ---------- session helpers ----------

async function createProbeSession(baseUrl: string, worktree: string): Promise<string> {
  const res = await fetch(`${baseUrl}/ui/v1/terminal-layer/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worktreePath: worktree, cols: 80, rows: 24 }),
  });
  if (!res.ok) {
    throw new Error(`create session failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { session?: { id?: string }; id?: string };
  const id = body.session?.id ?? body.id;
  if (!id) throw new Error(`create session returned no id: ${JSON.stringify(body)}`);
  return id;
}

async function terminateSession(baseUrl: string, id: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/ui/v1/terminal-layer/sessions/${encodeURIComponent(id)}/terminate`, {
      method: "POST",
    });
  } catch {
    /* best-effort */
  }
}

// ---------- main ----------

const baseUrl = await resolveBaseUrl();
const wsBase = baseUrl.replace(/^http/, "ws");
const worktree = argValue("worktree") ?? process.cwd();

console.log("=== Terminal freeze probe ===");
console.log(`daemon:   ${baseUrl}`);
console.log(`duration: ${DURATION_MS / 1000}s   stall threshold: ${STALL_THRESHOLD_MS}ms`);

// Sanity: daemon reachable?
const healthProbe = await fetch(`${baseUrl}/ui/v1/health`).catch(() => null);
if (!healthProbe || !healthProbe.ok) {
  console.error(`FAIL: daemon not reachable at ${baseUrl}/ui/v1/health`);
  process.exit(2);
}

const probeId = await createProbeSession(baseUrl, worktree);
console.log(`probe session: ${probeId} (throwaway, will be terminated)\n`);

const wsUrl = `${wsBase}/ui/v1/terminal-layer/sessions/${encodeURIComponent(probeId)}/attach`;
const echoState: EchoState = { samples: [], buffer: "", pending: null, lastSeq: 0 };
const ws = attachEcho(wsUrl, echoState);

const healthSamples: number[] = [];
const listSamples: number[] = [];

console.log("[running — driving the daemon like the UI does]\n");
stopAt = performance.now() + DURATION_MS;

await Promise.all([
  healthLoop(baseUrl, healthSamples),
  listLoop(baseUrl, listSamples),
  echoLoop(ws, echoState),
]);

try {
  ws.close();
} catch {
  /* ignore */
}
await terminateSession(baseUrl, probeId);

console.log("--- Results ---\n");
const health = summarize(
  "1. Event-loop stall  (GET /ui/v1/health @100ms) — spikes == loop was blocked",
  healthSamples,
);
console.log();
summarize(
  "2. UI list poll      (GET /terminal-layer/sessions @2.5s) — the trigger (does the scan)",
  listSamples,
);
console.log();
summarize(
  "3. Terminal echo     (keystroke -> echo over WS) — user-visible stall while typing",
  echoState.samples,
);

console.log("\n--- Verdict ---");
if (health.freezes === 0) {
  console.log(`No event-loop freeze over ${STALL_THRESHOLD_MS}ms observed. ✔  (max ${health.max.toFixed(0)}ms)`);
  process.exit(0);
}
console.log(
  `FAIL: ${health.freezes} event-loop freeze(s) over ${STALL_THRESHOLD_MS}ms (max ${health.max.toFixed(0)}ms).`,
);
console.log(
  "The daemon loop is being blocked — on Windows this is the synchronous\n" +
    "process scan in terminal-layer/process-detection.ts. Make the scan async\n" +
    "(background refresh + synchronous stale read) so it never blocks the loop.",
);
process.exit(1);
