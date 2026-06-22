import { daemonMetadataPath, type DaemonMetadata } from "@worktreeos/daemon/daemon-paths";

/**
 * Returns the daemon web UI detail URL for the given worktree. Uses `webUrl`
 * from the daemon metadata and appends the `/worktree?path=<worktreeRoot>`
 * route. Returns `null` if daemon metadata is unavailable or `webUrl` is unset
 * (the daemon started but the web listener is not bound or is disabled).
 */
export async function resolveWorktreeDetailUrl(
  worktreeRoot: string,
  opts: { metadataPath?: string } = {},
): Promise<string | null> {
  const path = opts.metadataPath ?? daemonMetadataPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let metadata: DaemonMetadata;
  try {
    metadata = (await file.json()) as DaemonMetadata;
  } catch {
    return null;
  }
  const base = metadata.webUrl;
  if (!base) return null;
  return buildWorktreeDetailUrl(base, worktreeRoot);
}

/**
 * Pure function: builds a URL of the form `<base>/worktree?path=<encoded>`
 * without a double slash at the join. Exported separately so it can be tested
 * without the filesystem.
 */
export function buildWorktreeDetailUrl(
  webBaseUrl: string,
  worktreeRoot: string,
): string {
  const trimmed = webBaseUrl.replace(/\/+$/, "");
  const encoded = encodeURIComponent(worktreeRoot);
  return `${trimmed}/worktree?path=${encoded}`;
}
