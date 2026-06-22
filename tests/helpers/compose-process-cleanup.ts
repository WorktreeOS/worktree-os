import { resolve } from "node:path";

export interface ProcessEntry {
  pid: number;
  command: string;
}

const COMPOSE_RE = /\bdocker\s+compose\b|\bdocker-compose\b/;

export function isComposeCommand(command: string): boolean {
  return COMPOSE_RE.test(command);
}

export function isTestOwnedComposeProcess(command: string, wosHome: string): boolean {
  if (!isComposeCommand(command)) return false;
  return command.includes(resolve(wosHome));
}

export function isComposeLogFollowerProcess(command: string, wosHome: string): boolean {
  if (!isTestOwnedComposeProcess(command, wosHome)) return false;
  return /\blogs\b/.test(command) && /--follow|-f\b/.test(command);
}

export function listProcesses(): ProcessEntry[] {
  const result = Bun.spawnSync(["ps", "-ax", "-o", "pid=,command="]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      const pid = Number.parseInt(line.slice(0, space), 10);
      const command = line.slice(space + 1);
      return { pid, command };
    })
    .filter((entry) => Number.isFinite(entry.pid));
}

export function findTestOwnedComposeProcesses(wosHome: string): ProcessEntry[] {
  const home = resolve(wosHome);
  return listProcesses().filter((p) => isTestOwnedComposeProcess(p.command, home));
}

export function findLeakedComposeLogFollowers(wosHome: string): ProcessEntry[] {
  const home = resolve(wosHome);
  return listProcesses().filter((p) => isComposeLogFollowerProcess(p.command, home));
}

export async function terminateTestOwnedComposeProcesses(
  wosHome: string,
  opts: { termTimeoutMs?: number } = {},
): Promise<number[]> {
  const timeout = opts.termTimeoutMs ?? 2000;
  let remaining = findTestOwnedComposeProcesses(wosHome);
  if (remaining.length === 0) return [];

  for (const { pid } of remaining) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* process may have exited */
    }
  }

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    remaining = findTestOwnedComposeProcesses(wosHome);
    if (remaining.length === 0) return [];
    await Bun.sleep(50);
  }

  for (const { pid } of findTestOwnedComposeProcesses(wosHome)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return findTestOwnedComposeProcesses(wosHome).map((p) => p.pid);
}

export function assertNoLeakedComposeLogFollowers(wosHome: string): void {
  const leaked = findLeakedComposeLogFollowers(wosHome);
  if (leaked.length > 0) {
    const detail = leaked.map((p) => `${p.pid}: ${p.command}`).join("\n");
    throw new Error(`leaked compose log followers for ${wosHome}:\n${detail}`);
  }
}
