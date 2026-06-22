import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import { createUiApi, UiApiError } from "../apps/web/src/lib/ui-api";

describe("settings route — daemon restart UX (source surface)", () => {
  test("layout.tsx renders Restart daemon action with test id", async () => {
    const file = Bun.file(
      new URL("../apps/web/src/routes/settings/layout.tsx", import.meta.url)
        .pathname,
    );
    const text = await file.text();
    expect(text).toContain("settings-restart-daemon");
    expect(text).toContain("Restart daemon");
    expect(text).toContain("DaemonRestartModal");
    expect(text).toContain('openRestartDialog("manual")');
  });

  test("layout.tsx opens the restart dialog after a save reports restartRequired", async () => {
    const file = Bun.file(
      new URL("../apps/web/src/routes/settings/layout.tsx", import.meta.url)
        .pathname,
    );
    const text = await file.text();
    expect(text).toContain('openRestartDialog("post-save")');
    expect(text).toMatch(/requiresRestart\s*=\s*res\.restartRequired\s*===\s*true/);
  });

  test("layout.tsx does not open the restart dialog on validation failures", async () => {
    const file = Bun.file(
      new URL("../apps/web/src/routes/settings/layout.tsx", import.meta.url)
        .pathname,
    );
    const text = await file.text();
    // The post-save open call appears only inside the requiresRestart branch
    // of handleSave (not in any catch block).
    const lines = text.split("\n");
    let inCatch = false;
    let depth = 0;
    for (const line of lines) {
      if (/} catch \(/.test(line)) {
        inCatch = true;
        depth = 0;
      }
      if (inCatch) {
        depth += (line.match(/\{/g) ?? []).length;
        depth -= (line.match(/\}/g) ?? []).length;
        expect(line).not.toContain('openRestartDialog("post-save")');
        if (depth < 0) inCatch = false;
      }
    }
  });

  test("DaemonRestartModal source warns about disconnect, terminals, operations, and settings effect", async () => {
    const file = Bun.file(
      new URL(
        "../apps/web/src/components/daemon-restart-modal.tsx",
        import.meta.url,
      ).pathname,
    );
    const text = await file.text();
    expect(text).toContain("Web UI will briefly disconnect");
    expect(text).toContain("operations, log streams, or terminal sessions");
    expect(text).toContain("Daemon-owned terminal sessions stop");
    expect(text).toContain("Saved settings take effect only after");
    expect(text).toContain("daemon-restart-modal-confirm");
    expect(text).toContain("daemon-restart-modal-cancel");
    expect(text).toContain("daemon-restart-modal-submitted");
  });

  test("public unavailable surface does not render restart action", async () => {
    const file = Bun.file(
      new URL("../apps/web/src/routes/settings/layout.tsx", import.meta.url)
        .pathname,
    );
    const text = await file.text();
    // The Restart daemon button is rendered exclusively inside SettingsLayout;
    // PublicUnavailable returns early before the action row.
    const localStart = text.indexOf("function SettingsLayout(");
    const publicStart = text.indexOf("function PublicUnavailable(");
    const publicEnd = text.indexOf("\nfunction SettingsLayout(");
    expect(localStart).toBeGreaterThan(0);
    expect(publicStart).toBeGreaterThan(0);
    expect(publicEnd).toBeGreaterThan(publicStart);
    const publicBody = text.slice(publicStart, publicEnd);
    expect(publicBody).not.toContain("settings-restart-daemon");
    expect(publicBody).not.toContain("restartDaemon");
  });
});

describe("web ui-api restartDaemon helper", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-web-restart-helper-");
    daemon = null;
  });

  afterEach(async () => {
    await teardownDaemonTestHome(tmpHome, daemon);
  });

  test("restartDaemon resolves with scheduled status on success", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
        restartScheduler: () => {},
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    const res = await api.restartDaemon();
    expect(res.status).toBe("scheduled");
    expect(typeof res.scheduledAt).toBe("string");
  });

  test("restartDaemon surfaces 503 when restart is unavailable", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { host: "127.0.0.1", port: 0 },
        // No restartScheduler -> endpoint returns 503.
      }),
    );
    const api = createUiApi(daemon.webUrl!);
    try {
      await api.restartDaemon();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UiApiError);
      expect((e as UiApiError).status).toBe(503);
    }
  });
});
