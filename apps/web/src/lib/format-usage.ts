/**
 * Quiet text-only formatting for resource-usage numbers. No gauges, bars, or
 * units beyond a compact suffix — these helpers feed plain inline text per the
 * quiet-workspace v3 language.
 */

/** Format a byte count as a compact `MiB`/`GiB` string, e.g. `512 MiB`. */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  const MiB = 1024 * 1024;
  const GiB = MiB * 1024;
  if (bytes >= GiB) {
    const v = bytes / GiB;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)} GiB`;
  }
  return `${Math.round(bytes / MiB)} MiB`;
}

/** Format a CPU percentage, e.g. `12%` or `0.4%` for sub-1% values. */
export function formatCpuPercent(percent: number | undefined): string | null {
  if (percent === undefined || !Number.isFinite(percent) || percent < 0) {
    return null;
  }
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}
