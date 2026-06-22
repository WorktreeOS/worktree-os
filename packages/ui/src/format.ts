import type { AppPortHealthcheckResult } from "@worktreeos/runtime/healthchecks";
import { hostLabelFromMapping, hyperlinkUrl, osc8Link } from "./host-link";
import type { PortMapping, ServiceStatus } from "@worktreeos/compose/ps";
import type { TunnelSnapshot } from "@worktreeos/runtime/tunnel-registry";

export interface FormatOptions {
  /** Wrap published addresses in OSC-8 terminal hyperlinks. */
  hyperlinks?: boolean;
}

export function formatStatus(
  services: ServiceStatus[],
  opts: FormatOptions = {},
): string {
  if (services.length === 0) {
    return "(no services)";
  }
  const rows = services.map((s) => {
    const seen = new Set<string>();
    const addresses: string[] = [];
    for (const p of s.ports) {
      if (p.hostPort === undefined) continue;
      const key = `${p.containerPort}/${p.protocol}->${p.hostPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push(formatAddress(p, opts));
    }
    const addr = addresses.length > 0 ? addresses.join(", ") : "(no published ports)";
    return [s.service, s.state, addr];
  });
  const widths = [0, 0].map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) => `${r[0]!.padEnd(widths[0]!)}  ${r[1]!.padEnd(widths[1]!)}  ${r[2]}`)
    .join("\n");
}

/**
 * Compact unified status table: one row per (service, published port) with
 * health column merged in. Replaces the two-section `formatStatus` +
 * `formatHealthchecks` output for `wos status`.
 *
 * When tunnel snapshots are supplied, a TUNNEL column is appended showing
 * the active public URL or a failure message for each matching app port.
 */
export function formatStatusTable(
  services: ServiceStatus[],
  healthchecks: AppPortHealthcheckResult[] = [],
  tunnels: TunnelSnapshot[] = [],
  opts: FormatOptions = {},
): string {
  if (services.length === 0) return "(no services)";
  const hcByKey = new Map<string, AppPortHealthcheckResult>();
  for (const r of healthchecks) {
    hcByKey.set(`${r.service}:${r.containerPort}`, r);
  }
  const tunnelByKey = new Map<string, TunnelSnapshot>();
  for (const t of tunnels) {
    tunnelByKey.set(`${t.service}:${t.containerPort}`, t);
  }
  const showTunnels = tunnels.length > 0;
  const header = ["SERVICE", "STATUS", "ADDRESS", "HEALTH"];
  if (showTunnels) header.push("TUNNEL");
  const rows: string[][] = [header];
  for (const s of services) {
    const seen = new Set<string>();
    const ports = s.ports.filter((p) => {
      if (p.hostPort === undefined) return false;
      const key = `${p.containerPort}/${p.protocol}->${p.hostPort}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (ports.length === 0) {
      const row = [s.service, s.state, "(no published ports)", "—"];
      if (showTunnels) row.push("—");
      rows.push(row);
      continue;
    }
    for (const p of ports) {
      const hc = hcByKey.get(`${s.service}:${p.containerPort}`);
      const row = [s.service, s.state, formatAddress(p, opts), compactHealth(hc)];
      if (showTunnels) {
        const tn = tunnelByKey.get(`${s.service}:${p.containerPort}`);
        row.push(compactTunnel(tn));
      }
      rows.push(row);
    }
  }
  return renderColumns(rows);
}

function compactTunnel(t: TunnelSnapshot | undefined): string {
  if (!t) return "—";
  if (t.state === "active") return t.url;
  return t.message ? `FAILED — ${t.message}` : "FAILED";
}

function renderColumns(rows: string[][]): string {
  const cols = rows[0]!.length;
  const widths = new Array(cols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      const w = visibleWidth(row[i] ?? "");
      if (w > widths[i]) widths[i] = w;
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === cols - 1 ? cell : padVisible(cell, widths[i]!),
        )
        .join("  "),
    )
    .join("\n");
}

const OSC8_RE = /\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function visibleWidth(s: string): number {
  return s.replace(OSC8_RE, "").length;
}

function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

function compactHealth(r: AppPortHealthcheckResult | undefined): string {
  if (!r) return "—";
  switch (r.state) {
    case "healthy":
      return r.observedStatus !== undefined
        ? `healthy ${r.observedStatus}`
        : "healthy";
    case "failed": {
      const reason = shortHealthReason(r);
      return reason ? `FAILED — ${reason}` : "FAILED";
    }
    case "failed-allowed": {
      const reason = shortHealthReason(r);
      return reason ? `failed (allowed) — ${reason}` : "failed (allowed)";
    }
    case "disabled":
      return "disabled";
    case "waiting":
      return "waiting";
  }
}

function shortHealthReason(r: AppPortHealthcheckResult): string {
  if (r.message) {
    if (/timed out/i.test(r.message)) return "timeout";
    const gotMatch = r.message.match(/got (\d+)/);
    if (gotMatch) return `got ${gotMatch[1]}`;
    return r.message.replace(/^healthcheck request failed:\s*/i, "");
  }
  if (r.observedStatus !== undefined) return `got ${r.observedStatus}`;
  return "";
}

export function formatAddress(
  p: PortMapping,
  opts: FormatOptions = {},
): string {
  const proto = (p.protocol || "tcp").toLowerCase();
  if (p.hostPort === undefined) {
    return `${p.containerPort}/${proto} (unpublished)`;
  }
  const url = hyperlinkUrl(p);
  const host = hostLabelFromMapping(p);
  const left = url ? url : `${host}:${p.hostPort}`;
  const display = `${left} -> ${p.containerPort}/${proto}`;
  if (opts.hyperlinks && url) return osc8Link(display, url);
  return display;
}

export function formatHealthchecks(results: AppPortHealthcheckResult[]): string {
  if (results.length === 0) return "";
  const rows = results.map((r) => {
    const label = healthcheckLabel(r);
    const detail = healthcheckDetail(r);
    const target = `${r.service}:${r.containerPort}`;
    return [target, label, detail];
  });
  const w0 = Math.max(...rows.map((r) => r[0]!.length));
  const w1 = Math.max(...rows.map((r) => r[1]!.length));
  return rows
    .map((r) => `healthcheck ${r[0]!.padEnd(w0)}  ${r[1]!.padEnd(w1)}  ${r[2]}`.trimEnd())
    .join("\n");
}

export function healthcheckLabel(r: AppPortHealthcheckResult): string {
  switch (r.state) {
    case "healthy":
      return "healthy";
    case "failed":
      return "FAILED";
    case "failed-allowed":
      return "failed (allowed)";
    case "disabled":
      return "disabled";
    case "waiting":
      return "waiting";
  }
}

function healthcheckDetail(r: AppPortHealthcheckResult): string {
  if (r.state === "disabled") return "healthcheck disabled";
  if (r.state === "healthy") {
    const url = r.url ?? "";
    return url
      ? `${url} -> ${r.observedStatus}`
      : `status ${r.observedStatus}`;
  }
  if (r.state === "waiting") {
    const parts: string[] = [];
    if (r.url) parts.push(r.url);
    if (r.timeoutMs !== undefined) parts.push(`up to ${r.timeoutMs}ms`);
    return parts.join(" — ");
  }
  const parts: string[] = [];
  if (r.url) parts.push(r.url);
  if (r.message) parts.push(r.message);
  return parts.join(" — ");
}
