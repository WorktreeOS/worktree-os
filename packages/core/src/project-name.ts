import { createHash } from "node:crypto";
import { basename } from "node:path";

export function computeProjectName(currentWorktree: string, sourceWorktree: string): string {
  const repo = sanitize(basename(sourceWorktree));
  const hash = createHash("sha1").update(currentWorktree).digest("hex").slice(0, 8);
  return `wos-${repo}-${hash}`;
}

function sanitize(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "repo";
}
