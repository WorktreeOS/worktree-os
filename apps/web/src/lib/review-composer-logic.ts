/**
 * Pure state derivation for the Review tab's commit composer. Drives the three
 * gating states (AI configured + empty / configured + text / not configured),
 * the split-button label/mode, the detached-branch row, and the suggested branch
 * name. No React — unit-tested per the web no-render-tests convention.
 */

export type CommitButtonMode = "commit" | "generate-and-commit";

export interface ComposerInput {
  /** Current message textarea content. */
  message: string;
  /** Number of currently staged files. */
  stagedCount: number;
  /** Whether any AI provider is configured (from the settings snapshot). */
  aiConfigured: boolean;
  /** Generation request in flight. */
  generating: boolean;
  /** Commit request in flight. */
  committing: boolean;
}

export interface ComposerState {
  /** Primary action mode: plain commit vs generate-then-commit. */
  mode: CommitButtonMode;
  /** Primary button label. */
  label: string;
  /** Whether the primary commit action is enabled. */
  canCommit: boolean;
  /** Whether the explicit Generate action is available. */
  canGenerate: boolean;
  /** Show the neutral "AI provider not configured — Settings" hint. */
  showSettingsHint: boolean;
  /** Show the "WorktreeOS will write one from N staged files" hint. */
  showGenerateHint: boolean;
}

function fileCountLabel(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

export function deriveComposerState(input: ComposerInput): ComposerState {
  const hasMessage = input.message.trim().length > 0;
  const hasStaged = input.stagedCount > 0;
  const busy = input.generating || input.committing;

  const mode: CommitButtonMode =
    !hasMessage && input.aiConfigured ? "generate-and-commit" : "commit";

  const label =
    mode === "generate-and-commit"
      ? "Generate & commit"
      : `Commit ${fileCountLabel(input.stagedCount)}`;

  // Commit is allowed when something is staged and we either have a message or
  // can generate one. With no AI and no message, the user must type first.
  const canCommit = hasStaged && (hasMessage || input.aiConfigured) && !busy;
  const canGenerate = input.aiConfigured && hasStaged && !busy;

  return {
    mode,
    label,
    canCommit,
    canGenerate,
    showSettingsHint: !input.aiConfigured && !hasMessage,
    showGenerateHint: input.aiConfigured && !hasMessage,
  };
}

export interface QuickCommitInput {
  /** Current message textarea content. */
  message: string;
  /** Total changed files (staged + unstaged) — the universe `git add --all` covers. */
  changedCount: number;
  /** Whether any AI provider is configured (from the settings snapshot). */
  aiConfigured: boolean;
  /** Generation request in flight. */
  generating: boolean;
  /** Commit request in flight. */
  committing: boolean;
}

export interface QuickCommitState {
  /** Stage-all (`git add --all`) + commit is allowed. */
  canCommit: boolean;
  /** Stage-all + commit + push is allowed (same gate as commit). */
  canPush: boolean;
  /** The action will auto-generate the message (empty message + AI configured). */
  generates: boolean;
}

/**
 * Gating for the composer's "Commit all" quick action, which runs
 * `git add --all` before committing. Unlike the staged-only commit it only needs
 * *some* change in the worktree, not a pre-staged file. It still respects the
 * same message rule: commit when there is a message, or when AI is configured to
 * write one.
 */
export function deriveQuickCommitState(input: QuickCommitInput): QuickCommitState {
  const hasMessage = input.message.trim().length > 0;
  const busy = input.generating || input.committing;
  const canCommit =
    input.changedCount > 0 && (hasMessage || input.aiConfigured) && !busy;
  return {
    canCommit,
    canPush: canCommit,
    generates: !hasMessage && input.aiConfigured,
  };
}

/** The detached-branch row is shown only when the worktree HEAD is detached. */
export function showBranchRow(detached: boolean): boolean {
  return detached;
}

/**
 * Slugify a seed (display name / branch / path basename) into a suggested branch
 * name for the detached-branch row. Falls back to `work` when nothing usable
 * remains.
 */
export function suggestBranchName(seed: string): string {
  const slug = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  return slug.length > 0 ? slug : "work";
}
