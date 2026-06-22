import { isAbsolute, relative, resolve, sep } from "node:path";

export interface WorktreeEntry {
  path: string;
  bare: boolean;
  detached: boolean;
  /** HEAD commit SHA when reported by git. */
  head?: string;
  /** Full branch ref (e.g. `refs/heads/main`) when reported by git. */
  branchRef?: string;
  /** Short branch name (e.g. `main`) when reported by git. */
  branch?: string;
}

export class GitError extends Error {}

export const NOT_INSIDE_WORKTREE_MESSAGE =
  "wos must be run from inside a Git worktree";

export class NotInsideWorktreeError extends Error {
  constructor() {
    super(NOT_INSIDE_WORKTREE_MESSAGE);
  }
}

const NON_WORKTREE_PATTERNS = [
  /not a git repository/i,
  /not in a git repository/i,
  /not inside a (work tree|working tree)/i,
  /this operation must be run in a work tree/i,
];

export function isNonWorktreeGitError(err: unknown): boolean {
  if (!(err instanceof GitError)) return false;
  return NON_WORKTREE_PATTERNS.some((p) => p.test(err.message));
}

export type GitRunner = (args: string[]) => Promise<string>;

export const defaultGitRunner: GitRunner = async (args) => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
};

/**
 * Builds a `GitRunner` that runs `git` in a fixed `cwd` directory without
 * changing the process's `process.cwd()`. Used by the global
 * `wos --cwd <path> <command>` option.
 */
export function gitRunnerInCwd(cwd: string): GitRunner {
  return async (args) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new GitError(
        `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`,
      );
    }
    return stdout;
  };
}

export async function currentWorktreeRoot(run: GitRunner = defaultGitRunner): Promise<string> {
  return (await run(["rev-parse", "--show-toplevel"])).trim();
}

export async function currentGitDir(run: GitRunner = defaultGitRunner): Promise<string> {
  return (await run(["rev-parse", "--git-dir"])).trim();
}

export interface CurrentWorktree {
  worktreeRoot: string;
  gitDir: string;
}

export async function ensureCurrentWorktree(
  run: GitRunner = defaultGitRunner,
): Promise<CurrentWorktree> {
  try {
    const worktreeRoot = await currentWorktreeRoot(run);
    const gitDir = await currentGitDir(run);
    return { worktreeRoot, gitDir };
  } catch (e) {
    if (isNonWorktreeGitError(e)) {
      throw new NotInsideWorktreeError();
    }
    throw e;
  }
}

export async function listWorktrees(run: GitRunner = defaultGitRunner): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await run(["worktree", "list", "--porcelain"]));
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (current.path) {
      const entry: WorktreeEntry = {
        path: current.path,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      };
      if (current.head) entry.head = current.head;
      if (current.branchRef) {
        entry.branchRef = current.branchRef;
        entry.branch = shortBranchName(current.branchRef);
      }
      entries.push(entry);
    }
    current = {};
  };
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length).trim(), bare: false, detached: false };
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length).trim();
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries;
}

function shortBranchName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return ref;
}

export function selectSourceWorktree(entries: WorktreeEntry[]): WorktreeEntry {
  if (entries.length === 0) {
    throw new GitError("no worktrees reported by git");
  }
  const preferred = entries.find((e) => !e.bare && !e.detached);
  return preferred ?? entries[0]!;
}

export function isSourceWorktree(currentRoot: string, source: WorktreeEntry): boolean {
  return resolve(currentRoot) === resolve(source.path);
}

export type WorktreeGitRunner = (
  worktreeRoot: string,
  args: string[],
) => Promise<string>;

export const defaultWorktreeGitRunner: WorktreeGitRunner = async (
  worktreeRoot,
  args,
) => {
  const proc = Bun.spawn(["git", "-C", worktreeRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // `git diff --no-index` reports "differences found" with exit code 1, which is
  // the expected, successful result when we synthesize patches for untracked
  // files — only treat other non-zero codes as failures.
  const noIndexDiff = args.includes("--no-index") && code === 1;
  if (code !== 0 && !noIndexDiff) {
    throw new GitError(
      `git -C ${worktreeRoot} ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`,
    );
  }
  return stdout;
};

export async function readStagedDiff(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<string> {
  return run(worktreeRoot, ["diff", "--cached", "--no-ext-diff", "--"]);
}

export async function readUnstagedDiff(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<string> {
  return run(worktreeRoot, ["diff", "--no-ext-diff", "--"]);
}

export interface GitNumstatEntry {
  /** Additions reported by `--numstat` (`-` for binary files). */
  additions: number | null;
  /** Deletions reported by `--numstat` (`-` for binary files). */
  deletions: number | null;
  /** New path (or `null` for deletions when git only reports the old path). */
  newPath: string | null;
  /** Old path when git reports a rename/copy, otherwise `null`. */
  oldPath: string | null;
}

export interface GitNameStatusEntry {
  /** Raw single-letter status (`A`, `M`, `D`, `R100`, `C75`, `T`, …). */
  status: string;
  /** Path after the change (or `null` for pure deletions). */
  newPath: string | null;
  /** Path before the change when renames/copies are reported. */
  oldPath: string | null;
}

/**
 * Parses `git diff --numstat` output. Each line is `<add>\t<del>\t<path>` or, for
 * renames/copies, `<add>\t<del>\t<oldPath>\t<newPath>`. Binary files use `-` for
 * the counts.
 */
export function parseNumstat(output: string): GitNumstatEntry[] {
  const entries: GitNumstatEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? null : Number(parts[0]);
    const deletions = parts[1] === "-" ? null : Number(parts[1]);
    let oldPath: string | null = null;
    let newPath: string | null = null;
    if (parts.length >= 4) {
      oldPath = parts[2] ?? null;
      newPath = parts[3] ?? null;
    } else {
      newPath = parts[2] ?? null;
    }
    entries.push({
      additions: Number.isFinite(additions) ? (additions as number) : null,
      deletions: Number.isFinite(deletions) ? (deletions as number) : null,
      oldPath,
      newPath,
    });
  }
  return entries;
}

/**
 * Parses `git diff --name-status` output. Each line is `<status>\t<path>` or
 * `<status>\t<oldPath>\t<newPath>` for renames/copies.
 */
export function parseNameStatus(output: string): GitNameStatusEntry[] {
  const entries: GitNameStatusEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0] ?? "";
    if (parts.length >= 3) {
      entries.push({
        status,
        oldPath: parts[1] ?? null,
        newPath: parts[2] ?? null,
      });
    } else {
      entries.push({
        status,
        oldPath: null,
        newPath: parts[1] ?? null,
      });
    }
  }
  return entries;
}

export interface DiffSetCollection {
  /** Raw unified patch text from `git diff`. */
  raw: string;
  numstat: GitNumstatEntry[];
  nameStatus: GitNameStatusEntry[];
}

export async function collectStagedDiffSet(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<DiffSetCollection> {
  const [raw, numstatOut, nameStatusOut] = await Promise.all([
    run(worktreeRoot, ["diff", "--cached", "--no-ext-diff", "--"]),
    run(worktreeRoot, ["diff", "--cached", "--no-ext-diff", "--numstat", "--"]),
    run(worktreeRoot, ["diff", "--cached", "--no-ext-diff", "--name-status", "--"]),
  ]);
  return {
    raw,
    numstat: parseNumstat(numstatOut),
    nameStatus: parseNameStatus(nameStatusOut),
  };
}

export async function collectUnstagedDiffSet(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<DiffSetCollection> {
  const [raw, numstatOut, nameStatusOut, untracked] = await Promise.all([
    run(worktreeRoot, ["diff", "--no-ext-diff", "--"]),
    run(worktreeRoot, ["diff", "--no-ext-diff", "--numstat", "--"]),
    run(worktreeRoot, ["diff", "--no-ext-diff", "--name-status", "--"]),
    collectUntrackedDiff(worktreeRoot, run),
  ]);
  return {
    raw: raw + untracked.raw,
    numstat: parseNumstat(numstatOut),
    nameStatus: [...parseNameStatus(nameStatusOut), ...untracked.nameStatus],
  };
}

/**
 * Untracked files never appear in `git diff`, so the Review tab would otherwise
 * hide brand-new files. List them with `git ls-files --others` and synthesize a
 * new-file patch for each via `git diff --no-index` (which the default runner
 * treats as success despite its exit code 1). An `A` name-status entry is added
 * per file so even empty new files surface as added rows.
 */
async function collectUntrackedDiff(
  worktreeRoot: string,
  run: WorktreeGitRunner,
): Promise<{ raw: string; nameStatus: GitNameStatusEntry[] }> {
  const listOut = await run(worktreeRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const files = listOut.split("\0").filter((p) => p.length > 0);
  if (files.length === 0) return { raw: "", nameStatus: [] };
  const patches = await Promise.all(
    files.map((file) =>
      run(worktreeRoot, [
        "diff",
        "--no-ext-diff",
        "--no-index",
        "--",
        "/dev/null",
        file,
      ]),
    ),
  );
  const nameStatus: GitNameStatusEntry[] = files.map((file) => ({
    status: "A",
    oldPath: null,
    newPath: file,
  }));
  return { raw: patches.join(""), nameStatus };
}

export async function listWorktreesFor(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await run(worktreeRoot, ["worktree", "list", "--porcelain"]));
}

/**
 * Aggregate counts of Git status entries reported by
 * `git status --porcelain=v1 --untracked-files=all`. Used by the worktree
 * removal preflight to decide whether destructive operations require explicit
 * user confirmation.
 */
export interface WorktreeDirtyStatus {
  /** Total number of porcelain entries (sum of the categories below). */
  total: number;
  staged: number;
  unstaged: number;
  untracked: number;
  unmerged: number;
}

export function parseDirtyStatus(porcelainOutput: string): WorktreeDirtyStatus {
  const status: WorktreeDirtyStatus = {
    total: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    unmerged: 0,
  };
  for (const rawLine of porcelainOutput.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length < 2) continue;
    const x = line.charAt(0);
    const y = line.charAt(1);
    if (x === " " && y === " ") continue;
    status.total += 1;
    if (x === "?" && y === "?") {
      status.untracked += 1;
      continue;
    }
    if (
      x === "U" ||
      y === "U" ||
      (x === "A" && y === "A") ||
      (x === "D" && y === "D")
    ) {
      status.unmerged += 1;
      continue;
    }
    if (x !== " " && x !== "?") status.staged += 1;
    if (y !== " " && y !== "?") status.unstaged += 1;
  }
  return status;
}

/** A single changed file from `git status --porcelain=v1`. */
export interface PorcelainEntry {
  /** POSIX-style path relative to the worktree root (rename → destination). */
  path: string;
  /** Two-character XY status code (e.g. ` M`, `A `, `??`, `R `). */
  code: string;
}

/**
 * Unquotes a porcelain path. Git quotes paths containing special characters
 * (when `core.quotePath` is on) by wrapping them in double quotes and
 * C-style-escaping the contents. Unquoted paths are returned verbatim.
 */
function unquotePorcelainPath(raw: string): string {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) {
    return raw;
  }
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case "n":
        out += "\n";
        i += 1;
        break;
      case "t":
        out += "\t";
        i += 1;
        break;
      case "r":
        out += "\r";
        i += 1;
        break;
      case '"':
        out += '"';
        i += 1;
        break;
      case "\\":
        out += "\\";
        i += 1;
        break;
      default:
        // Octal escape (e.g. \303\244 for UTF-8 bytes) or unknown: copy the
        // backslash through unchanged so the path is at least non-empty.
        out += "\\";
        break;
    }
  }
  return out;
}

/**
 * Parses `git status --porcelain=v1 --untracked-files=all` keeping each
 * changed file's path and its two-character XY status code. Quoted paths are
 * unquoted, and rename/copy lines (`XY <old> -> <new>`) are attributed to the
 * destination path. Unlike `parseDirtyStatus`, this preserves per-file detail
 * for decorating the file explorer.
 */
export function parsePorcelainEntries(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    // Porcelain v1 separates the code from the path with a single space.
    let rest = line.slice(3);
    // Rename/copy lines carry `<old> -> <new>`; attribute to the destination.
    const arrowIndex = rest.indexOf(" -> ");
    if (arrowIndex !== -1) {
      rest = rest.slice(arrowIndex + " -> ".length);
    }
    const path = unquotePorcelainPath(rest);
    if (path.length === 0) continue;
    entries.push({ path, code });
  }
  return entries;
}

/**
 * Returns aggregate dirty-state counts for the target worktree by parsing
 * `git status --porcelain=v1 --untracked-files=all`. A `total` of zero means
 * the worktree is clean enough for `git worktree remove` to succeed without
 * `--force`.
 */
export async function readWorktreeDirtyStatus(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<WorktreeDirtyStatus> {
  const output = await run(worktreeRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return parseDirtyStatus(output);
}

export const SOURCE_WORKTREE_REMOVE_MESSAGE =
  "primary/source worktree cannot be removed by wos";

export class SourceWorktreeRemoveError extends Error {
  constructor(message: string = SOURCE_WORKTREE_REMOVE_MESSAGE) {
    super(message);
    this.name = "SourceWorktreeRemoveError";
  }
}

/**
 * Verifies that `targetWorktreeRoot` is not the repository's selected source
 * worktree. Throws `SourceWorktreeRemoveError` if the user tries to remove the
 * primary/source worktree.
 */
export function assertNotSourceWorktree(
  targetWorktreeRoot: string,
  entries: WorktreeEntry[],
): void {
  const source = selectSourceWorktree(entries);
  if (isSourceWorktree(targetWorktreeRoot, source)) {
    throw new SourceWorktreeRemoveError();
  }
}

/**
 * Arguments for the `git worktree remove` command. `force=true` is translated
 * to `--force`, allowing removal of a worktree in a dirty or unmerged state.
 * The branch that the worktree pointed at is not deleted: `worktree remove`
 * does not touch refs and we intentionally do not invoke `branch -D`.
 */
export function buildWorktreeRemoveArgs(
  targetPath: string,
  opts: { force?: boolean } = {},
): string[] {
  const args = ["worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(targetPath);
  return args;
}

/**
 * Runs `git worktree remove [--force] <targetPath>` from the source worktree.
 * Running from the source ensures git can resolve the repository's `.git` path
 * even after the target directory has been removed.
 */
export async function removeWorktreeFromSource(
  sourceWorktreeRoot: string,
  targetWorktreePath: string,
  opts: { force?: boolean } = {},
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<void> {
  await run(sourceWorktreeRoot, buildWorktreeRemoveArgs(targetWorktreePath, opts));
}

/**
 * Arguments for creating a detached managed worktree from the source
 * repository's current `HEAD`.
 */
export function buildDetachedWorktreeAddArgs(targetPath: string): string[] {
  return ["worktree", "add", "--detach", targetPath, "HEAD"];
}

/**
 * Arguments for attaching a managed worktree to an existing branch. The
 * caller MUST validate that the branch exists before invoking this; without
 * `-b/-B`, `git worktree add <path> <branch>` will silently create a branch
 * named after the path basename if `<branch>` cannot be resolved.
 */
export function buildBranchWorktreeAddArgs(
  targetPath: string,
  branch: string,
): string[] {
  return ["worktree", "add", targetPath, branch];
}

/**
 * Returns `true` when `branch` resolves to an existing local branch in the
 * source repository. Used to reject branch-attached worktree creation against
 * unknown refs before invoking `git worktree add`.
 */
export async function branchExistsInSource(
  sourceWorktreeRoot: string,
  branch: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<boolean> {
  try {
    await run(sourceWorktreeRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

/**
 * Runs `git worktree add --detach <targetPath> HEAD` from the source worktree
 * so the created worktree starts detached at the source's current commit.
 */
export async function createDetachedWorktreeFromSource(
  sourceWorktreeRoot: string,
  targetPath: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<void> {
  await run(sourceWorktreeRoot, buildDetachedWorktreeAddArgs(targetPath));
}

/**
 * Runs `git worktree add <targetPath> <branch>` from the source worktree.
 * Callers MUST pre-validate that `branch` exists via
 * `branchExistsInSource` — otherwise `git worktree add` will create a new
 * branch implicitly, which violates the managed worktree create contract.
 */
export async function createBranchWorktreeFromSource(
  sourceWorktreeRoot: string,
  targetPath: string,
  branch: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<void> {
  await run(sourceWorktreeRoot, buildBranchWorktreeAddArgs(targetPath, branch));
}

// ---------------------------------------------------------------------------
// Git write operations (stage / unstage / commit / push / branch)
//
// These power the Review tab's commit surface. They all run through the shared
// `WorktreeGitRunner` so the daemon's timed/logged runner wraps them for free,
// and they surface Git failures as `GitError` with the underlying message
// preserved.
// ---------------------------------------------------------------------------

/**
 * Raised by `commit` when there is nothing staged and `amend` is not set. Kept
 * distinct from `GitError` so callers (and the UI API) can tell "nothing to
 * commit" apart from a real Git execution failure.
 */
export class NothingStagedError extends Error {
  constructor(message: string = "nothing staged to commit") {
    super(message);
    this.name = "NothingStagedError";
  }
}

/**
 * Validates that every pathspec resolves to a file path strictly under the
 * worktree root. Rejects empty pathspecs, the root itself, and any path that
 * escapes the root via `..` or an absolute path. Throws `GitError` on the first
 * offending entry so the caller never runs Git against an out-of-tree path.
 */
function assertPathspecsUnderRoot(worktreeRoot: string, files: string[]): void {
  const root = resolve(worktreeRoot);
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new GitError(`invalid pathspec: ${JSON.stringify(file)}`);
    }
    const rel = relative(root, resolve(root, file));
    if (
      rel.length === 0 ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      throw new GitError(`pathspec escapes worktree root: ${file}`);
    }
  }
}

/**
 * Stages the given changed files (`git add -- <paths>`). Pathspecs are
 * validated to resolve under the worktree root first. A no-op for an empty
 * list.
 */
export async function stageFiles(
  worktreeRoot: string,
  files: string[],
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<void> {
  if (files.length === 0) return;
  assertPathspecsUnderRoot(worktreeRoot, files);
  await run(worktreeRoot, ["add", "--", ...files]);
}

/**
 * Unstages the given staged files (`git reset -q HEAD -- <paths>`). Pathspecs
 * are validated to resolve under the worktree root first. A no-op for an empty
 * list.
 */
export async function unstageFiles(
  worktreeRoot: string,
  files: string[],
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<void> {
  if (files.length === 0) return;
  assertPathspecsUnderRoot(worktreeRoot, files);
  await run(worktreeRoot, ["reset", "-q", "HEAD", "--", ...files]);
}

/**
 * Stages every change in the worktree (`git add --all`): modifications,
 * additions, deletions, and untracked files. Powers the Review composer's
 * "Commit all" quick action, which stages everything before committing.
 */
export async function stageAllChanges(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<void> {
  await run(worktreeRoot, ["add", "--all"]);
}

/** Returns true when the worktree has any staged changes. */
export async function hasStagedChanges(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<boolean> {
  const out = await run(worktreeRoot, ["diff", "--cached", "--name-only", "--"]);
  return out.trim().length > 0;
}

export interface CommitOptions {
  message: string;
  /** Fold the staged changes into the latest commit instead of a new one. */
  amend?: boolean;
}

export interface CommitResult {
  /** Short SHA of the resulting commit. */
  sha: string;
  /** Short human summary as printed by `git commit`. */
  summary: string;
}

/**
 * Creates a commit from the currently staged changes (`git commit -m <message>`,
 * or `git commit --amend -m <message>` when `amend` is set). Rejects with
 * `NothingStagedError` when there is nothing staged and `amend` is not set;
 * Git execution failures surface as `GitError`.
 */
export async function commit(
  worktreeRoot: string,
  options: CommitOptions,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<CommitResult> {
  const amend = options.amend ?? false;
  if (!amend && !(await hasStagedChanges(worktreeRoot, run))) {
    throw new NothingStagedError();
  }
  const args = ["commit"];
  if (amend) args.push("--amend");
  args.push("-m", options.message);
  const summary = (await run(worktreeRoot, args)).trim();
  const sha = (await run(worktreeRoot, ["rev-parse", "--short", "HEAD"])).trim();
  return { sha, summary };
}

export interface PushOptions {
  /** Push with `-u origin <branch>` to establish a missing upstream. */
  setUpstream?: boolean;
}

export interface PushResult {
  /** Captured `git push` stdout (often empty; progress goes to stderr). */
  summary: string;
}

/**
 * Pushes the current branch (`git push`, or `git push -u origin <branch>` when
 * `setUpstream` is set). Git failures surface as `GitError` with the message
 * preserved. Setting upstream on a detached `HEAD` is rejected.
 */
export async function push(
  worktreeRoot: string,
  options: PushOptions = {},
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<PushResult> {
  let args: string[];
  if (options.setUpstream) {
    const head = await detectHeadState(worktreeRoot, run);
    if (head.detached || !head.branch) {
      throw new GitError("cannot set upstream while HEAD is detached");
    }
    args = ["push", "-u", "origin", head.branch];
  } else {
    args = ["push"];
  }
  const summary = (await run(worktreeRoot, args)).trim();
  return { summary };
}

export interface FetchOptions {
  /** Prune remote-tracking refs that no longer exist (`git fetch --prune`). */
  prune?: boolean;
}

export interface FetchResult {
  /** Captured `git fetch` stdout (usually empty; progress goes to stderr). */
  summary: string;
}

/**
 * Fetches remote refs for the worktree (`git fetch`, or `git fetch --prune`
 * when `prune` is set) so upstream tracking can be refreshed. Does NOT modify
 * the working tree or the checked-out commit. Git failures surface as
 * `GitError` with the message preserved. A worktree with no configured remote
 * is a no-op: callers can fetch unconditionally without first probing for a
 * remote, and plain `git fetch` would otherwise fail with "No remote
 * repository specified".
 */
export async function fetch(
  worktreeRoot: string,
  options: FetchOptions = {},
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<FetchResult> {
  const remotes = (await run(worktreeRoot, ["remote"])).trim();
  if (remotes.length === 0) return { summary: "" };
  const args = ["fetch"];
  if (options.prune) args.push("--prune");
  const summary = (await run(worktreeRoot, args)).trim();
  return { summary };
}

export interface HeadState {
  /** True when `HEAD` is not attached to a branch. */
  detached: boolean;
  /** Short branch name when attached. */
  branch?: string;
  /** Short commit SHA of the current `HEAD`. */
  head: string;
}

/**
 * Reports whether the worktree's `HEAD` is attached to a branch or detached.
 * Uses `git symbolic-ref --quiet --short HEAD` (succeeds → attached) and always
 * resolves the short commit via `git rev-parse --short HEAD`.
 */
export async function detectHeadState(
  worktreeRoot: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<HeadState> {
  const head = (await run(worktreeRoot, ["rev-parse", "--short", "HEAD"])).trim();
  try {
    const branch = (
      await run(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    ).trim();
    if (branch.length > 0) return { detached: false, branch, head };
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
  }
  return { detached: true, head };
}

/**
 * Conservatively validates a Git branch name before invoking `git switch -c`.
 * Rejects empty names, whitespace, the special characters Git forbids, leading
 * `-` / `/`, trailing `/` or `.lock`, and `..` / `//` / `@{` sequences. Git
 * still has the final say on edge cases (and on already-existing names).
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    return false;
  }
  if (name.endsWith(".lock") || name.includes("..") || name.includes("//")) {
    return false;
  }
  if (name.includes("@{")) return false;
  return true;
}

/**
 * Creates and switches to a new branch in place (`git switch -c <name>`) without
 * touching the source repository's checked-out refs. Validates the name first,
 * then lets Git reject already-existing or otherwise-invalid names with its own
 * message. Returns the resulting head state.
 */
export async function createBranchInPlace(
  worktreeRoot: string,
  name: string,
  run: WorktreeGitRunner = defaultWorktreeGitRunner,
): Promise<HeadState> {
  if (!isValidBranchName(name)) {
    throw new GitError(`invalid branch name: ${JSON.stringify(name)}`);
  }
  await run(worktreeRoot, ["switch", "-c", name]);
  return detectHeadState(worktreeRoot, run);
}
