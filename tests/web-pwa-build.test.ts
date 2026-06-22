import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const repoRoot = resolve(import.meta.dir, "..");
const tailwindPlugin = resolve(repoRoot, "node_modules/bun-plugin-tailwind");

const SKIP = !existsSync(tailwindPlugin);
const itOrSkip = SKIP ? test.skip : test;

describe("apps/web PWA build output", () => {
  itOrSkip(
    "bun run build:web emits /manifest.webmanifest and /service-worker.js at stable root paths",
    async () => {
      const build = Bun.spawn(["bun", "run", "build:web"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await build.exited;
      if (code !== 0) {
        const stderr = await new Response(build.stderr).text();
        throw new Error(`build:web failed (code ${code}): ${stderr}`);
      }

      const distRoot = resolve(repoRoot, "apps/web/dist");
      expect(existsSync(distRoot)).toBe(true);

      const manifestPath = resolve(distRoot, "manifest.webmanifest");
      const swPath = resolve(distRoot, "service-worker.js");
      expect(existsSync(manifestPath)).toBe(true);
      expect(existsSync(swPath)).toBe(true);

      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: string;
        short_name?: string;
        start_url?: string;
        scope?: string;
        display?: string;
        background_color?: string;
        theme_color?: string;
        icons?: Array<{ src?: string; sizes?: string }>;
      };
      expect(manifest.name).toBeTruthy();
      expect(manifest.short_name).toBeTruthy();
      expect(manifest.start_url).toBe("/");
      expect(manifest.scope).toBe("/");
      expect(manifest.display).toBe("standalone");
      expect(manifest.background_color).toBeTruthy();
      expect(manifest.theme_color).toBeTruthy();
      const sizes = (manifest.icons ?? []).map((i) => i.sizes);
      expect(sizes).toContain("192x192");
      expect(sizes).toContain("512x512");

      const swText = await readFile(swPath, "utf8");
      expect(swText).toContain("fetch");
    },
    180_000,
  );
});
