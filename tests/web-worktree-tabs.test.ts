import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/* Source-text fidelity guards for the full-width worktree tab model.
 *
 * apps/web has no jsdom/RTL setup, so — like the mobile bottom-nav and rail
 * suites — we assert against the worktree route source and its state module
 * directly. These catch a regression back to the old overview-plus-right-panel
 * model (docked panel, close/resize/fullscreen controls, panel width storage)
 * and confirm the new anatomy: a tab strip of Overview/Runtime/Review/Files/
 * Terminal driving one full-width content surface, plus focus mode.
 *
 * Test ids reach the DOM through `data-testid={...}` literals, so we assert the
 * quoted id rather than the rendered attribute. */

const repoRoot = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

// The worktree detail chrome + behaviour now lives in the host-agnostic
// `WorktreeView`; the `/worktree` route is a thin wrapper that reads the URL
// one-shots and feeds them in. Assert the view for surfaces/chrome, the wrapper
// for URL-param plumbing.
const worktree = read("apps/web/src/routes/worktree/worktree-view.tsx");
const worktreeRoute = read("apps/web/src/routes/worktree.tsx");
const tabsModule = read("apps/web/src/lib/worktree-tabs.ts");

/* Slice one top-level function declaration out of a source file. */
function fnBlock(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextIdx = src.slice(start + 1).indexOf("\nfunction ");
  return nextIdx < 0 ? src.slice(start) : src.slice(start, start + 1 + nextIdx);
}

describe("the worktree page is a full-width tab strip", () => {
  test("a tab strip exposes Overview · Runtime · Review · Files · Terminal", () => {
    expect(worktree).toContain('data-testid="worktree-tab-strip"');
    for (const id of [
      "worktree-tab-overview",
      "worktree-tab-runtime",
      "worktree-tab-review",
      "worktree-tab-files",
      "worktree-tab-terminal",
    ]) {
      expect(worktree).toContain(`"${id}"`);
    }
  });

  test("Overview is a normal tab, not a permanent left column", () => {
    // The overview dossier renders only when its tab is active.
    expect(worktree).toContain('activeTab === "overview" && (');
    expect(worktree).toContain("<WorktreeOverview");
  });

  test("exactly one active tab is the single full-width content surface", () => {
    expect(worktree).toContain('data-testid="worktree-surface"');
    expect(worktree).toContain("data-tab={activeTab}");
    for (const tab of ["runtime", "review", "files", "terminal"]) {
      expect(worktree).toContain(`activeTab === "${tab}" && (`);
    }
  });

  test("the Review tab shows +N −N change totals in good/bad colors", () => {
    expect(worktree).toContain('data-testid="worktree-tab-review-totals"');
    const strip = fnBlock(worktree, "WorktreeTabStrip");
    expect(strip).toContain("totalAdditions");
    expect(strip).toContain("totalDeletions");
    expect(strip).toContain("text-[color:var(--good)]");
    expect(strip).toContain("text-[color:var(--bad)]");
  });

  test("the tab strip is desktop-only and never uses the amber command accent", () => {
    const strip = fnBlock(worktree, "WorktreeTabStrip");
    expect(strip).toContain("lg:flex");
    expect(worktree).not.toContain("accent-cmd");
  });

  test("the tab strip reads as a distinct band on the warm shell", () => {
    const strip = fnBlock(worktree, "WorktreeTabStrip");
    expect(strip).toContain("bg-[color:var(--shell)]");
  });
});

describe("no fullscreen / focus-mode control", () => {
  test("the fullscreen / focus toggle and restore controls are removed", () => {
    expect(worktree).not.toContain('data-testid="worktree-focus-toggle"');
    expect(worktree).not.toContain('data-testid="worktree-focus-restore"');
    expect(worktree).not.toContain("focusMode");
    expect(worktree).not.toContain("setFocusMode");
    // The per-tab focus restore glyph is gone (the panel only ever expands to
    // the full-screen route; it never minimizes/restores in place).
    expect(worktree).not.toContain("Minimize2");
  });

  test("the panel host expand/close render inline in the compact header only", () => {
    // Host controls live in the single compact header row (panel density), not
    // a second header band; the full-screen page host renders neither.
    expect(worktree).toContain('data-testid="worktree-panel-expand"');
    expect(worktree).toContain('data-testid="worktree-panel-close"');
    expect(worktree).toContain("compact && (onExpandPanel || onClosePanel)");
  });

  test("the surface state model carries no focus-mode flag", () => {
    expect(tabsModule).not.toContain("focusMode");
    expect(tabsModule).not.toContain("setFocusMode");
  });
});

describe("the desktop right panel is gone", () => {
  test("no right-panel close / resize / fullscreen / toggle controls remain", () => {
    for (const id of [
      "right-panel-toggle",
      "right-panel-close",
      "right-panel-resize-handle",
      "right-panel-fullscreen",
      "right-panel-restore",
    ]) {
      expect(worktree).not.toContain(`"${id}"`);
    }
  });

  test("no right-panel shell, width logic, or open/close panel state survives", () => {
    expect(worktree).not.toContain("RightPanelShell");
    expect(worktree).not.toContain("useRightPanelWidth");
    expect(worktree).not.toContain("right-panel-logic");
    expect(worktree).not.toContain("@/components/right-panel");
    expect(worktree).not.toContain("openPanel");
    expect(worktree).not.toContain("closePanel");
    expect(worktree).not.toContain("panelOpen");
  });

  test("the old right-panel modules are deleted", () => {
    expect(
      existsSync(resolve(repoRoot, "apps/web/src/components/right-panel.tsx")),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "apps/web/src/lib/right-panel-logic.ts")),
    ).toBe(false);
  });
});

describe("legacy handoffs keep working as compatibility inputs", () => {
  test("panel=<tab> selects the matching full-width tab", () => {
    expect(worktree).toContain('["runtime", "review", "files", "terminal"]');
    expect(worktree).toContain("selectWorktreeTab(tab)");
  });

  test("legacy panel=logs selects Runtime with the init log channel", () => {
    expect(worktree).toContain('requestedPanel === "logs"');
    expect(worktree).toContain('setLogsChannel(prev, "init")');
  });

  test("terminal=<id> selects the Terminal tab and focuses the session", () => {
    // The wrapper reads the one-shot URL param; the view applies it.
    expect(worktreeRoute).toContain('searchParams.get("terminal")');
    expect(worktree).toContain("openTerminalTab(requestedTerminal)");
  });

  test("service/init log actions select Runtime and the requested channel", () => {
    expect(worktree).toContain("onSelectLogsChannel");
    expect(worktree).toContain("onSelectChannel={onSelectLogsChannel}");
  });
});

describe("the worktree tab state module models tabs, not a panel", () => {
  test("the tab union is overview/runtime/review/files/terminal", () => {
    expect(tabsModule).toContain(
      '"overview" | "runtime" | "review" | "files" | "terminal"',
    );
  });

  test("there is no open/closed panel state and no width storage key", () => {
    expect(tabsModule).not.toContain("open: false");
    expect(tabsModule).not.toContain("width-percent");
    expect(tabsModule).not.toContain("RIGHT_PANEL_MIN_PX");
  });

  test("a one-time migration reads the legacy right-panel visibility key", () => {
    expect(tabsModule).toContain("wos.right-panel.visibility");
    expect(tabsModule).toContain("migrateLegacyPanelVisibility");
    // The new selected-tab key is what gets written going forward.
    expect(tabsModule).toContain("wos.worktree.tab");
  });
});
