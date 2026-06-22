import type {
  TerminalActiveCommand,
  TerminalKnownAgent,
} from "./types";

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  command: string;
  args: string;
  /** Process creation time (sortable; higher = more recent). Windows only. */
  created?: number;
}

const SHELL_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "sh",
  "zsh",
  // Windows interactive shells; recognized so the active-command heuristic
  // skips the host shell the same way it skips a POSIX login shell.
  "powershell",
  "pwsh",
  "cmd",
  "command",
]);

const KNOWN_AGENT_MATCHERS: Array<{
  agent: TerminalKnownAgent;
  names: Set<string>;
  args: RegExp;
}> = [
  // The leading separator class accepts both POSIX `/` and Windows `\` so an
  // agent invoked through a backslash path (`C:\bin\claude-code`) is still
  // recognized; the agent identifiers are identical across platforms.
  {
    agent: "claude",
    names: new Set(["claude"]),
    args: /(^|\s|[\\/])(claude|claude-code|@anthropic-ai\/claude-code)(\s|$)/i,
  },
  {
    agent: "opencode",
    names: new Set(["opencode"]),
    args: /(^|\s|[\\/])(opencode)(\s|$)/i,
  },
  {
    agent: "codex",
    names: new Set(["codex"]),
    args: /(^|\s|[\\/])(codex|@openai\/codex)(\s|$)/i,
  },
];

let cachedRows: { at: number; rows: ProcessRow[] } | null = null;
const PROCESS_SCAN_CACHE_MS = 750;
/**
 * True while an async process-list refresh is running. Guards against piling up
 * concurrent scans: the synchronous `readProcessList` reader returns the cached
 * (possibly stale) snapshot immediately and only kicks off a new refresh when
 * one is not already in flight.
 */
let refreshInFlight = false;

/**
 * Normalize a command path to a comparable base name: strip the directory
 * (POSIX `/` or Windows `\`), lowercase, and drop a Windows executable suffix
 * so `C:\...\powershell.exe` compares equal to `powershell`.
 */
function baseCommandName(command: string): string {
  const file = command.split(/[\\/]/).pop() ?? command;
  return file.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}

function toNumber(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseProcessList(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = line.match(
      /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/,
    );
    if (!m) continue;
    const pid = toNumber(m[1]!);
    const ppid = toNumber(m[2]!);
    const pgid = toNumber(m[3]!);
    const tpgid = toNumber(m[4]!);
    if (pid === null || ppid === null || pgid === null || tpgid === null) {
      continue;
    }
    rows.push({
      pid,
      ppid,
      pgid,
      tpgid,
      command: m[5]!,
      args: m[6] ?? "",
    });
  }
  return rows;
}

/**
 * Parse the JSON emitted by the Windows CIM process query. `ConvertTo-Json`
 * yields a bare object for a single row and an array otherwise; both are
 * accepted. Rows missing a numeric pid are dropped. `CommandLine` is null for
 * processes we cannot inspect — those keep an empty `args` and are still usable
 * for tree structure.
 */
function parseWindowsProcessList(text: string): ProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessRow[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const pid = typeof o.ProcessId === "number" ? o.ProcessId : null;
    const ppid = typeof o.ParentProcessId === "number" ? o.ParentProcessId : 0;
    if (pid === null) continue;
    const name = typeof o.Name === "string" ? o.Name : "";
    const cmdline = typeof o.CommandLine === "string" ? o.CommandLine : "";
    const created =
      typeof o.Created === "number"
        ? o.Created
        : typeof o.Created === "string"
          ? Number(o.Created)
          : undefined;
    rows.push({
      pid,
      ppid,
      // Windows has no process groups or foreground-group concept.
      pgid: pid,
      tpgid: -1,
      command: name,
      args: cmdline,
      ...(Number.isFinite(created) ? { created: created as number } : {}),
    });
  }
  return rows;
}

async function readProcessListWindows(): Promise<ProcessRow[]> {
  const shell = bunWhich("powershell") ?? bunWhich("pwsh");
  if (!shell) return [];
  // CommandLine needs no elevation for same-user processes (our PTY children).
  // `Created` is the file-time tick count: opaque but monotonic, so it sorts
  // by recency. `-Compress` keeps the payload small.
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{N='Created';E={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress";
  try {
    // Async spawn (NOT spawnSync): a full `Get-CimInstance Win32_Process`
    // enumeration of every process on the box costs hundreds of milliseconds,
    // and `spawnSync` would block Bun's single-threaded event loop for that
    // whole window — freezing every terminal's WebSocket I/O on a ~2.5s poll
    // cadence. Awaiting the child keeps the loop live; callers read the cached
    // snapshot synchronously while this refreshes in the background.
    const proc = Bun.spawn(
      [shell, "-NoProfile", "-NonInteractive", "-Command", script],
      // `windowsHide` (CREATE_NO_WINDOW) stops this poll from flashing a console
      // window: the daemon runs detached (no console), so without it Windows
      // allocates a visible console for every PowerShell child — and this runs
      // on a cache cadence, so the flashes are continuous.
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return [];
    return parseWindowsProcessList(text);
  } catch {
    return [];
  }
}

function bunWhich(name: string): string | null {
  const which = (globalThis as { Bun?: { which?: (n: string) => string | null } }).Bun?.which;
  try {
    return which?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Synchronous reader for the active-command resolver. Returns the cached
 * process snapshot immediately — never spawns inline — and triggers an async
 * refresh in the background when the cache is missing or older than
 * `PROCESS_SCAN_CACHE_MS`. The active-command badge it feeds can lag by at most
 * one poll interval, which is acceptable for a "which agent is in the
 * foreground" hint and is the price of never blocking the event loop.
 */
function readProcessList(): ProcessRow[] {
  const now = Date.now();
  const fresh = cachedRows !== null && now - cachedRows.at < PROCESS_SCAN_CACHE_MS;
  if (!fresh && !refreshInFlight) {
    refreshInFlight = true;
    void (process.platform === "win32"
      ? readProcessListWindows()
      : readProcessListPosix())
      .then((rows) => {
        cachedRows = { at: Date.now(), rows };
      })
      .catch(() => {
        // Keep the last-known snapshot, but stamp it so a persistently failing
        // scan is retried on the cadence rather than hammered every read.
        cachedRows = { at: Date.now(), rows: cachedRows?.rows ?? [] };
      })
      .finally(() => {
        refreshInFlight = false;
      });
  }
  return cachedRows?.rows ?? [];
}

async function readProcessListPosix(): Promise<ProcessRow[]> {
  try {
    const proc = Bun.spawn(
      ["ps", "-axo", "pid=,ppid=,pgid=,tpgid=,comm=,args="],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return [];
    return parseProcessList(text);
  } catch {
    return [];
  }
}

function detectKnownAgent(row: Pick<ProcessRow, "command" | "args">): TerminalKnownAgent | undefined {
  const name = baseCommandName(row.command);
  for (const matcher of KNOWN_AGENT_MATCHERS) {
    if (matcher.names.has(name)) return matcher.agent;
    if (matcher.args.test(row.args)) return matcher.agent;
  }
  return undefined;
}

function toActiveCommand(row: ProcessRow): TerminalActiveCommand {
  const agent = detectKnownAgent(row);
  return {
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    command: row.command,
    args: row.args,
    ...(agent ? { agent } : {}),
  };
}

function isShell(row: ProcessRow): boolean {
  return SHELL_NAMES.has(baseCommandName(row.command));
}

function collectTree(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const out: ProcessRow[] = [];
  const stack = [...(byParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const next = stack.shift()!;
    out.push(next);
    stack.push(...(byParent.get(next.pid) ?? []));
  }
  return out;
}

function selectActiveCommand(rows: ProcessRow[], rootPid: number): TerminalActiveCommand | undefined {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return undefined;
  const rootAgent = detectKnownAgent(root);
  if (rootAgent) return toActiveCommand(root);

  const descendants = collectTree(rows, rootPid);
  if (descendants.length === 0) return undefined;
  const foregroundPgid =
    root.tpgid > 0
      ? root.tpgid
      : descendants.find((row) => row.tpgid > 0)?.tpgid;

  const foreground =
    foregroundPgid && foregroundPgid > 0
      ? descendants.filter((row) => row.pgid === foregroundPgid)
      : [];
  const candidates = foreground.length > 0 ? foreground : descendants;

  const known = candidates.find((row) => detectKnownAgent(row));
  if (known) return toActiveCommand(known);

  const leader = candidates.find((row) => row.pid === row.pgid && !isShell(row));
  if (leader) return toActiveCommand(leader);

  const nonShell = candidates.find((row) => !isShell(row));
  return nonShell ? toActiveCommand(nonShell) : undefined;
}

/** Collect descendants of `rootPid` annotated with their tree depth. */
function collectTreeWithDepth(
  rows: ProcessRow[],
  rootPid: number,
): Array<{ row: ProcessRow; depth: number }> {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const out: Array<{ row: ProcessRow; depth: number }> = [];
  const stack: Array<{ row: ProcessRow; depth: number }> = (
    byParent.get(rootPid) ?? []
  ).map((row) => ({ row, depth: 1 }));
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const next = stack.shift()!;
    if (seen.has(next.row.pid)) continue;
    seen.add(next.row.pid);
    out.push(next);
    for (const child of byParent.get(next.row.pid) ?? []) {
      stack.push({ row: child, depth: next.depth + 1 });
    }
  }
  return out;
}

/**
 * Windows has no `tpgid`/foreground-process-group concept, so the active
 * command is approximated as the **deepest, most-recently-created** descendant
 * of the PTY shell — the leaf the user most likely just launched. A known agent
 * anywhere in the tree wins outright; otherwise the deepest/newest non-shell
 * leaf is used. Returns undefined when only shells are present (omit, never
 * guess — Decision 4).
 */
function selectActiveCommandWindows(
  rows: ProcessRow[],
  rootPid: number,
): TerminalActiveCommand | undefined {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return undefined;
  if (detectKnownAgent(root)) return toActiveCommand(root);
  const descendants = collectTreeWithDepth(rows, rootPid);
  if (descendants.length === 0) return undefined;
  // Deepest first, then most-recently created, so the user's latest leaf wins.
  const ranked = [...descendants].sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return (b.row.created ?? 0) - (a.row.created ?? 0);
  });
  const known = ranked.find((d) => detectKnownAgent(d.row));
  if (known) return toActiveCommand(known.row);
  const nonShell = ranked.find((d) => !isShell(d.row));
  return nonShell ? toActiveCommand(nonShell.row) : undefined;
}

export function detectActiveTerminalCommand(rootPid: number | undefined): TerminalActiveCommand | undefined {
  if (typeof rootPid !== "number" || rootPid <= 0) return undefined;
  const rows = readProcessList();
  return process.platform === "win32"
    ? selectActiveCommandWindows(rows, rootPid)
    : selectActiveCommand(rows, rootPid);
}

export const processDetectionInternals = {
  parseProcessList,
  parseWindowsProcessList,
  selectActiveCommand,
  selectActiveCommandWindows,
  detectKnownAgent,
};
