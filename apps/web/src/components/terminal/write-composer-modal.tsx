/**
 * Write composer modal for touch terminal sessions.
 *
 * The composer lets touch users compose multi-line terminal input outside the
 * xterm viewport. Typing in the editor never reaches the PTY — submission is
 * explicit and chooses one of three send modes:
 *
 * - Insert: send the draft as typed, no Enter appended.
 * - Send: send the draft followed by `\r`.
 * - Paste: wrap with bracketed-paste markers so receiving programs treat the
 *   block atomically and preserve line breaks.
 *
 * Submission is gated by controller ownership; viewer-only attachments keep
 * their draft and can request control from inside the modal.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Lock, Send, Unlock, X } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  encodeComposerSubmission,
  type ComposerSendMode,
} from "@/lib/touch-terminal";

export interface WriteComposerModalProps {
  open: boolean;
  initialDraft?: string;
  isController: boolean;
  canRequestControl: boolean;
  onClose: () => void;
  onSend: (data: string) => void;
  onRequestControl: () => void;
  /** Notify parent of draft changes so it can persist between opens. */
  onDraftChange?: (draft: string) => void;
}

interface ModeDescriptor {
  id: ComposerSendMode;
  label: string;
  hint: string;
}

const SEND_MODES: ModeDescriptor[] = [
  { id: "insert", label: "Insert", hint: "Send text without Enter" },
  { id: "send", label: "Send", hint: "Send text followed by Enter" },
  { id: "paste", label: "Paste", hint: "Send as multiline paste" },
];

export function WriteComposerModal({
  open,
  initialDraft = "",
  isController,
  canRequestControl,
  onClose,
  onSend,
  onRequestControl,
  onDraftChange,
}: WriteComposerModalProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [mode, setMode] = useState<ComposerSendMode>("send");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-seed the draft when the modal reopens with a different starting value
  // (e.g. parent preserved it through a viewer/controller transition).
  useEffect(() => {
    if (open) setDraft(initialDraft);
  }, [open, initialDraft]);

  useLayoutEffect(() => {
    if (!open) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  const submitDisabled = draft.length === 0 || !isController;

  const handleSubmit = () => {
    if (!isController || draft.length === 0) return;
    onSend(encodeComposerSubmission(draft, mode));
    setDraft("");
    onDraftChange?.("");
    onClose();
  };

  const handleDraftChange = (next: string) => {
    setDraft(next);
    onDraftChange?.(next);
  };

  return (
    <ModalShell
      testId="terminal-write-composer"
      ariaLabel="Terminal write composer"
      submitting={false}
      onCancel={onClose}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-muted-foreground">
            terminal · compose
          </div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight">
            Write to terminal
          </h2>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={onClose}
          aria-label="Close composer"
          data-testid="terminal-write-composer-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {!isController && (
        <div
          data-testid="terminal-write-composer-viewer-banner"
          className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-[12px] text-amber-200"
        >
          <span className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5" />
            Viewer mode — draft preserved.
          </span>
          {canRequestControl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="terminal-write-composer-request-control"
              className="h-7 border-amber-400/50 bg-transparent text-[11px] text-amber-100 hover:bg-amber-400/10"
              onClick={onRequestControl}
            >
              <Unlock className="mr-1 h-3 w-3" />
              Take control
            </Button>
          )}
        </div>
      )}
      <div className="px-5 py-3">
        <textarea
          ref={textareaRef}
          autoFocus
          value={draft}
          onChange={(e) => handleDraftChange(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          data-testid="terminal-write-composer-textarea"
          placeholder="Type or paste text to send…"
          className="block min-h-[160px] w-full resize-y rounded-md border border-border bg-black/40 px-3 py-2 font-mono text-[13px] leading-5 text-foreground outline-none focus:border-border focus:ring-1 focus:ring-foreground/20"
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-5 py-3">
        <div
          role="radiogroup"
          aria-label="Send mode"
          className="flex items-center gap-1 rounded-md border border-border bg-background/40 p-0.5"
        >
          {SEND_MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={m.hint}
                data-testid={`terminal-write-composer-mode-${m.id}`}
                onClick={() => setMode(m.id)}
                className={cn(
                  "h-8 rounded px-2.5 text-[12px] transition-colors",
                  active
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-9"
            onClick={onClose}
            data-testid="terminal-write-composer-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="h-9"
            disabled={submitDisabled}
            onClick={handleSubmit}
            data-testid="terminal-write-composer-submit"
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {modeButtonLabel(mode)}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

function modeButtonLabel(mode: ComposerSendMode): string {
  switch (mode) {
    case "insert":
      return "Insert";
    case "send":
      return "Send";
    case "paste":
      return "Paste";
  }
}
