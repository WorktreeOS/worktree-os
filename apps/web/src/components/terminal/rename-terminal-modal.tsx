import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AlertCircle, Loader2, PenLine } from "lucide-react";

import { useUiApi } from "@/lib/api-context";
import { UiApiError } from "@/lib/ui-api";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { terminalLabel } from "@/lib/terminal-agents";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";

/* RenameTerminalModal — shared rename affordance used by the terminal header,
 * rail terminal rows, the worktree Terminals/Sessions surfaces, and the session
 * sheet. It owns the rename form state (value, submitting, inline error) and
 * calls the rename API; visible labels reconcile through the `terminal.updated`
 * event, so the modal only closes on success. The PTY session is never
 * detached, terminated, or recreated by this control. */

/** Mirror of the daemon's MAX_TERMINAL_TITLE_LENGTH so the field bounds match. */
const MAX_TITLE_LENGTH = 80;

export function RenameTerminalModal({
  session,
  fallbackLabel,
  onClose,
}: {
  session: TerminalSessionMetadata;
  /** Auto-label shown as the placeholder when no custom title is set. */
  fallbackLabel: string;
  onClose: () => void;
}) {
  const api = useUiApi();
  const [value, setValue] = useState(session.title ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const hasTitle = (session.title ?? "").trim().length > 0;
  const placeholder = terminalLabel(session, fallbackLabel);

  const submit = async (nextTitle: string | null) => {
    setSubmitting(true);
    setError(null);
    try {
      await api.renameTerminalLayerSession(session.id, nextTitle);
      onClose();
    } catch (e) {
      const message =
        e instanceof UiApiError ? e.message : (e as Error).message;
      setError(message);
      setSubmitting(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    void submit(trimmed.length === 0 ? null : trimmed);
  };

  return (
    <ModalShell
      testId="terminal-rename-modal"
      ariaLabel="Rename terminal session"
      submitting={submitting}
      onCancel={onClose}
    >
      <form onSubmit={onSubmit}>
        <header className="px-6 pt-6 pb-4 border-b border-[color:var(--hair)]">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--muted-foreground)]">
            Rename terminal
          </span>
          <h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
            Name this session
          </h2>
          <p className="mt-1.5 text-[13px] text-[color:var(--muted-foreground)]">
            A custom name shows wherever this session is listed. Clear it to
            return to automatic labeling.
          </p>
        </header>
        <div className="px-6 py-5 flex flex-col gap-3">
          <label htmlFor="terminal-rename-input" className="flex flex-col gap-1.5">
            <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
              name
            </span>
            <div className="flex items-center gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 focus-within:ring-1 focus-within:ring-[color:var(--ink)]/30">
              <PenLine className="h-3.5 w-3.5 text-[color:var(--muted-foreground)]" />
              <input
                ref={inputRef}
                id="terminal-rename-input"
                type="text"
                value={value}
                maxLength={MAX_TITLE_LENGTH}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={placeholder}
                spellCheck={false}
                autoComplete="off"
                disabled={submitting}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none"
                data-testid="terminal-rename-input"
              />
            </div>
          </label>

          {error && (
            <div
              className="flex items-start gap-2 rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2 text-[13px] text-[color:var(--bad)]"
              data-testid="terminal-rename-error"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--hair)] px-6 py-3.5">
          {hasTitle && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              disabled={submitting}
              onClick={() => void submit(null)}
              data-testid="terminal-rename-clear"
            >
              Clear name
            </Button>
          )}
          <Button
            type="button"
            variant="default"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="solid"
            disabled={submitting}
            data-testid="terminal-rename-confirm"
          >
            {submitting ? <Loader2 className="animate-spin" /> : <PenLine />}
            Save
          </Button>
        </footer>
      </form>
    </ModalShell>
  );
}
