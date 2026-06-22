import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";

export interface DaemonRestartModalProps {
  /** Whether the restart request is currently in flight. */
  submitting: boolean;
  /**
   * Optional error message returned by the most recent restart submission.
   * Cleared by the caller when the modal is re-opened.
   */
  error?: string | null;
  /**
   * True after the restart request has been accepted by the daemon and the
   * UI is waiting for the daemon to come back online. Switches the modal
   * into a reconnecting state.
   */
  submitted?: boolean;
  /**
   * Reason the dialog was opened — used to surface a short context line at
   * the top so users understand whether they invoked restart directly or
   * the dialog opened automatically after a save.
   */
  reason: "manual" | "post-save";
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation dialog rendered before any web-triggered daemon restart. The
 * Settings page opens this modal both for the explicit `Restart daemon`
 * action and after a successful save whose response reports
 * `restartRequired`.
 */
export function DaemonRestartModal({
  submitting,
  error,
  submitted = false,
  reason,
  onCancel,
  onConfirm,
}: DaemonRestartModalProps) {
  return (
    <ModalShell
      testId="daemon-restart-modal"
      ariaLabel="Restart WorktreeOS daemon"
      submitting={submitting}
      onCancel={onCancel}
    >
      <header className="px-6 pt-6 pb-4 border-b border-[color:var(--hair)]">
        <span className="text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">
          {reason === "post-save" ? "Settings saved" : "Restart daemon"}
        </span>
        <h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
          Restart the WorktreeOS daemon?
        </h2>
        <p
          className="mt-1.5 text-[13px] text-[color:var(--muted-foreground)]"
          data-testid="daemon-restart-modal-reason"
        >
          {reason === "post-save"
            ? "Your changes are saved. Restart the daemon now to apply them."
            : "Restarting reloads global settings and rebuilds daemon-owned listeners."}
        </p>
      </header>
      <div
        className="px-6 py-5 flex flex-col gap-3 text-[13px] text-[color:var(--ink-2)]"
        data-testid="daemon-restart-modal-consequences"
      >
        <p className="m-0">Before you confirm, note the impact:</p>
        <ul className="m-0 ml-5 list-disc space-y-1.5">
          <li>
            The Web UI will briefly disconnect while the daemon comes back.
          </li>
          <li>
            Active daemon-owned operations, log streams, or terminal sessions
            may be interrupted.
          </li>
          <li>
            Daemon-owned terminal sessions stop unless the selected backend
            can restore them after restart.
          </li>
          <li>
            Saved settings take effect only after the daemon comes back online.
          </li>
        </ul>
        {submitted && (
          <div
            className="mt-1 flex items-start gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2 text-[color:var(--ink-2)]"
            data-testid="daemon-restart-modal-submitted"
          >
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
            <span>
              Restart requested. The Web UI will reconnect when the daemon is
              back.
            </span>
          </div>
        )}
        {error && !submitted && (
          <div
            className="mt-1 flex items-start gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2 text-[color:var(--bad)]"
            data-testid="daemon-restart-modal-error"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--hair)] px-6 py-3.5">
        <Button
          type="button"
          variant="default"
          disabled={submitting || submitted}
          onClick={onCancel}
          data-testid="daemon-restart-modal-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="solid"
          disabled={submitting || submitted}
          onClick={onConfirm}
          data-testid="daemon-restart-modal-confirm"
        >
          {submitting ? (
            <Loader2 className="size-[14px] animate-spin" />
          ) : (
            <RefreshCw className="size-[14px]" />
          )}
          Restart daemon
        </Button>
      </footer>
    </ModalShell>
  );
}
