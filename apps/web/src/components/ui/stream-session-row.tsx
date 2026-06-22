import { ArrowRight, CircleAlert, Plus, Terminal as TerminalIcon, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { hasMeaningfulTelemetry } from "@/lib/agent-telemetry";
import { TelemetryCluster } from "@/components/ui/telemetry-cluster";
import { ProjectTile } from "@/components/ui/project-tile";
import { terminalAgent, terminalLabel } from "@/lib/terminal-agents";
import type { ProjectTileIdentity } from "@/lib/project-identity";
import type { TerminalSessionMetadata } from "@/lib/terminal-protocol";

/* StreamSessionRow — one live session in the rail's Sessions-mode stream (see
 * demo/sidebar-stream-v3.html). The group above states the state, so the row
 * carries no leading status dot. What's left is the project identity tile + the
 * agent glyph on line 1, and the worktree (+ command, for shells) with the
 * shared telemetry cluster on line 2; an awaiting-input session adds an amber
 * permission line. The working state animates the tile itself (no spinner).
 *
 *   [tile] glyph Title ·············· age / unread dot / actions
 *          worktree (· cmd) ········· [meter] 57k · 175k
 *          ⚠ permission question (amber)            (awaiting-input only)
 *
 * Touch affordances mirror TerminalSessionRow: Attach stays inline on touch,
 * the full action set (attach · new-here · kill) reveals on hover on desktop. */

/** ISO timestamp → compact age, matching TerminalSessionRow's formatSessionAge. */
function formatAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
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

interface StreamSessionRowProps {
  session: TerminalSessionMetadata;
  /** Deterministic project identity (color + monogram) for the tile. */
  tile: ProjectTileIdentity;
  /** Worktree/branch label shown on line 2. */
  worktreeName: string;
  onAttach: () => void;
  /** Start another session in the same worktree. */
  onNewHere: () => void;
  onKill: () => void;
  touch?: boolean;
  /** Currently focused in the open Terminal panel — render as selected. */
  active?: boolean;
}

export function StreamSessionRow({
  session,
  tile,
  worktreeName,
  onAttach,
  onNewHere,
  onKill,
  touch = false,
  active = false,
}: StreamSessionRowProps) {
  const agent = terminalAgent(session);
  const live = session.status === "running" || session.status === "creating";
  const activity = live ? session.agentActivity : undefined;
  const working = activity?.state === "working";
  const awaitingInput = activity?.state === "awaiting-input";
  const Icon = agent?.icon ?? TerminalIcon;
  const label = terminalLabel(session, session.shell);
  const unread = Boolean(session.unreadSince);
  // Idle group: not blocked, not unread, not actively working (idle agents and
  // plain shells). These rows are de-emphasised until hover — but never the
  // currently attached session, which always reads at full strength.
  const dim = !active && !awaitingInput && !unread && !working;

  const rawTelemetry = live ? session.agentTelemetry : undefined;
  const telemetry =
    rawTelemetry && hasMeaningfulTelemetry(rawTelemetry) ? rawTelemetry : undefined;
  const command = agent ? undefined : sessionCommand(session);
  const question = awaitingInput ? activity?.question : undefined;

  // Trailing age — amber "waiting" for blocked, "idle" prefix for idle agents.
  let ageText: string;
  if (awaitingInput) {
    ageText = `waiting ${formatAge(question?.askedAt ?? activity?.at ?? session.createdAt)}`;
  } else if (activity?.state === "idle") {
    ageText = `idle ${formatAge(session.agentTelemetry?.updatedAt ?? activity.at ?? session.createdAt)}`;
  } else {
    ageText = formatAge(session.createdAt);
  }

  const actSize = touch ? "size-9" : "size-6";
  const actIcon = touch ? "[&_svg]:size-[18px]" : "[&_svg]:size-3.5";
  const actBase = cn(
    "grid place-items-center rounded-md text-[color:var(--muted-foreground)]",
    "transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)]",
    "hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
    actSize,
    actIcon,
  );

  return (
    <div
      data-testid="rail-stream-session"
      data-session-id={session.id}
      data-agent={session.activeCommand?.agent ?? undefined}
      data-active={active ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group/srow relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] transition-[background-color,opacity]",
        touch ? "px-2.5 py-2" : "px-2 py-1.5",
        active
          ? "bg-sidebar-active shadow-[inset_0_0_0_1px_var(--hair-2)]"
          : awaitingInput
            ? "bg-[color-mix(in_oklch,#F59E0B_8%,transparent)]"
            : "hover:bg-sidebar-hover",
        dim && "opacity-60 hover:opacity-100",
      )}
      onClick={onAttach}
    >
      <ProjectTile
        monogram={tile.monogram}
        colorVar={tile.colorVar}
        working={working}
        size={touch ? 30 : 26}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* line 1 — glyph + name + trailing age / unread / actions. Fixed
            height matches the action buttons so the row doesn't grow on hover. */}
        <div className={cn("flex min-w-0 items-center gap-[7px]", touch ? "h-9" : "h-6")}>
          <Icon
            className={cn("shrink-0", touch ? "size-[17px]" : "size-[15px]")}
            strokeWidth={1.75}
            style={agent ? { color: agent.brand } : undefined}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              unread
                ? "font-semibold text-[color:var(--ink)]"
                : active
                  ? "font-medium text-[color:var(--ink)]"
                  : "font-medium text-[color:var(--ink-2)]",
              touch ? "text-[14.5px]" : "text-[13px]",
            )}
          >
            {label}
          </span>

          {/* Resting trailing — hidden on hover (desktop) to make room for the
              actions. Unread shows a filled blue dot instead of the age. */}
          {unread ? (
            <span
              data-testid="rail-stream-unread"
              aria-label="Unread output"
              className={cn(
                "shrink-0 rounded-full bg-[color:var(--unread)]",
                touch ? "size-2" : "size-1.5 group-hover/srow:hidden",
              )}
            />
          ) : (
            <span
              className={cn(
                "shrink-0 tabular-nums",
                awaitingInput
                  ? "font-medium text-[#F59E0B]"
                  : "font-mono text-[color:var(--muted-foreground)]",
                touch
                  ? "hidden text-[12.5px]"
                  : "text-[11px] group-hover/srow:hidden",
              )}
            >
              {ageText}
            </span>
          )}

          {/* Actions — revealed on hover (desktop), Attach inline on touch. */}
          {live && (
            <div
              className={cn(
                "shrink-0 items-center gap-0.5",
                touch ? "flex" : "hidden group-hover/srow:flex",
              )}
            >
              <button
                type="button"
                title="Attach"
                aria-label="Attach to session"
                data-testid="rail-stream-attach"
                onClick={(e) => {
                  e.stopPropagation();
                  onAttach();
                }}
                className={actBase}
              >
                <ArrowRight strokeWidth={1.75} />
              </button>
              {!touch && (
                <button
                  type="button"
                  title={`New session in ${worktreeName}`}
                  aria-label="New session in this worktree"
                  data-testid="rail-stream-new-here"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewHere();
                  }}
                  className={actBase}
                >
                  <Plus strokeWidth={1.75} />
                </button>
              )}
              {!touch && (
                <button
                  type="button"
                  title="Kill"
                  aria-label="Kill session"
                  data-testid="rail-stream-kill"
                  onClick={(e) => {
                    e.stopPropagation();
                    onKill();
                  }}
                  className={cn(
                    "grid place-items-center rounded-md text-[color:var(--muted-foreground)]",
                    "transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--bad)]",
                    "hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
                    actSize,
                    actIcon,
                  )}
                >
                  <X strokeWidth={1.75} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* line 2 — worktree (+ command for shells) on the left, telemetry
            cluster on the right. */}
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            touch ? "text-[12px]" : "text-[11.5px]",
          )}
        >
          <span className="min-w-0 truncate font-mono text-[color:var(--muted-foreground)]">
            {worktreeName}
            {command && (
              <>
                <span className="text-[color:var(--hair-2)]"> · </span>
                <span className="text-[color:var(--muted-foreground)]">{command}</span>
              </>
            )}
          </span>
          {telemetry && <TelemetryCluster telemetry={telemetry} touch={touch} />}
        </div>

        {/* permission / question line — awaiting-input rows only. */}
        {question && (
          <div
            data-testid="rail-stream-question"
            className={cn(
              "flex min-w-0 items-center gap-1.5 font-medium text-[#F59E0B]",
              touch ? "text-[12px]" : "text-[11.5px]",
            )}
          >
            <CircleAlert className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 truncate">{question.summary}</span>
          </div>
        )}
      </div>
    </div>
  );
}
