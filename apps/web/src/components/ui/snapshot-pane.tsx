import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { StatusDot, StatusSpinner } from "@/components/ui/status-dot";
import { computePaneLayout, type GeometryMode } from "@/lib/mission-control/geometry";
import { renderSnapshotToHtml } from "@/lib/mission-control/ansi-to-dom";
import type { PaneModel } from "@/lib/mission-control/pane-model";
import type { SnapshotFrame } from "@/lib/mission-control/snapshot-stream";
import {
  contextPercent,
  formatTokenCount,
  hasMeaningfulTelemetry,
  shortModelName,
  telemetryTooltip,
} from "@/lib/agent-telemetry";
import type { AgentTelemetry } from "@/lib/terminal-protocol";

const AMBER = "#F59E0B";

/** Track an element's content box (width + height) via ResizeObserver. The
 * callback ref MUST be stable (memoized) and state updates MUST bail when the
 * size is unchanged — otherwise React re-attaches the ref every commit and the
 * resulting setState storms into "Maximum update depth exceeded". */
function useElementSize(): {
  ref: (el: HTMLElement | null) => void;
  size: { width: number; height: number };
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const obsRef = useRef<ResizeObserver | null>(null);

  const apply = useCallback((width: number, height: number) => {
    setSize((prev) =>
      prev.width === width && prev.height === height
        ? prev
        : { width, height },
    );
  }, []);

  const ref = useCallback(
    (el: HTMLElement | null) => {
      obsRef.current?.disconnect();
      obsRef.current = null;
      if (!el) return;
      apply(el.clientWidth, el.clientHeight);
      if (typeof ResizeObserver !== "undefined") {
        const obs = new ResizeObserver((entries) => {
          const r = entries[0]?.contentRect;
          if (r) apply(r.width, r.height);
        });
        obs.observe(el);
        obsRef.current = obs;
      }
    },
    [apply],
  );

  useEffect(() => () => obsRef.current?.disconnect(), []);
  return { ref, size };
}

export interface SnapshotPaneProps {
  pane: PaneModel;
  frame?: SnapshotFrame;
  geometry: GeometryMode;
  projectName: string;
  branchLabel: string;
  onFocus: () => void;
}

/**
 * One Mission Control wall pane: agent identity + project/branch chrome over a
 * live screen-snapshot thumbnail. The single amber accent marks awaiting-input;
 * every other state reads as a leading dot + word. Backends with no screen grid
 * render a metadata-only fallback. Clicking focuses the pane (full attach).
 */
export function SnapshotPane({
  pane,
  frame,
  geometry,
  projectName,
  branchLabel,
  onFocus,
}: SnapshotPaneProps) {
  const { ref: bodyRef, size } = useElementSize();
  const AgentIcon = pane.agent?.icon ?? TerminalIcon;

  const snapshot = frame?.snapshot.available ? frame.snapshot.snapshot : null;
  const telemetry =
    pane.session.agentTelemetry &&
    hasMeaningfulTelemetry(pane.session.agentTelemetry)
      ? pane.session.agentTelemetry
      : null;

  const rendered = useMemo(() => {
    if (!snapshot || size.width === 0 || size.height === 0) return null;
    const layout = computePaneLayout(
      geometry,
      { cols: snapshot.cols, rows: snapshot.rows },
      { width: size.width, height: size.height },
    );
    const visible = snapshot.lines.slice(
      layout.visibleRows.start,
      layout.visibleRows.end,
    );
    return { layout, html: renderSnapshotToHtml(visible) };
  }, [snapshot, geometry, size.width, size.height]);

  const justify =
    rendered?.layout.anchor === "bottom"
      ? "flex-end"
      : rendered?.layout.anchor === "top"
        ? "flex-start"
        : "center";

  return (
    <button
      type="button"
      onClick={onFocus}
      data-testid="mc-pane"
      data-session-id={pane.id}
      data-state={pane.state}
      title={`${pane.label} · ${projectName} · ${branchLabel}`}
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-[color:var(--surface)] text-left transition-shadow",
        pane.awaitingInput
          ? "border-transparent"
          : "border-[color:var(--hair)] hover:border-[color:var(--hair-2)]",
      )}
      style={
        pane.awaitingInput
          ? { boxShadow: `inset 0 0 0 1.5px ${AMBER}` }
          : undefined
      }
    >
      {/* Header chrome */}
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-1.5">
        <AgentIcon
          className="size-[15px] shrink-0"
          strokeWidth={1.75}
          style={pane.agent ? { color: pane.agent.brand } : undefined}
          aria-hidden
        />
        <span
          className={cn(
            "min-w-0 shrink-0 max-w-[42%] truncate text-[12px] text-[color:var(--ink)]",
            pane.unread && "font-semibold",
          )}
        >
          {pane.label}
        </span>
        {pane.unread && (
          <span
            className="size-[5px] shrink-0 rounded-full bg-[color:var(--unread)]"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[color:var(--muted-foreground)]">
          {branchLabel}
        </span>
        <PaneStatus pane={pane} />
      </div>

      {/* Awaiting-input question summary (the single amber accent line) */}
      {pane.awaitingInput && pane.question && (
        <div
          className="shrink-0 truncate px-2.5 pb-1 text-[11.5px]"
          style={{ color: AMBER }}
          data-testid="mc-pane-question"
        >
          {pane.question}
        </div>
      )}

      {/* Snapshot body (dark terminal thumbnail) or metadata fallback */}
      <div
        ref={bodyRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        style={{ display: "flex", flexDirection: "column", justifyContent: justify }}
      >
        {rendered ? (
          <pre
            className="m-0 w-full overflow-hidden"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: `${rendered.layout.fontSize}px`,
              lineHeight: 1.2,
              color: "#E6E6E6",
              whiteSpace: "pre",
            }}
            // Snapshot HTML is produced by our own SGR→DOM renderer, which
            // HTML-escapes all text content and emits only style attributes.
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        ) : (
          <PaneFallback pane={pane} loading={!frame} />
        )}
      </div>

      {/* Agent telemetry footer: model · tokens · context (when bound) */}
      {telemetry && <PaneTelemetry telemetry={telemetry} />}
    </button>
  );
}

/** Quiet telemetry strip: model, cumulative tokens, and context fullness. */
function PaneTelemetry({ telemetry }: { telemetry: AgentTelemetry }) {
  const pct = contextPercent(telemetry);
  const totalTokens = telemetry.mainTokens + telemetry.subagentTokens;
  return (
    <div
      title={telemetryTooltip(telemetry)}
      data-testid="mc-pane-telemetry"
      className="flex shrink-0 items-center gap-2 border-t border-[color:var(--hair)] px-2.5 py-1 font-mono text-[10px] text-[color:var(--muted-foreground)]"
    >
      {telemetry.model && (
        <span className="min-w-0 truncate text-[color:var(--ink-2)]">
          {shortModelName(telemetry.model)}
        </span>
      )}
      <span className="shrink-0">{formatTokenCount(totalTokens)} tok</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* Tiny context-fullness bar. */}
        <span className="relative inline-block h-[3px] w-8 overflow-hidden rounded-full bg-[color:var(--hair-2)]">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--muted-foreground)]"
            style={{ width: `${pct}%` }}
          />
        </span>
        ctx {pct}%
      </span>
    </div>
  );
}

/** Leading dot + word, or the amber awaiting/working accent. */
function PaneStatus({ pane }: { pane: PaneModel }) {
  if (pane.state === "working") {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <StatusSpinner
          size={7}
          color={pane.agent?.brand ?? "var(--good)"}
          title="working"
        />
        <span className="font-mono text-[10.5px] text-[color:var(--muted-foreground)]">
          working
        </span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <StatusDot variant={pane.dotVariant} />
      <span
        className="font-mono text-[10.5px]"
        style={{
          color: pane.awaitingInput ? AMBER : "var(--muted-foreground)",
        }}
      >
        {pane.statusWord}
      </span>
    </span>
  );
}

/** Metadata-only body: shown for default-backend sessions (no screen grid) and
 * briefly while the first snapshot is in flight. Focus still attaches. */
function PaneFallback({
  pane,
  loading,
}: {
  pane: PaneModel;
  loading: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-3 text-center">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-white/30">
        {loading ? "loading…" : "live preview unavailable"}
      </span>
      {!loading && (
        <span className="text-[11px] text-white/45">
          Focus to attach interactively
        </span>
      )}
    </div>
  );
}
