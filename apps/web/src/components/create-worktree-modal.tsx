import { useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, GitBranch, Loader2, Plus } from "lucide-react";
import { useUiApi } from "@/lib/api-context";
import { UiApiError, UiSessionBusyError, type ProjectSummary } from "@/lib/ui-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* Two call modes:
 *   - `project` (single): legacy header-bound flow ("New worktree for <X>")
 *   - `projects` (multi): top-level launcher with a project picker
 *
 * Implementation reuses the same form body and submit path; the only
 * difference is whether the project id is fixed or selectable. */

type CreateWorktreeModalProps =
  | {
      project: ProjectSummary;
      projects?: undefined;
      defaultProjectId?: undefined;
      onCancel: () => void;
      onCreated: (targetPath: string) => void;
    }
  | {
      project?: undefined;
      projects: ProjectSummary[];
      defaultProjectId?: string;
      onCancel: () => void;
      onCreated: (targetPath: string) => void;
    };

type Mode = "detached" | "branch";

export function CreateWorktreeModal(props: CreateWorktreeModalProps) {
  const api = useUiApi();
  const { onCancel, onCreated } = props;
  const projects = useMemo<ProjectSummary[]>(
    () => (props.project ? [props.project] : props.projects),
    [props.project, props.projects],
  );
  const initialProjectId =
    props.project?.id ?? props.defaultProjectId ?? projects[0]?.id ?? "";
  const [projectId, setProjectId] = useState<string>(initialProjectId);
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? projects[0],
    [projects, projectId],
  );
  const showPicker = !props.project && projects.length > 0;

  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("detached");
  const [branch, setBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedProject) {
      setError("Pick a project first");
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Worktree name is required");
      return;
    }
    const trimmedBranch = branch.trim();
    if (mode === "branch" && trimmedBranch.length === 0) {
      setError("Branch is required in branch mode");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.submitWorktreeCreate({
        projectId: selectedProject.id,
        name: trimmedName,
        ...(mode === "branch" ? { branch: trimmedBranch } : {}),
      });
      onCreated(res.targetPath);
    } catch (e) {
      if (e instanceof UiSessionBusyError) {
        setError("Worktree create is already in progress for this name");
      } else if (e instanceof UiApiError) {
        setError(e.message);
      } else {
        setError((e as Error).message);
      }
      setSubmitting(false);
    }
  };

  const submitDisabled =
    submitting ||
    !selectedProject ||
    name.trim().length === 0 ||
    (mode === "branch" && branch.trim().length === 0);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/45 p-0 md:p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      data-testid="worktree-create-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <form
        onSubmit={onSubmit}
        className={cn(
          "reveal w-full max-w-lg overflow-hidden",
          "bg-[color:var(--surface)] text-[color:var(--ink)]",
          "border border-[color:var(--hair-2)]",
          "rounded-t-[22px] md:rounded-[14px]",
          "shadow-[0_30px_60px_-28px_rgba(0,0,0,0.45)]",
        )}
      >
        <header className="px-6 pt-6 pb-4 border-b border-[color:var(--hair)]">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">
            New worktree
          </span>
          <h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
            {selectedProject
              ? <>Create worktree in <span className="text-[color:var(--accent-cmd)]">{selectedProject.displayName}</span></>
              : "Create worktree"}
          </h2>
        </header>
        <div className="px-6 py-5 flex flex-col gap-4 max-h-[60vh] overflow-auto">
          {showPicker ? (
            <label
              htmlFor="create-wt-project"
              className="flex flex-col gap-1.5"
            >
              <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
                project
              </span>
              <select
                id="create-wt-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={submitting}
                data-testid="worktree-create-project"
                className="rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 text-[13.5px] text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]/30"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label htmlFor="create-wt-name" className="flex flex-col gap-1.5">
            <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
              name
            </span>
            <input
              id="create-wt-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus={!showPicker}
              placeholder="feature-a"
              disabled={submitting}
              className="rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 font-mono text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]/30"
              data-testid="worktree-create-name"
            />
            {selectedProject ? (
              <span className="text-[12px] text-[color:var(--muted-foreground)]">
                Created under{" "}
                <code className="font-mono text-[12px] text-[color:var(--ink)]">
                  $WOS_HOME/worktrees/{selectedProject.displayName}/&lt;name&gt;
                </code>
                .
              </span>
            ) : null}
          </label>
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
              checkout mode
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setMode("detached")}
                aria-pressed={mode === "detached"}
                data-testid="worktree-create-mode-detached"
                className={cn(
                  "rounded-[8px] border px-3 py-2 text-left transition-colors text-[13px]",
                  mode === "detached"
                    ? "border-[color:var(--ink)] bg-[color:var(--hover)] text-[color:var(--ink)]"
                    : "border-[color:var(--hair-2)] bg-[color:var(--surface)] text-[color:var(--ink-2)] hover:bg-[color:var(--hover)]",
                )}
              >
                <div className="font-semibold">detached</div>
                <div className="text-[12px] text-[color:var(--muted-foreground)] mt-0.5">
                  Detached at source <code className="font-mono">HEAD</code>.
                </div>
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setMode("branch")}
                aria-pressed={mode === "branch"}
                data-testid="worktree-create-mode-branch"
                className={cn(
                  "rounded-[8px] border px-3 py-2 text-left transition-colors text-[13px]",
                  mode === "branch"
                    ? "border-[color:var(--ink)] bg-[color:var(--hover)] text-[color:var(--ink)]"
                    : "border-[color:var(--hair-2)] bg-[color:var(--surface)] text-[color:var(--ink-2)] hover:bg-[color:var(--hover)]",
                )}
              >
                <div className="font-semibold">existing branch</div>
                <div className="text-[12px] text-[color:var(--muted-foreground)] mt-0.5">
                  Attach to an existing branch.
                </div>
              </button>
            </div>
          </div>
          {mode === "branch" && (
            <label htmlFor="create-wt-branch" className="flex flex-col gap-1.5">
              <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
                branch
              </span>
              <div className="flex items-center gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 focus-within:ring-1 focus-within:ring-[color:var(--ink)]/30">
                <GitBranch className="h-3.5 w-3.5 text-[color:var(--muted-foreground)]" />
                <input
                  id="create-wt-branch"
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature/login"
                  disabled={submitting}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none"
                  data-testid="worktree-create-branch"
                />
              </div>
            </label>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2 text-[13px] text-[color:var(--bad)]">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--hair)] px-6 py-3.5">
          <Button
            type="button"
            variant="default"
            disabled={submitting}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="solid"
            disabled={submitDisabled}
            data-testid="worktree-create-confirm"
          >
            {submitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Plus />
            )}
            Create worktree
          </Button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
