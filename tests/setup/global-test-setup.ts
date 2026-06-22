import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.WOS_HOME) {
  const fallback = mkdtempSync(join(tmpdir(), "wos-test-fallback-"));
  process.env.WOS_HOME = fallback;
  process.on("exit", () => {
    try {
      rmSync(fallback, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
