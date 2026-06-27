import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const root = import.meta.dir;
const outdir = join(root, "dist");

// Bun's bundler emits content-hashed chunk names but never prunes stale ones,
// so the dir accumulates every past build (gigabytes of orphaned chunks +
// source maps). Wipe it first so `dist` holds exactly the current build — both
// for a clean dev serve and so the packaged `web-dist` ships only live files.
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  plugins: [tailwind],
  minify: true,
  sourcemap: "linked",
  // Asset URLs must be absolute so nested SPA routes (e.g. /docs/deploy-config)
  // resolve chunks against the document root instead of the current path.
  publicPath: "/",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Copy PWA assets to stable browser-addressable paths in dist.
const publicDir = join(root, "public");
if (existsSync(publicDir)) {
  await cp(publicDir, outdir, { recursive: true });
}

// Copy the manifest's stable icon files to /icons/* so paths match regardless
// of how Bun's bundler hashes the same icons referenced from index.html.
const iconsOut = join(outdir, "icons");
await mkdir(iconsOut, { recursive: true });
await cp(
  join(root, "src/assets/icon-192.png"),
  join(iconsOut, "icon-192.png"),
);
await cp(
  join(root, "src/assets/icon-512.png"),
  join(iconsOut, "icon-512.png"),
);

// Inject the PWA manifest <link> into the built HTML. The tag lives outside
// the Bun HTMLBundle import graph so the bundler does not try to resolve
// `/manifest.webmanifest` against a non-existent module.
const indexHtmlPath = join(outdir, "index.html");
if (existsSync(indexHtmlPath)) {
  const html = await readFile(indexHtmlPath, "utf8");
  if (!html.includes('rel="manifest"')) {
    const injected = html.replace(
      "</head>",
      '<link rel="manifest" href="/manifest.webmanifest"></head>',
    );
    await writeFile(indexHtmlPath, injected);
  }
}

console.log(`Built ${result.outputs.length} files to ./dist`);
