import { resolve } from "node:path";

/**
 * Reusable repository config committed to the repo at
 * `<repo_root>/.wos/config.yaml`. Independent of `.wos/deploy.yaml` (deploy
 * config) and of `<wos-home>/config.json` (global runtime config). Because it
 * is committed, it is present in every worktree checkout, so it is read from the
 * current worktree root rather than the source worktree.
 *
 * The file is introduced as extensible: only the `commit.message` section is
 * defined here, and unknown top-level keys are ignored so future sections can be
 * added without breaking older readers.
 */

/** Filename of the reusable repository config under `.wos/`. */
export const REPO_CONFIG_FILENAME = "config.yaml";

export interface RepoCommitMessageConfig {
  /** Provider name (from settings `aiProviders[].name`) overriding the default. */
  provider?: string;
  /** Model id overriding the default. */
  model?: string;
  /** Output language for the generated message. */
  language?: string;
  /** Extra instructions appended to the base commit-message prompt. */
  instructions?: string;
}

export interface RepoConfig {
  commit: {
    message: RepoCommitMessageConfig;
  };
}

export interface LoadRepoConfigOptions {
  /** Override stderr writer for warnings (tests). */
  stderrWrite?: (text: string) => void;
}

export function defaultRepoConfig(): RepoConfig {
  return { commit: { message: {} } };
}

/** Absolute path to a worktree's `.wos/config.yaml`. */
export function repoConfigPath(worktreeRoot: string): string {
  return resolve(worktreeRoot, ".wos", REPO_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates `<worktreeRoot>/.wos/config.yaml`. A missing file, an
 * empty file, or a malformed value resolves to defaults for the affected
 * fields; malformed values warn without failing the load. Unknown top-level
 * keys are ignored.
 */
export async function loadRepoConfig(
  worktreeRoot: string,
  opts: LoadRepoConfigOptions = {},
): Promise<RepoConfig> {
  const warn =
    opts.stderrWrite ?? ((text: string) => process.stderr.write(text));
  const path = repoConfigPath(worktreeRoot);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return defaultRepoConfig();
  }
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    warn(`wos: ${path} could not be read (${(e as Error).message}); using defaults\n`);
    return defaultRepoConfig();
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (e) {
    warn(`wos: ${path} is not valid YAML (${(e as Error).message}); using defaults\n`);
    return defaultRepoConfig();
  }
  if (parsed === null || parsed === undefined) {
    return defaultRepoConfig();
  }
  if (!isRecord(parsed)) {
    warn(`wos: ${path} must be a YAML mapping; using defaults\n`);
    return defaultRepoConfig();
  }
  return {
    commit: { message: parseCommitMessage(parsed.commit, path, warn) },
  };
}

function parseCommitMessage(
  rawCommit: unknown,
  path: string,
  warn: (text: string) => void,
): RepoCommitMessageConfig {
  if (rawCommit === undefined) return {};
  if (!isRecord(rawCommit)) {
    warn(`wos: ${path} commit must be a mapping; ignoring\n`);
    return {};
  }
  const rawMessage = rawCommit.message;
  if (rawMessage === undefined) return {};
  if (!isRecord(rawMessage)) {
    warn(`wos: ${path} commit.message must be a mapping; ignoring\n`);
    return {};
  }
  const out: RepoCommitMessageConfig = {};
  const field = (key: keyof RepoCommitMessageConfig) => {
    const value = rawMessage[key];
    if (value === undefined) return;
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    } else {
      warn(
        `wos: ${path} commit.message.${key} must be a non-empty string; ignoring\n`,
      );
    }
  };
  field("provider");
  field("model");
  field("language");
  field("instructions");
  return out;
}
