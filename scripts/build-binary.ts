#!/usr/bin/env bun
import { resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const repoRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(repoRoot, "apps/cli/index.ts");
// Honor an override for tests that build into a throwaway path; default to
// the repo `dist/wos` so `bun run build:binary` behavior matches docs.
const outfile = process.env.WOS_BINARY_OUTFILE
  ? resolve(process.env.WOS_BINARY_OUTFILE)
  : resolve(repoRoot, "dist/wos");
const outdir = resolve(outfile, "..");
const target = (process.env.WOS_BINARY_TARGET?.trim() ||
  undefined) as Bun.Build.CompileTarget | undefined;

await mkdir(outdir, { recursive: true });
await rm(outfile, { force: true });

const result = await Bun.build({
  entrypoints: [entrypoint],
  compile: target ? { outfile, target } : { outfile },
  minify: true,
  sourcemap: "linked",
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built single-binary executable: ${outfile}`);
