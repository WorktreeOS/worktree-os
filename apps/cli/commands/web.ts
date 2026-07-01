import {
  createDaemonBootstrap,
  type DaemonBootstrap,
} from "@worktreeos/daemon/daemon-bootstrap";
import { ensureDaemon } from "./daemon-mode";

export interface WebLauncherResult {
  ok: boolean;
  message?: string;
}

export type WebLauncher = (url: string) => Promise<WebLauncherResult>;

export interface RunWebOptions {
  /** Override the daemon HTTP bootstrap (tests). */
  bootstrap?: DaemonBootstrap;
  launcher?: WebLauncher;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
  platform?: NodeJS.Platform;
}

const USAGE = `wos web [--no-open]

  Open the wos web UI served by the local daemon. The daemon is started
  automatically if it is not already running.

Options:
  --no-open    Print the URL to stdout but do not launch a browser.
`;

export function parseWebArgs(args: string[]): { open: boolean } | { error: string } {
  let open = true;
  for (const arg of args) {
    if (arg === "--no-open") {
      open = false;
    } else if (arg === "--help" || arg === "-h") {
      return { error: "help" };
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { open };
}

export async function runWeb(
  args: string[],
  opts: RunWebOptions = {},
): Promise<number> {
  const stdoutWrite = opts.stdoutWrite ?? ((s: string) => process.stdout.write(s));
  const stderrWrite = opts.stderrWrite ?? ((s: string) => process.stderr.write(s));

  const parsed = parseWebArgs(args);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      stdoutWrite(USAGE);
      return 0;
    }
    stderrWrite(`wos web: ${parsed.error}\n${USAGE}`);
    return 2;
  }

  const bootstrap = opts.bootstrap ?? createDaemonBootstrap();
  let webUrl: string;
  try {
    webUrl = await ensureDaemon(bootstrap);
  } catch (e) {
    stderrWrite(`wos web: ${(e as Error).message}\n`);
    return 1;
  }

  stdoutWrite(`${webUrl}\n`);

  if (!parsed.open) return 0;

  const launcher = opts.launcher ?? defaultLauncher(opts.platform ?? process.platform);
  const result = await launcher(webUrl);
  if (!result.ok) {
    stderrWrite(`wos web: could not open browser (${result.message ?? "unknown error"})\n`);
  }
  return 0;
}

export function defaultLauncher(platform: NodeJS.Platform): WebLauncher {
  return async (url: string) => {
    try {
      if (platform === "darwin") {
        await Bun.$`open ${url}`.quiet();
      } else if (platform === "win32") {
        await Bun.$`cmd /c start "" ${url}`.quiet();
      } else {
        await Bun.$`xdg-open ${url}`.quiet();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };
}
