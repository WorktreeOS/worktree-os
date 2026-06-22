import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  ArrowUpFromLine,
  GitBranch,
  GitCommitHorizontal,
  Layers,
  PencilLine,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SplitButton } from "@/components/ui/split-button";
import { Ic } from "@/components/ui/inline-code";
import {
  deriveComposerState,
  deriveQuickCommitState,
  showBranchRow,
  suggestBranchName,
  type CommitButtonMode,
} from "@/lib/review-composer-logic";

export interface CommitOptions {
  push?: boolean;
  amend?: boolean;
  /** Run `git add --all` before committing (the "Commit all" quick action). */
  stageAll?: boolean;
}

/**
 * The Review tab's commit composer: branch line / detached-branch row, an
 * auto-growing message textarea, the AI gating hint (neutral ink — never amber),
 * and the `Commit / Commit & push / Amend` split button. Empty-message commits
 * with a configured provider generate the message first (handled by the parent
 * via `onCommit`). `Cmd`/`Ctrl`+`Enter` commits and pushes.
 */
export function ReviewComposer({
  branch,
  detached,
  head,
  stagedCount,
  changedCount,
  aiConfigured,
  message,
  onMessageChange,
  generating,
  committing,
  onGenerate,
  onCommit,
  onCreateBranch,
  settingsHref = "/settings/ai-providers",
  branchSeed,
}: {
  branch?: string;
  detached: boolean;
  head?: string;
  stagedCount: number;
  /** Total changed files (staged + unstaged) — drives the "Commit all" action. */
  changedCount: number;
  aiConfigured: boolean;
  message: string;
  onMessageChange: (next: string) => void;
  generating: boolean;
  committing: boolean;
  onGenerate: () => void;
  onCommit: (opts: CommitOptions) => void;
  onCreateBranch: (name: string) => void;
  settingsHref?: string;
  branchSeed: string;
}) {
  const state = deriveComposerState({
    message,
    stagedCount,
    aiConfigured,
    generating,
    committing,
  });
  const quick = deriveQuickCommitState({
    message,
    changedCount,
    aiConfigured,
    generating,
    committing,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [allMenuOpen, setAllMenuOpen] = useState(false);
  const [branchName, setBranchName] = useState(() => suggestBranchName(branchSeed));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the message textarea to fit its content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [message]);

  return (
    <div
      data-testid="review-composer"
      className="flex flex-col gap-2.5 border-t border-[color:var(--hair)] bg-[color:var(--surface)] px-3.5 pb-3.5 pt-3"
    >
      {showBranchRow(detached) ? (
        <DetachedBranchRow
          head={head}
          branchName={branchName}
          onBranchNameChange={setBranchName}
          onCreateBranch={() => onCreateBranch(branchName.trim())}
          busy={committing}
        />
      ) : (
        <div className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--muted-foreground)]">
          <GitBranch className="size-[13px] opacity-80" />
          <span>
            committing to{" "}
            <b className="font-medium text-[color:var(--ink-2)]">
              <Ic>{branch ?? "(no branch)"}</Ic>
            </b>
          </span>
        </div>
      )}

      <div className="rounded-lg border border-[color:var(--hair-2)] bg-[color:var(--surface)]">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (state.canCommit) onCommit({ push: true });
            }
          }}
          rows={1}
          data-testid="review-composer-message"
          placeholder="Summary — leave empty to auto-generate from the staged diff…"
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--muted-foreground)]"
        />
        {state.showGenerateHint && (
          <div
            data-testid="review-composer-ai-hint"
            className="flex items-center gap-2 border-t border-[color:var(--hair)] px-3 py-2 text-[11.5px] text-[color:var(--ink-2)]"
          >
            <Sparkles className="size-[13px] text-[color:var(--ink-2)]" />
            <span>
              No message yet — <em className="not-italic font-medium">WorktreeOS will write one</em>{" "}
              from your {stagedCount} staged {stagedCount === 1 ? "file" : "files"} on commit.
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="xs"
              onClick={onGenerate}
              disabled={!state.canGenerate}
              data-testid="review-composer-generate"
            >
              <Sparkles className="size-[13px]" />
              {generating ? "Writing…" : "Generate"}
            </Button>
          </div>
        )}
        {state.showSettingsHint && (
          <div
            data-testid="review-composer-settings-hint"
            className="border-t border-[color:var(--hair)] px-3 py-2 text-[11.5px] text-[color:var(--muted-foreground)]"
          >
            AI provider not configured —{" "}
            <Link
              to={settingsHref}
              className="text-[color:var(--ink-2)] underline underline-offset-2 hover:text-[color:var(--ink)]"
            >
              set one in Settings
            </Link>{" "}
            to auto-generate, or type a message.
          </div>
        )}
      </div>

      <div className="relative flex flex-wrap items-center justify-between gap-2">
        {/* Quick: stage everything (git add --all) and commit in one step. */}
        <div className="relative">
          {allMenuOpen && (
            <div
              data-testid="review-commit-all-menu"
              className="absolute bottom-[calc(100%+6px)] left-0 z-10 w-[260px] overflow-hidden rounded-lg border border-[color:var(--hair-2)] bg-[color:var(--surface)] shadow-lg"
            >
              <CommitMenuItem
                icon={<ArrowUpFromLine className="size-[14px]" />}
                label="Commit all & push"
                sub="stage everything, commit, then push"
                disabled={!quick.canPush}
                onClick={() => {
                  setAllMenuOpen(false);
                  onCommit({ stageAll: true, push: true });
                }}
              />
              <CommitMenuItem
                icon={<Layers className="size-[14px]" />}
                label="Commit all"
                sub="stage everything & commit locally"
                disabled={!quick.canCommit}
                onClick={() => {
                  setAllMenuOpen(false);
                  onCommit({ stageAll: true });
                }}
              />
            </div>
          )}
          <SplitButton
            data-testid="review-commit-all"
            disabled={!quick.canCommit}
            menuDisabled={committing || generating}
            menuLabel="Commit all options"
            onClick={() => onCommit({ stageAll: true })}
            onMenuClick={() => setAllMenuOpen((p) => !p)}
          >
            {quick.generates ? (
              <Sparkles className="size-[14px]" />
            ) : (
              <Layers className="size-[14px]" />
            )}
            <span data-testid="review-commit-all-label">Commit all</span>
          </SplitButton>
        </div>

        {/* Curated: commit only the staged subset. */}
        <div className="relative">
          {menuOpen && (
            <div
              data-testid="review-commit-menu"
              className="absolute bottom-[calc(100%+6px)] right-0 z-10 w-[260px] overflow-hidden rounded-lg border border-[color:var(--hair-2)] bg-[color:var(--surface)] shadow-lg"
            >
              <CommitMenuItem
                icon={<ArrowUpFromLine className="size-[14px]" />}
                label="Commit & push"
                sub={branch ? `push to origin/${branch}` : "push to origin"}
                disabled={!state.canCommit}
                onClick={() => {
                  setMenuOpen(false);
                  onCommit({ push: true });
                }}
              />
              <CommitMenuItem
                icon={<GitCommitHorizontal className="size-[14px]" />}
                label="Commit only"
                sub="commit locally, push later"
                disabled={!state.canCommit}
                onClick={() => {
                  setMenuOpen(false);
                  onCommit({});
                }}
              />
              <CommitMenuItem
                icon={<PencilLine className="size-[14px]" />}
                label="Amend last commit"
                sub="fold into the previous commit"
                disabled={committing || generating}
                onClick={() => {
                  setMenuOpen(false);
                  onCommit({ amend: true });
                }}
              />
            </div>
          )}
          <SplitButton
            data-testid="review-commit"
            disabled={!state.canCommit}
            menuDisabled={committing || generating}
            menuLabel="Commit options"
            onClick={() => onCommit({})}
            onMenuClick={() => setMenuOpen((p) => !p)}
          >
            {state.mode === ("generate-and-commit" satisfies CommitButtonMode) ? (
              <Sparkles className="size-[14px]" />
            ) : (
              <GitCommitHorizontal className="size-[14px]" />
            )}
            <span data-testid="review-commit-label">
              {committing ? "Committing…" : generating ? "Writing…" : state.label}
            </span>
          </SplitButton>
        </div>
      </div>
    </div>
  );
}

function DetachedBranchRow({
  head,
  branchName,
  onBranchNameChange,
  onCreateBranch,
  busy,
}: {
  head?: string;
  branchName: string;
  onBranchNameChange: (v: string) => void;
  onCreateBranch: () => void;
  busy: boolean;
}) {
  return (
    <div
      data-testid="review-composer-detached"
      className="flex flex-col gap-1.5 rounded-lg border border-[color:var(--hair-2)] bg-[color:var(--shell)] px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--ink-2)]">
        <GitBranch className="size-[13px] opacity-80" />
        <span>
          detached HEAD at <Ic>{head ? head.slice(0, 8) : "(unknown)"}</Ic> —
          commits won't be on a branch.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={branchName}
          onChange={(e) => onBranchNameChange(e.target.value)}
          placeholder="new-branch-name"
          data-testid="review-composer-branch-name"
          className="min-w-0 flex-1 rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2.5 py-1.5 font-mono text-[12px] text-[color:var(--ink)] outline-none focus-visible:border-[color:var(--ink)]/40"
        />
        <Button
          variant="default"
          size="sm"
          onClick={onCreateBranch}
          disabled={busy || branchName.trim().length === 0}
          data-testid="review-composer-create-branch"
        >
          Create branch
        </Button>
      </div>
    </div>
  );
}

function CommitMenuItem({
  icon,
  label,
  sub,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-2.5 px-3 py-2 text-left",
        "hover:bg-[color:var(--hover)] disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      <span className="mt-0.5 text-[color:var(--ink-2)]">{icon}</span>
      <span className="flex flex-col">
        <span className="text-[12.5px] text-[color:var(--ink)]">{label}</span>
        <span className="text-[11px] text-[color:var(--muted-foreground)]">{sub}</span>
      </span>
    </button>
  );
}
