import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useUiApi } from "@/lib/api-context";
import { useUnifiedEvents } from "@/lib/events-context";
import { useStatusCatalog } from "@/lib/status-catalog-context";
import { formatRelativeTime } from "@/lib/utils";
import type { WorktreeCommentDto, WorktreeDetailResponse } from "@/lib/ui-api";

/**
 * Quiet workflow-status control for the dossier: a leading color dot + the
 * current status name, with a select to change it. Setting the workflow status
 * never touches the derived deployment status.
 */
export function WorkflowStatusControl({
  detail,
  onChanged,
}: {
  detail: WorktreeDetailResponse;
  onChanged: () => void;
}) {
  const { statuses, byId } = useStatusCatalog();
  const api = useUiApi();
  const [pending, setPending] = useState(false);
  const current = byId(detail.worktree.workflowStatusId);

  const onSelect = async (value: string) => {
    setPending(true);
    try {
      await api.setWorktreeStatus(
        detail.worktree.path,
        value === "" ? null : value,
      );
      onChanged();
    } catch (e) {
      toast.error(`Could not set status: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="inline-flex items-center gap-2 text-[13px] text-[color:var(--ink-2)]"
      data-testid="overview-workflow-status"
    >
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full"
        style={
          current
            ? { background: current.color }
            : { boxShadow: "inset 0 0 0 1.5px var(--hair-2)" }
        }
      />
      <select
        aria-label="Workflow status"
        disabled={pending}
        value={current?.id ?? ""}
        onChange={(e) => void onSelect(e.target.value)}
        className="rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-1.5 py-0.5 text-[13px] text-[color:var(--ink)] focus-ring"
      >
        <option value="">No status</option>
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {pending ? (
        <Loader2 className="size-3.5 animate-spin text-[color:var(--muted-foreground)]" />
      ) : null}
    </div>
  );
}

/**
 * Manual, timestamped comments for the worktree (treated like a lightweight
 * task). The description remains the existing note / intent hero; this is
 * comments only. Refreshes on the `worktree.comment.changed` event.
 */
export function WorktreeComments({ path }: { path: string }) {
  const api = useUiApi();
  const events = useUnifiedEvents();
  const [comments, setComments] = useState<WorktreeCommentDto[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listWorktreeComments(path);
      setComments(res.comments);
    } catch {
      /* leave the last known list in place */
    }
  }, [api, path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return events.subscribe((env) => {
      if (
        env.type === "worktree.comment.changed" &&
        (!env.worktreePath || env.worktreePath === path)
      ) {
        void refresh();
      }
    });
  }, [events, refresh, path]);

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await api.addWorktreeComment(path, trimmed);
      setText("");
      await refresh();
    } catch (e) {
      toast.error(`Could not add comment: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await api.deleteWorktreeComment(path, id);
      setComments(res.comments);
    } catch (e) {
      toast.error(`Could not delete comment: ${(e as Error).message}`);
    }
  };

  return (
    <div data-testid="overview-comments">
      {comments.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {comments.map((c) => (
            <li
              key={c.id}
              className="group/comment flex items-start gap-2 rounded-[10px] border border-[color:var(--hair)] bg-[color:var(--shell)] px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 whitespace-pre-wrap break-words text-[13.5px] leading-[1.5] text-[color:var(--ink)]">
                  {c.text}
                </p>
                <span className="text-[11px] text-[color:var(--muted-foreground)]">
                  {formatRelativeTime(c.createdAt) ?? ""}
                </span>
              </div>
              <IconButton
                size="sm"
                aria-label="Delete comment"
                onClick={() => void remove(c.id)}
                className="opacity-0 transition-opacity group-hover/comment:opacity-100"
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[13px] text-[color:var(--muted-foreground)]">
          No comments yet.
        </p>
      )}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          rows={2}
          value={text}
          disabled={pending}
          placeholder="Add a comment…"
          data-testid="overview-comment-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void add();
            }
          }}
          className="w-full resize-none rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 text-[13.5px] leading-[1.5] text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]/30"
        />
        <Button
          size="sm"
          variant="solid"
          disabled={pending || text.trim().length === 0}
          onClick={() => void add()}
          data-testid="overview-comment-add"
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          Comment
        </Button>
      </div>
    </div>
  );
}
