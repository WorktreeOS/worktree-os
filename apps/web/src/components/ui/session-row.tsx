import { PenLine, Terminal as TerminalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Ic } from "@/components/ui/inline-code";
import { StatusDot } from "@/components/ui/status-dot";
import {
  agentActivityDotVariant,
  agentActivityWord,
} from "@/components/ui/terminal-session-row";
import {
  contextPercent,
  formatTokenCount,
  hasMeaningfulTelemetry,
  shortModelName,
  telemetryTooltip,
} from "@/lib/agent-telemetry";
import { terminalAgent, terminalLabel } from "@/lib/terminal-agents";
import { cn } from "@/lib/utils";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";

/* SessionRow — one open terminal session in the dossier's Sessions section
 * (see demo/worktree-page-v3.html `.session`): an agent glyph (brand-tinted for
 * a detected Claude Code / Codex / OpenCode CLI, otherwise a neutral shell
 * glyph), the agent/shell name with its active command, a live/exited state
 * with session age, and a primary `Attach` that opens the session in the
 * right-side Terminal panel. Answers "where is my agent" — this never appears
 * in the Runtime panel. */

function formatAge(createdAt: string): string {
  const diff = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(diff) || diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sessionCommand(session: TerminalSessionMetadata): string {
  const cmd = session.activeCommand;
  if (!cmd) return "";
  return [cmd.command, cmd.args].filter(Boolean).join(" ").trim();
}

export function SessionRow({
  session,
  onAttach,
  onRename,
  className,
}: {
  session: TerminalSessionMetadata;
  onAttach: () => void;
  /** Open the rename control for this session. Omitted where unsupported. */
  onRename?: () => void;
  className?: string;
}) {
  const agent = terminalAgent(session);
  const live = session.status === "running" || session.status === "creating";
  const Icon = agent?.icon ?? TerminalIcon;
  // A user title wins over the agent/shell label; falls back to the shell name.
  const who = terminalLabel(session, session.shell);
  const command = sessionCommand(session);
  const age = formatAge(session.createdAt);
  // Agent activity (from agent-side plugins) replaces the plain lifecycle
  // wording while the session is live.
  const activity = live ? session.agentActivity : undefined;
  const unread = Boolean(session.unreadSince);

  return (
    <div
      data-testid="session-row"
      data-session-id={session.id}
      data-agent={session.activeCommand?.agent ?? "shell"}
      className={cn(
        "flex items-center gap-3 border-t border-[color:var(--hair)] py-[11px] first:border-t-0",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-[26px] shrink-0 place-items-center rounded-[7px]",
          !agent &&
            "bg-[color:var(--chip-bg)] text-[color:var(--muted-foreground)]",
        )}
        style={
          agent && !agent.fullColor ? { background: agent.brand } : undefined
        }
      >
        {/* A full-color mark carries its own field, so it fills the badge
            instead of sitting white-on-brand. */}
        <Icon
          className={agent?.fullColor ? "size-[26px]" : "size-3.5"}
          strokeWidth={1.75}
          style={
            agent && !agent.fullColor ? { color: "#fff" } : undefined
          }
        />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "truncate text-[13.5px] text-[color:var(--ink)]",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {who}
          </span>
          {command ? (
            <span className="truncate font-mono text-[12px] text-[color:var(--muted-foreground)]">
              {command}
            </span>
          ) : null}
        </div>
        <span className="truncate text-[12.5px] text-[color:var(--muted-foreground)]">
          {agent ? (
            <>
              <Ic className="!py-0">{session.shell}</Ic>
              <span className="opacity-50"> · </span>
            </>
          ) : null}
          {activity?.question?.summary ? (
            <>
              <span
                data-testid="session-question"
                className="text-[#F59E0B]"
                title={activity.question.summary}
              >
                {activity.question.summary}
              </span>
              <span className="opacity-50"> · </span>
            </>
          ) : null}
          {session.status}
          {session.processId !== undefined ? (
            <>
              <span className="opacity-50"> · </span>
              pid <span className="tabular-nums">{session.processId}</span>
            </>
          ) : null}
          {live &&
          session.agentTelemetry &&
          hasMeaningfulTelemetry(session.agentTelemetry) ? (
            <>
              <span className="opacity-50"> · </span>
              <span
                data-testid="session-telemetry"
                title={telemetryTooltip(session.agentTelemetry)}
                className="tabular-nums"
              >
                {session.agentTelemetry.model
                  ? `${shortModelName(session.agentTelemetry.model)} · `
                  : ""}
                {formatTokenCount(session.agentTelemetry.mainTokens)} tokens ·{" "}
                {contextPercent(session.agentTelemetry)}% ctx
              </span>
            </>
          ) : null}
        </span>
      </div>

      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 text-[12px]",
          activity?.state === "awaiting-input"
            ? "text-[#F59E0B]"
            : "text-[color:var(--ink-2)]",
        )}
      >
        <StatusDot
          variant={
            activity
              ? agentActivityDotVariant(activity.state)
              : live
                ? "run"
                : "stopped"
          }
        />
        {activity
          ? `${agentActivityWord(activity.state)} · ${age}`
          : live
            ? `running · ${age}`
            : "exited"}
      </span>

      {/* Unread modifier — small filled blue trailing dot (mail-client style). */}
      {unread && (
        <span
          data-testid="session-unread"
          aria-label="Unread output"
          className="size-1.5 shrink-0 rounded-full bg-[color:var(--unread)]"
        />
      )}

      {onRename && (
        <IconButton
          size="sm"
          onClick={onRename}
          aria-label="Rename session"
          title="Rename session"
          data-testid="session-rename"
        >
          <PenLine strokeWidth={1.75} />
        </IconButton>
      )}
      <Button size="sm" onClick={onAttach} data-testid="session-attach">
        Attach
      </Button>
    </div>
  );
}
