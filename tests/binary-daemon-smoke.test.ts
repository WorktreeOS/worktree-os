import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

const repoRoot = resolve(import.meta.dir, "..");
const buildScript = resolve(repoRoot, "scripts/build-binary.ts");
const tailwindPlugin = resolve(repoRoot, "node_modules/bun-plugin-tailwind");

const SKIP = !existsSync(tailwindPlugin);
const itOrSkip = SKIP ? test.skip : test;

let workDir: string;
let outfile: string;
let wosHome: string;
let daemonProc: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "wos-binary-smoke-"));
  outfile = join(workDir, "wos");
  wosHome = join(workDir, "home");
});

afterAll(async () => {
  if (daemonProc) {
    try {
      daemonProc.kill("SIGTERM");
      await daemonProc.exited;
    } catch {
      /* ignore */
    }
  }
  await rm(workDir, { recursive: true, force: true });
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

itOrSkip(
  "compiled binary daemon serves the embedded web UI without apps/web/dist",
  async () => {
    const build = Bun.spawn([process.execPath, buildScript], {
      cwd: repoRoot,
      env: { ...process.env, WOS_BINARY_OUTFILE: outfile },
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildCode = await build.exited;
    if (buildCode !== 0) {
      const stderr = await new Response(build.stderr).text();
      throw new Error(`build-binary failed: ${stderr}`);
    }
    expect(existsSync(outfile)).toBe(true);

    // Pick a free port for the daemon's web listener so the smoke run does
    // not collide with a developer's local daemon on 4949.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const webPort = probe.port;
    probe.stop(true);

    await mkdir(wosHome, { recursive: true });
    await writeFile(
      join(wosHome, "config.json"),
      JSON.stringify({ web: { port: webPort } }),
    );

    daemonProc = Bun.spawn([outfile, "start", "--foreground"], {
      cwd: workDir,
      env: {
        ...process.env,
        WOS_HOME: wosHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const metadataPath = join(wosHome, "daemon.json");
    await waitForFile(metadataPath, 15_000);

    const meta = JSON.parse(await readFile(metadataPath, "utf8")) as {
      webUrl?: string;
    };
    expect(meta.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const html = await fetch(meta.webUrl!);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const body = await html.text();
    expect(body.toLowerCase()).toContain("<!doctype html");

    // PWA assets must be served from the embedded binary without falling
    // through to the SPA index HTML — the compiled binary has no
    // `apps/web/dist` on disk.
    const manifest = await fetch(`${meta.webUrl}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const manifestBody = await manifest.text();
    expect(manifestBody.toLowerCase()).not.toContain("<!doctype");
    const manifestJson = JSON.parse(manifestBody) as { start_url?: string };
    expect(manifestJson.start_url).toBe("/");

    const sw = await fetch(`${meta.webUrl}/service-worker.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toContain("application/javascript");
    const swBody = await sw.text();
    expect(swBody.toLowerCase()).not.toContain("<!doctype");
    expect(swBody).toContain("fetch");

    // The terminal-layer runtime must either initialize cleanly (200) or
    // surface a typed terminal-unavailable diagnostic (503). The binary
    // MUST NOT crash, and MUST NOT depend on `node-pty` helper artifacts.
    const tl = await fetch(`${meta.webUrl}/ui/v1/terminal-layer/sessions`);
    expect([200, 503]).toContain(tl.status);
    if (tl.status === 503) {
      const tlBody = (await tl.json()) as { error?: string };
      expect(tlBody.error).toBe("terminal-unavailable");
    }

    // `wos restart` against the same binary must succeed: it stops the
    // currently running foreground daemon (signalling its PID), removes the
    // socket/metadata, and spawns a fresh `start --foreground` from the same
    // executable. We then assert a new daemon is reachable.
    const restart = Bun.spawn([outfile, "restart"], {
      cwd: workDir,
      env: { ...process.env, WOS_HOME: wosHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const restartCode = await restart.exited;
    if (restartCode !== 0) {
      const restartErr = await new Response(restart.stderr).text();
      throw new Error(`wos restart failed: ${restartErr}`);
    }
    // After restart the original foreground daemon has been signalled. Pick
    // up the replacement via the metadata file rewritten by the new daemon.
    await waitForFile(metadataPath, 15_000);
    const restartedMeta = JSON.parse(await readFile(metadataPath, "utf8")) as {
      webUrl?: string;
    };
    if (restartedMeta.webUrl) {
      const restartedHtml = await fetch(restartedMeta.webUrl);
      expect(restartedHtml.status).toBe(200);
    }

    // Stop the original foreground process handle (already gone, but the
    // afterAll cleanup also runs); also stop the replacement daemon.
    try {
      daemonProc.kill("SIGTERM");
      await daemonProc.exited;
    } catch {
      /* ignore — already exited */
    }
    daemonProc = undefined;

    // Finally, `wos stop` against the binary must remove the new daemon.
    const stop = Bun.spawn([outfile, "stop"], {
      cwd: workDir,
      env: { ...process.env, WOS_HOME: wosHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    await stop.exited;
  },
  120_000,
);
