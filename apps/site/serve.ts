/**
 * Tiny static server for the WorktreeOS presentation site.
 *
 * The site is plain HTML/CSS/JS — open `index.html` directly, or run
 * `bun run apps/site/serve.ts` for a local server with the right MIME types.
 */
const ROOT = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4950);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/" || path.endsWith("/")) path += "index.html";

    // keep requests inside the site directory
    const file = Bun.file(ROOT + path.replace(/^\/+/, ""));
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`WorktreeOS site → http://localhost:${server.port}`);
