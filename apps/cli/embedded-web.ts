// In a Bun standalone executable (bun build --compile), the HTML import
// resolves to an `HTMLBundle` whose referenced JS/CSS/static assets are
// bundled into the binary. In dev (`bun apps/cli/index.ts`) Bun still resolves
// it, but the daemon-web layer prefers the filesystem build output and only
// uses the embedded bundle when running from the compiled executable.
// @ts-expect-error - Bun resolves `.html` to a built-in `HTMLBundle` type.
import indexHtml from "../web/index.html";
// PWA assets live at stable root paths and are NOT carried by the HTMLBundle
// (Bun would hash their URLs). Embedding them as static text/JSON lets us
// serve them deterministically via `serveAsset` in compiled-binary mode.
// @ts-expect-error - Bun supports `with { type: "text" }` import attributes.
import serviceWorkerSource from "../web/public/service-worker.js" with { type: "text" };
// @ts-expect-error - Bun supports `with { type: "text" }` import attributes.
import manifestSource from "../web/public/manifest.webmanifest" with { type: "text" };

export const embeddedWebBundle: unknown = indexHtml;

export interface EmbeddedPwaAsset {
  readonly body: string;
  readonly contentType: string;
}

export const embeddedPwaAssets: Record<string, EmbeddedPwaAsset> = {
  "/service-worker.js": {
    body: serviceWorkerSource as unknown as string,
    contentType: "application/javascript; charset=utf-8",
  },
  "/manifest.webmanifest": {
    body: manifestSource as unknown as string,
    contentType: "application/manifest+json; charset=utf-8",
  },
};
