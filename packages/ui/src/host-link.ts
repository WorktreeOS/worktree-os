import type { PortMapping } from "@worktreeos/compose/ps";

export const HOST_LOOPBACK = "localhost";

const LOOPBACK_IPS = new Set([
  "",
  "0.0.0.0",
  "::",
  "*",
  "127.0.0.1",
  "::1",
]);

export function hostLabelFromMapping(p: PortMapping): string {
  const ip = p.hostIp ?? "";
  if (LOOPBACK_IPS.has(ip)) return HOST_LOOPBACK;
  return ip;
}

export function hyperlinkUrl(p: PortMapping): string | undefined {
  if (p.hostPort === undefined) return undefined;
  const proto = (p.protocol || "tcp").toLowerCase();
  if (proto !== "tcp") return undefined;
  return `http://${hostLabelFromMapping(p)}:${p.hostPort}`;
}

const OSC = "\x1b]";
const ST = "\x1b\\";

/** Wraps text in an OSC-8 terminal hyperlink escape sequence. */
export function osc8Link(text: string, url: string): string {
  return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`;
}
