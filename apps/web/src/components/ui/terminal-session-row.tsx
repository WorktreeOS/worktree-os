import type { CSSProperties, Ref } from "react";
import {
  ArrowRight,
  CircleAlert,
  GripVertical,
  PenLine,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  hasMeaningfulTelemetry,
  shortModelName,
} from "@/lib/agent-telemetry";
import { TelemetryCluster } from "@/components/ui/telemetry-cluster";
import { terminalAgent, terminalLabel } from "@/lib/terminal-agents";
import type {
  AgentActivityState,
  TerminalSessionMetadata,
} from "@/lib/terminal-protocol";
import {
  StatusDot,
  StatusSpinner,
  type StatusDotVariant,
} from "@/components/ui/status-dot";

/** Dot variant for an agent activity state (quiet-workspace: dot + word). */
export function agentActivityDotVariant(
  state: AgentActivityState,
): StatusDotVariant {
  switch (state) {
    case "awaiting-input":
      return "partial";
    case "working":
      return "run";
    case "idle":
    default:
      return "idle";
  }
}

/** Inline word shown next to the dot for an agent activity state. */
export function agentActivityWord(state: AgentActivityState): string {
  switch (state) {
    case "awaiting-input":
      return "waiting for you";
    case "working":
      return "working";
    case "idle":
    default:
      return "idle";
  }
}

/* TerminalSessionRow — one session row with no project tile, for contexts
 * where the surrounding structure already establishes the worktree (the v4
 * rail tree's session children — see demo/sidebar-worktree-tree-v4.html).
 * Two/three lines so an agent session can carry its telemetry without a
 * tooltip:
 *
 *   line 1 — a leading status object (hollow dot = idle, brand-tinted spinner
 *     = working, amber dot = awaiting input, hollow muted = exited) + the agent
 *     glyph (brand-tinted) or shell glyph + the name. Trailing: the session age,
 *     OR a small filled blue dot when unread, OR Attach / Kill on hover (Attach
 *     stays inline on touch).
 *   line 2 — for agent sessions: the model on the left and a pinned telemetry
 *     cluster on the right (context meter + context tokens in use + total token
 *     spend; the meter/context count turn red past the warn threshold). For
 *     plain shells: the active command, no telemetry cluster.
 *   line 3 — an amber permission/question line, awaiting-input sessions only
 *     (mirrors StreamSessionRow's question line).
 *
 * Exited / killed sessions render de-emphasised with a hollow dot. */

function formatSessionAge(createdAt: string): string {
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

interface TerminalSessionRowProps {
  session: TerminalSessionMetadata;
  onAttach: () => void;
  onKill: () => void;
  /** Open the rename control for this session. Omitted where unsupported. */
  onRename?: () => void;
  touch?: boolean;
  /** Currently focused in the open Terminal panel — render as selected. */
  active?: boolean;
  /** Sortable wiring for rail reorder. Omit all three to render a plain,
   * non-draggable row (the resting appearance is identical either way). When
   * `dragHandleProps` is present, a grip handle is revealed on hover (desktop)
   * / shown always (touch); it carries the drag listeners so a tap on the row
   * body still attaches and finger-scroll over the body is never hijacked. */
  rootRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
}

export function TerminalSessionRow({
  session,
  onAttach,
  onKill,
  onRename,
  touch = false,
  active = false,
  rootRef,
  style,
  dragHandleProps,
  isDragging = false,
}: TerminalSessionRowProps) {
  const agent = terminalAgent(session);
  const live = session.status === "running" || session.status === "creating";
  // Agent activity (from agent-side plugins) takes precedence over the plain
  // PTY lifecycle presentation while the session is live.
  const activity = live ? session.agentActivity : undefined;
  const working = activity?.state === "working";
  const awaitingInput = activity?.state === "awaiting-input";
  const question = awaitingInput ? activity?.question : undefined;
  const Icon = agent?.icon ?? TerminalIcon;
  // A user title wins over the agent/shell label; falls back to the shell name.
  const label = terminalLabel(session, session.shell);
  const unread = Boolean(session.unreadSince);

  // line 2 — agents carry telemetry; plain shells carry their command.
  // An all-zero block (e.g. just after /clear) is treated as no telemetry.
  const rawTelemetry = live ? session.agentTelemetry : undefined;
  const telemetry =
    rawTelemetry && hasMeaningfulTelemetry(rawTelemetry)
      ? rawTelemetry
      : undefined;
  const command = agent ? undefined : sessionCommand(session);
  // Left side of line 2: the model for an agent, otherwise the shell command.
  const subtitle = telemetry?.model
    ? shortModelName(telemetry.model)
    : command || undefined;
  const hasMeta = Boolean(subtitle || telemetry);

  // The action buttons match line 1's fixed height exactly (24px desktop /
  // 36px touch), so swapping the resting age/unread for the hover actions
  // never changes the row height — no jump on hover.
  const actSize = touch ? "size-9" : "size-6";
  const actIcon = touch ? "[&_svg]:size-[18px]" : "[&_svg]:size-3.5";

  return (
    <div
      ref={rootRef}
      style={style}
      data-testid="rail-terminal-session"
      data-session-id={session.id}
      data-agent={session.activeCommand?.agent ?? undefined}
      data-active={active ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group/sess relative flex w-full cursor-pointer items-start gap-2 rounded-lg transition-colors",
        touch ? "px-3.5 py-2" : "px-2 py-1.5",
        // `--sidebar-active` == `--hover`, so a selected row needs more than a
        // fill to read as selected: pair it with a hairline inset ring.
        active
          ? "bg-sidebar-active shadow-[inset_0_0_0_1px_var(--hair-2)]"
          : awaitingInput
            ? "bg-[color-mix(in_oklch,#F59E0B_8%,transparent)]"
            : "hover:bg-sidebar-hover",
        !live && "opacity-50",
        isDragging && "opacity-60",
      )}
      onClick={onAttach}
    >
      {/* Drag grip — absolutely placed in the left tree-line gutter so the
          resting row is unchanged. Revealed on hover (desktop), always shown on
          touch. It alone carries the drag listeners and `touch-none`, so the
          row body still scrolls under a finger and a plain tap still attaches. */}
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          data-testid="rail-terminal-grip"
          aria-label="Reorder session"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "absolute inset-y-0 left-0 z-10 flex cursor-grab touch-none items-center justify-center text-[color:var(--muted-foreground)] active:cursor-grabbing",
            touch ? "-translate-x-[18px] w-4" : "-translate-x-[14px] w-3.5 opacity-0 group-hover/sess:opacity-100",
          )}
        >
          <GripVertical
            className={touch ? "size-[15px]" : "size-3.5"}
            strokeWidth={1.75}
            aria-hidden
          />
        </span>
      )}

      {/* Leading status object — a brand-tinted spinner while working, else the
          activity / lifecycle dot. Fixed to line 1's height so it stays
          centred against the name and never shifts on hover. */}
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          touch ? "h-9 w-4" : "h-6 w-[14px]",
        )}
      >
        {working ? (
          <StatusSpinner
            size={touch ? 13 : 11}
            color={agent?.brand}
            title={activity?.question?.summary}
          />
        ) : (
          <StatusDot
            variant={
              activity
                ? agentActivityDotVariant(activity.state)
                : live
                  ? "run"
                  : "stopped"
            }
            size={touch ? 9 : 7}
            title={activity?.question?.summary}
          />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* line 1 — glyph + name + trailing age / unread / actions. Fixed
            height matches the action buttons, so the row doesn't grow on hover. */}
        <div
          className={cn(
            "flex min-w-0 items-center gap-[7px]",
            touch ? "h-9" : "h-6",
          )}
        >
          <Icon
            className={cn("shrink-0", touch ? "size-[17px]" : "size-3.5")}
            strokeWidth={1.75}
            style={agent ? { color: agent.brand } : undefined}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              unread && "font-semibold text-[color:var(--ink)]",
              !unread &&
                (active
                  ? "font-medium text-[color:var(--ink)]"
                  : "text-[color:var(--ink-2)]"),
              touch ? "text-[14.5px]" : "text-[12.5px]",
            )}
          >
            {label}
          </span>

          {/* Resting trailing — hidden on hover (desktop) to make room for the
              actions. Unread shows a filled blue dot instead of the age. */}
          {unread ? (
            <span
              data-testid="rail-terminal-unread"
              aria-label="Unread output"
              className={cn(
                "shrink-0 rounded-full bg-[color:var(--unread)]",
                touch ? "size-2" : "size-1.5 group-hover/sess:hidden",
              )}
            />
          ) : (
            <span
              className={cn(
                "shrink-0 font-mono tabular-nums",
                activity?.state === "awaiting-input"
                  ? "text-[#F59E0B]"
                  : "text-[color:var(--muted-foreground)]",
                touch
                  ? "hidden text-[12.5px]"
                  : "text-[11px] group-hover/sess:hidden",
              )}
            >
              {live ? formatSessionAge(session.createdAt) : "exited"}
            </span>
          )}

          {/* Actions — revealed on hover (desktop), Attach inline on touch. */}
          {live && (
            <div
              className={cn(
                "shrink-0 items-center gap-0.5",
                touch ? "flex" : "hidden group-hover/sess:flex",
              )}
            >
              <button
                type="button"
                title="Attach"
                aria-label="Attach to session"
                data-testid="rail-terminal-attach"
                onClick={(e) => {
                  e.stopPropagation();
                  onAttach();
                }}
                className={cn(
                  "grid place-items-center rounded-md text-[color:var(--muted-foreground)]",
                  "transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)]",
                  "hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
                  actSize,
                  actIcon,
                )}
              >
                <ArrowRight strokeWidth={1.75} />
              </button>
              {!touch && onRename && (
                <button
                  type="button"
                  title="Rename"
                  aria-label="Rename session"
                  data-testid="rail-terminal-rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename();
                  }}
                  className={cn(
                    "grid place-items-center rounded-md text-[color:var(--muted-foreground)]",
                    "transition-colors hover:bg-[color:var(--surface)] hover:text-[color:var(--ink)]",
                    "hover:shadow-[inset_0_0_0_1px_var(--hair-2)]",
                    actSize,
                    actIcon,
                  )}
                >
                  <PenLine strokeWidth={1.75} />
                </button>
              )}
              {!touch && (
                <button
                  type="button"
                  title="Kill"
                  aria-label="Kill session"
                  data-testid="rail-terminal-kill"
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

        {/* line 2 — model / command on the left, telemetry cluster on the
            right. Omitted entirely when there is nothing to report. */}
        {hasMeta && (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2 font-mono tabular-nums text-[color:var(--muted-foreground)]",
              touch ? "text-[12px]" : "text-[10.5px]",
            )}
          >
            {subtitle && <span className="min-w-0 flex-1 truncate">{subtitle}</span>}
            {telemetry && <TelemetryCluster telemetry={telemetry} touch={touch} />}
          </div>
        )}

        {/* permission / question line — awaiting-input rows only. */}
        {question && (
          <div
            data-testid="rail-terminal-question"
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
