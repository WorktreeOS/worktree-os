import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bolt,
  ChevronRight,
  CornerDownLeft,
  Ellipsis,
  Keyboard,
  Lock,
  PencilLine,
  Send,
  Unlock,
} from "lucide-react";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { terminalAgent } from "@/lib/terminal-agents";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";
import {
  encodeQuickAction,
  TOUCH_TOOL_PROFILES,
  touchTerminalTool,
  type TouchQuickAction,
  type TouchToolAction,
} from "@/lib/touch-terminal";
import { cn } from "@/lib/utils";

export interface TouchQuickActionsProps {
  session: TerminalSessionMetadata;
  isController: boolean;
  canRequestControl: boolean;
  keyboardUp: boolean;
  onSendInput: (data: string) => void;
  onRequestControl: () => void;
  onOpenComposer: () => void;
}

type DockMode = "actions" | "keys";

const MODIFIER_KEYS: ReadonlyArray<{ id: TouchQuickAction; label: string }> = [
  { id: "escape", label: "Esc" },
  { id: "tab", label: "Tab" },
  { id: "ctrl-c", label: "^C" },
  { id: "ctrl-d", label: "^D" },
  { id: "ctrl-l", label: "^L" },
  { id: "ctrl-r", label: "^R" },
];

function activityWord(session: TerminalSessionMetadata): string {
  if (session.agentActivity?.state === "awaiting-input") return "waiting for you";
  if (session.agentActivity?.state === "working") return "working";
  if (session.agentActivity?.state === "idle") return "idle";
  return session.activeCommand?.agent ? "active" : "ready";
}

export function TouchQuickActions({
  session,
  isController,
  canRequestControl,
  keyboardUp,
  onSendInput,
  onRequestControl,
  onOpenComposer,
}: TouchQuickActionsProps) {
  const [mode, setMode] = useState<DockMode>("actions");
  const [commandsOpen, setCommandsOpen] = useState(false);
  const tool = touchTerminalTool(session.activeCommand?.agent);
  const profile = TOUCH_TOOL_PROFILES[tool];
  const agent = terminalAgent(session);

  useEffect(() => {
    if (keyboardUp) setMode("keys");
  }, [keyboardUp]);

  const send = (sequence: string) => {
    if (!isController) {
      if (canRequestControl) onRequestControl();
      return;
    }
    onSendInput(sequence);
  };

  const brandStyle = {
    "--touch-brand": agent?.brand ?? "#9A9A95",
  } as CSSProperties;

  return (
    <div
      data-testid="terminal-touch-quick-actions"
      data-controller={isController ? "true" : "false"}
      data-tool={tool}
      style={brandStyle}
      className="shrink-0 border-t border-white/10 bg-[#131316] px-2.5 pb-[max(10px,env(safe-area-inset-bottom))] pt-2 text-[#ededea]"
    >
      {!isController && (
        <div
          data-testid="terminal-touch-viewer-banner"
          className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11.5px] text-amber-100"
        >
          <span className="flex items-center gap-1.5">
            <Lock className="size-3.5" /> Viewer mode
          </span>
          {canRequestControl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="terminal-touch-request-control"
              className="h-7 border-amber-300/40 bg-transparent text-[11px] text-amber-50 hover:bg-amber-300/10"
              onClick={onRequestControl}
            >
              <Unlock className="mr-1 size-3" /> Take control
            </Button>
          )}
        </div>
      )}

      <div className="mb-2 flex min-h-7 items-center gap-2 px-0.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full bg-[var(--touch-brand)]",
            session.agentActivity?.state === "working" &&
              "animate-pulse shadow-[0_0_0_4px_color-mix(in_srgb,var(--touch-brand)_18%,transparent)]",
          )}
        />
        <span className="truncate text-[12.5px] font-semibold text-[#ededea]">
          {agent?.label ?? session.shell.split("/").pop() ?? profile.label}
        </span>
        <span className="text-white/25">·</span>
        <span className="truncate text-[12px] text-[#b7b7b2]">
          {activityWord(session)}
        </span>
        <div className="ml-auto flex rounded-[9px] border border-white/[.07] bg-white/[.04] p-0.5 md:hidden">
          <ModeButton active={mode === "actions"} onClick={() => setMode("actions")}>
            <Bolt className="size-3" /> Actions
          </ModeButton>
          <ModeButton active={mode === "keys"} onClick={() => setMode("keys")}>
            <Keyboard className="size-3" /> Keys
          </ModeButton>
        </div>
      </div>

      <div className="md:flex md:items-center md:gap-3">
        <div
          className={cn(
            "min-w-0 flex-1",
            mode === "actions" ? "block" : "hidden",
            "md:block",
          )}
        >
          <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {profile.primary.map((action) => (
              <ActionButton
                key={action.id}
                action={action}
                disabled={!isController && !canRequestControl}
                onClick={() => send(action.sequence)}
              />
            ))}
            <button
              type="button"
              onClick={() => setCommandsOpen(true)}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-white/[.085] bg-white/[.05] px-3 text-[12.5px] font-medium text-[#ededea] active:scale-95 active:bg-white/[.12]"
            >
              <Ellipsis className="size-4" /> More
            </button>
          </div>
        </div>
        <div
          className={cn(
            mode === "keys" ? "block" : "hidden",
            "md:block md:shrink-0",
          )}
        >
          <RawKeys keyboardUp={keyboardUp} onSend={send} />
        </div>
      </div>

      <button
        type="button"
        data-testid="terminal-touch-action-write"
        onClick={onOpenComposer}
        className="mt-2 flex h-11 w-full items-center gap-2 rounded-xl border border-white/[.09] bg-black/20 px-2 text-left active:bg-white/[.07]"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg text-[#b7b7b2]">
          <PencilLine className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#7e7e79]">
          {session.agentActivity?.state === "awaiting-input"
            ? "Reply to the agent..."
            : profile.placeholder}
        </span>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--touch-brand)] text-black/80">
          <Send className="size-4" />
        </span>
      </button>

      {commandsOpen && (
        <BottomSheet
          testId="terminal-touch-command-sheet"
          ariaLabel={`${profile.label} commands`}
          onClose={() => setCommandsOpen(false)}
          className="border-white/10 bg-[#131316] text-[#ededea] md:max-w-xl"
        >
          <div className="border-b border-white/[.08] px-4 pb-3 pt-2">
            <div className="text-[15px] font-semibold">{profile.label} commands</div>
            <div className="mt-0.5 text-[11.5px] text-[#7e7e79]">
              Sent directly to the active terminal
            </div>
          </div>
          <div className="overflow-y-auto p-2">
            {profile.commands.map((command) => (
              <button
                key={command.id}
                type="button"
                onClick={() => {
                  send(command.sequence);
                  if (isController) setCommandsOpen(false);
                }}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-white/[.06] active:bg-white/[.1]"
              >
                <span
                  className={cn(
                    "min-w-[5.5rem] font-mono text-[12.5px] text-[#ededea]",
                    command.command && "text-[#f0894b]",
                  )}
                >
                  {command.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[#7e7e79]">
                  {command.description}
                </span>
                <ChevronRight className="size-4 text-white/20" />
              </button>
            ))}
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-[7px] px-2.5 text-[11px] font-medium",
        active ? "bg-white/[.1] text-[#ededea]" : "text-[#7e7e79]",
      )}
    >
      {children}
    </button>
  );
}

function ActionButton({
  action,
  disabled,
  onClick,
}: {
  action: TouchToolAction;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`terminal-touch-tool-action-${action.id}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-white/[.085] bg-white/[.05] px-3 text-[12.5px] font-medium text-[#ededea] active:scale-95 active:bg-white/[.12] disabled:opacity-45",
        action.danger && "border-red-400/25 bg-red-400/[.04] text-[#f2787a]",
        action.command && "font-mono text-[#ededea] first-letter:text-[#f0894b]",
      )}
    >
      {action.label}
      {action.hint && (
        <span className="rounded border border-white/[.12] px-1 py-0.5 font-mono text-[9.5px] text-[#7e7e79]">
          {action.hint}
        </span>
      )}
    </button>
  );
}

function RawKeys({
  keyboardUp,
  onSend,
}: {
  keyboardUp: boolean;
  onSend: (sequence: string) => void;
}) {
  if (keyboardUp) {
    return (
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {MODIFIER_KEYS.map((key) => (
          <KeyButton key={key.id} label={key.label} onClick={() => onSend(encodeQuickAction(key.id))} />
        ))}
        <KeyButton label="Left" icon={<ArrowLeft />} onClick={() => onSend(encodeQuickAction("arrow-left"))} />
        <KeyButton label="Up" icon={<ArrowUp />} onClick={() => onSend(encodeQuickAction("arrow-up"))} />
        <KeyButton label="Down" icon={<ArrowDown />} onClick={() => onSend(encodeQuickAction("arrow-down"))} />
        <KeyButton label="Right" icon={<ArrowRight />} onClick={() => onSend(encodeQuickAction("arrow-right"))} />
        <KeyButton label="Enter" icon={<CornerDownLeft />} emphasized onClick={() => onSend(encodeQuickAction("enter"))} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-0.5 md:justify-end">
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5 md:flex md:flex-none">
        {MODIFIER_KEYS.map((key) => (
          <KeyButton key={key.id} label={key.label} onClick={() => onSend(encodeQuickAction(key.id))} />
        ))}
      </div>
      <div className="grid shrink-0 grid-cols-3 grid-rows-3 gap-1">
        <KeyButton className="col-start-2" label="Up" icon={<ArrowUp />} onClick={() => onSend(encodeQuickAction("arrow-up"))} />
        <KeyButton className="row-start-2" label="Left" icon={<ArrowLeft />} onClick={() => onSend(encodeQuickAction("arrow-left"))} />
        <KeyButton className="col-start-2 row-start-2" label="Enter" icon={<CornerDownLeft />} emphasized onClick={() => onSend(encodeQuickAction("enter"))} />
        <KeyButton className="col-start-3 row-start-2" label="Right" icon={<ArrowRight />} onClick={() => onSend(encodeQuickAction("arrow-right"))} />
        <KeyButton className="col-start-2 row-start-3" label="Down" icon={<ArrowDown />} onClick={() => onSend(encodeQuickAction("arrow-down"))} />
      </div>
    </div>
  );
}

function KeyButton({
  label,
  icon,
  emphasized,
  className,
  onClick,
}: {
  label: string;
  icon?: ReactElement;
  emphasized?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={`terminal-touch-action-${label.toLowerCase()}`}
      onClick={onClick}
      className={cn(
        "flex h-10 min-w-11 items-center justify-center rounded-xl border border-white/[.085] bg-white/[.05] px-2 font-mono text-[11.5px] text-[#ededea] active:scale-95 active:bg-white/[.12] [&_svg]:size-4",
        emphasized && "border-[color-mix(in_srgb,var(--touch-brand)_42%,transparent)] bg-[color-mix(in_srgb,var(--touch-brand)_18%,transparent)] text-[var(--touch-brand)]",
        className,
      )}
    >
      {icon ?? label}
    </button>
  );
}
