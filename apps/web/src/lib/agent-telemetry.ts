import type { AgentTelemetry } from "@/lib/terminal-protocol";

/** Compact token count: 950 → "950", 49_512 → "50k", 1_204_000 → "1.2M". */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Short model label: "claude-opus-4-8" → "opus-4-8". */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, "");
}

/**
 * Whether a telemetry block carries any real usage. A freshly rebound session
 * (e.g. right after `/clear`, before its first assistant turn) publishes an
 * all-zero block; surfaces treat that the same as no telemetry.
 */
export function hasMeaningfulTelemetry(telemetry: AgentTelemetry): boolean {
  return (
    telemetry.mainTokens > 0 ||
    telemetry.subagentTokens > 0 ||
    telemetry.contextUsed > 0
  );
}

/** Context fullness as a whole percent, clamped to [0, 100]. */
export function contextPercent(telemetry: AgentTelemetry): number {
  if (telemetry.contextWindow <= 0) return 0;
  const pct = (telemetry.contextUsed / telemetry.contextWindow) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Multi-line tooltip breaking down main vs subagent token totals. */
export function telemetryTooltip(telemetry: AgentTelemetry): string {
  const lines: string[] = [];
  if (telemetry.model) lines.push(`model ${telemetry.model}`);
  lines.push(`main agent ${formatTokenCount(telemetry.mainTokens)} tokens`);
  if (telemetry.subagentTokens > 0) {
    lines.push(`subagents ${formatTokenCount(telemetry.subagentTokens)} tokens`);
  }
  lines.push(
    `context ${formatTokenCount(telemetry.contextUsed)} of ${formatTokenCount(telemetry.contextWindow)} (${contextPercent(telemetry)}%)`,
  );
  return lines.join("\n");
}
