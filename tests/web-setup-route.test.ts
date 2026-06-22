import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";

describe("setup route module surface", () => {
  test("router source registers /setup and /docs/deploy-config", async () => {
    const file = Bun.file(
      new URL("../apps/web/src/router.tsx", import.meta.url).pathname,
    );
    const text = await file.text();
    expect(text).toContain("SetupRoute");
    expect(text).toContain("DeployConfigDocsRoute");
    expect(text).toMatch(/path:\s*"setup"/);
    expect(text).toMatch(/path:\s*"docs\/deploy-config"/);
  });

  test("SetupRoute is exported", async () => {
    const mod = await import("../apps/web/src/routes/setup");
    expect(typeof mod.SetupRoute).toBe("function");
  });

  test("DeployConfigDocsRoute is exported", async () => {
    const mod = await import("../apps/web/src/routes/docs-deploy-config");
    expect(typeof mod.DeployConfigDocsRoute).toBe("function");
  });

  test("layout wires the setup gate", async () => {
    const file = Bun.file(
      new URL("../apps/web/src/routes/layout.tsx", import.meta.url).pathname,
    );
    const text = await file.text();
    expect(text).toContain("SetupProvider");
    expect(text).toContain("SetupAwareShell");
    expect(text).toContain("setupRequired");
    // The setup shell must omit the Sidebar so first-run users are not
    // distracted by an empty project list.
    expect(text).toMatch(/setupActive[\s\S]*<SetupRoute/);
  });

  test("worktree config status component is rendered by surfaces", async () => {
    const notStarted = await Bun.file(
      new URL(
        "../apps/web/src/routes/worktree/worktree-not-started.tsx",
        import.meta.url,
      ).pathname,
    ).text();
    expect(notStarted).toContain("WorktreeConfigStatus");
    expect(notStarted).toContain("configBlocksStart");
    expect(notStarted).toContain("start-worktree-blocked");

    const overview = await Bun.file(
      new URL(
        "../apps/web/src/routes/worktree/worktree-overview.tsx",
        import.meta.url,
      ).pathname,
    ).text();
    // The work dossier reduces config readiness to a quiet runtime-meta line
    // (the full WorktreeConfigStatus card stays in the Runtime panel launch
    // surface) but still surfaces deploy config status centrally via the
    // resolved config file name.
    expect(overview).toContain("overview-config-meta");
    expect(overview).toContain("configFileName");

    const cfg = await Bun.file(
      new URL(
        "../apps/web/src/routes/worktree/worktree-config-status.tsx",
        import.meta.url,
      ).pathname,
    ).text();
    expect(cfg).toContain("worktree-config-missing");
    expect(cfg).toContain("worktree-config-invalid");
    expect(cfg).toContain("worktree-config-valid");
    expect(cfg).toContain("worktree-config-docs-link");
    expect(cfg).toContain("/docs/deploy-config");
  });

  test("docs page covers root/worktree configs, modes, dynamic ports, and helpers", async () => {
    const docs = await Bun.file(
      new URL(
        "../apps/web/src/routes/docs-deploy-config.tsx",
        import.meta.url,
      ).pathname,
    ).text();
    // Root + worktree deploy config files and the $WOS_HOME distinction.
    expect(docs).toContain(".wos/deploy.yaml");
    expect(docs).toContain(".wos/deploy.worktree.yaml");
    expect(docs).toContain("$WOS_HOME");
    expect(docs).toContain("Generated mode");
    expect(docs).toContain("Compose mode");
    expect(docs).toContain("Shell mode");
    expect(docs).toContain("compose.config");
    expect(docs).toContain("compose.expose");
    expect(docs).toContain("app.services");
    expect(docs).toContain("init_script");
    expect(docs).toContain("clone_volumes");
    expect(docs).toContain("targets");
    expect(docs).toContain("arguments");
    expect(docs).toContain("cache");
    expect(docs).toContain("dynamic_ports");
  });
});

describe("setup route — local SPA fallback", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;
  let assetRoot: string;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-web-setup-route-");
    assetRoot = join(tmpHome, "dist");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(
      join(assetRoot, "index.html"),
      "<!doctype html><h1 id=app>shell</h1>",
    );
    daemon = null;
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("direct local navigation to /setup serves the SPA shell", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/setup`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("direct local navigation to /docs/deploy-config serves the SPA shell", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/docs/deploy-config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });
});
