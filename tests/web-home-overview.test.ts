import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* Source-text fidelity guards for the cross-project home overview and the rail
 * `Projects` nav row (add-projects-home-overview).
 *
 * apps/web has no jsdom/RTL setup, so we assert against the components directly.
 * These catch a regression to the previous "select a worktree" placeholder, a
 * home page that re-imports private sidebar row components instead of the shared
 * pure helpers, and a rail that drops / mis-orders the `Projects` ⟷ `Settings`
 * nav rows or re-buries them below the project switcher. */

const repoRoot = resolve(import.meta.dir, "..");
const home = readFileSync(
  resolve(repoRoot, "apps/web/src/routes/home.tsx"),
  "utf8",
);
const sidebar = readFileSync(
  resolve(repoRoot, "apps/web/src/components/sidebar.tsx"),
  "utf8",
);

describe("home route renders a cross-project overview", () => {
  test("renders the overview container instead of the placeholder", () => {
    expect(home).toContain('data-testid="home-overview"');
    // The previous populated-project placeholder is gone.
    expect(home).not.toContain("select a worktree");
    expect(home).not.toContain(
      "Select a worktree in the left panel to see details.",
    );
  });

  test("maps every project into a scannable section", () => {
    expect(home).toContain('data-testid="home-project-section"');
    expect(home).toContain("projects.map(");
  });

  test("project sections surface name, source path, counts, stale + error", () => {
    expect(home).toContain("project.displayName");
    expect(home).toContain("project.sourcePath");
    expect(home).toContain("projectRunningCount");
    expect(home).toContain('data-testid="home-project-stale"');
    expect(home).toContain('data-testid="home-project-error"');
  });

  test("worktree rows carry a branch icon, label, root badge and status glance", () => {
    const rowBlock = home.match(
      /data-testid="home-worktree-row"[\s\S]*?<\/Link>/,
    );
    expect(rowBlock).not.toBeNull();
    expect(rowBlock![0]).toContain("GitBranch");
    expect(rowBlock![0]).toContain("worktreeLabel(wt)");
    expect(rowBlock![0]).toContain("root");
    expect(rowBlock![0]).toContain("StatusDot");
    expect(rowBlock![0]).toContain("statusDotVariant(wt.status)");
  });

  test("worktree rows navigate to the existing worktree detail route", () => {
    expect(home).toContain(
      "to={`/worktree?path=${encodeURIComponent(wt.path)}`}",
    );
  });

  test("preserves the loading and no-project empty states", () => {
    expect(home).toContain("loading projects…");
    expect(home).toContain("projects.length === 0");
  });

  test("stays read-oriented: no lifecycle / rename / context-menu actions", () => {
    expect(home).not.toContain("onContextMenu");
    expect(home).not.toContain("createTerminal");
    expect(home).not.toContain("submitUp");
    expect(home).not.toContain("submitDown");
    expect(home).not.toContain("submitWorktreeRename");
    expect(home).not.toContain("submitWorktreeNote");
  });
});

describe("home overview lists live terminal sessions read-only", () => {
  test("reads live sessions per worktree from the shared sessions context", () => {
    expect(home).toContain('from "@/lib/terminal-sessions-context"');
    expect(home).toContain("useTerminalSessions(wt.path)");
    expect(home).toContain('data-testid="home-terminal-list"');
  });

  test("session rows use the shared agent/label helpers, not bespoke parsing", () => {
    expect(home).toContain('from "@/lib/terminal-agents"');
    expect(home).toContain("terminalAgent(session)");
    expect(home).toContain("terminalLabel(session");
  });

  test("session rows attach by handing off to the worktree Terminal panel", () => {
    const rowBlock = home.match(
      /data-testid="home-terminal-row"[\s\S]*?<\/Link>/,
    );
    expect(rowBlock).not.toBeNull();
    expect(home).toContain(
      "to={`/worktree?path=${encodeURIComponent(worktreePath)}&terminal=${encodeURIComponent(session.id)}`}",
    );
  });

  test("session rows expose no kill / rename / create controls", () => {
    const listBlock = home.slice(home.indexOf("function HomeTerminalRow"));
    expect(listBlock).not.toContain("onKill");
    expect(listBlock).not.toContain("onRename");
    expect(listBlock).not.toContain("terminate");
    expect(listBlock).not.toContain("createTerminalLayerSession");
  });
});

describe("home overview reuses shared pure helpers, not sidebar internals", () => {
  test("imports the shared labeling / status / count helpers", () => {
    expect(home).toContain('from "@/lib/sidebar-labels"');
    expect(home).toContain("worktreeLabel");
    expect(home).toContain('from "@/lib/sidebar-active-project"');
    expect(home).toContain("projectRunningCount");
    expect(home).toContain('from "@/components/ui/status-dot"');
    expect(home).toContain("statusDotVariant");
  });

  test("does not import the private sidebar component tree", () => {
    expect(home).not.toContain('from "@/components/sidebar"');
    expect(home).not.toContain("WorktreeNode");
  });
});

describe("rail navigation lives in the profile footer", () => {
  test("renders a Home affordance in the footer linking the home route", () => {
    expect(sidebar).toContain("RailFooter");
    const homeLink = sidebar.match(/<FooterIconLink\s+to="\/"[\s\S]*?\/>/);
    expect(homeLink).not.toBeNull();
    expect(homeLink![0]).toContain('testId="sidebar-projects"');
    expect(homeLink![0]).toContain('label="Home"');
  });

  test("Home appears before Settings in the footer", () => {
    const homeIdx = sidebar.indexOf('testId="sidebar-projects"');
    const settingsIdx = sidebar.indexOf('testId="sidebar-settings"');
    expect(homeIdx).toBeGreaterThan(-1);
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(homeIdx).toBeLessThan(settingsIdx);
  });

  test("Home is marked active on the home route", () => {
    expect(sidebar).toContain('location.pathname === "/"');
  });

  test("Home stays visible even when Settings is hidden", () => {
    // Settings is gated on `!settingsHidden`; Home must not share that gate.
    const homeIdx = sidebar.indexOf('testId="sidebar-projects"');
    const settingsGateIdx = sidebar.indexOf("{!settingsHidden && (");
    expect(homeIdx).toBeGreaterThan(-1);
    expect(settingsGateIdx).toBeGreaterThan(-1);
    expect(homeIdx).toBeLessThan(settingsGateIdx);
  });

  test("the footer sits below the rail body (no top nav rows)", () => {
    const switcherIdx = sidebar.indexOf("<ProjectSwitcher");
    const footerIdx = sidebar.indexOf("<RailFooter");
    expect(switcherIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(switcherIdx);
  });

  test("activating a footer nav link closes the mobile navigator", () => {
    expect(sidebar).toContain("if (!isDesktop) onNavigate();");
    const footerCall = sidebar.match(/<RailFooter[\s\S]*?\/>/);
    expect(footerCall).not.toBeNull();
    expect(footerCall![0]).toContain("onNavigate=");
  });
});
