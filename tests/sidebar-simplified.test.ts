import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* Source-text fidelity guards for the unified worktrees-band rail
 * (sidebar-worktree-band-v3).
 *
 * apps/web has no jsdom/RTL setup, so we assert against the component and its
 * living reference (demo/sidebar-worktree-band-v3.html) directly. These catch a
 * reintroduction of the removed rail-mode switch / status-first pulse / filter
 * chrome, and confirm the v3 anatomy: a project switcher, an attention filter
 * bar, a session stream, and a collapsible Worktrees band whose rows lead with
 * a status dot and carry a `⋯` overflow menu. */

const repoRoot = resolve(import.meta.dir, "..");
const sidebar = readFileSync(
  resolve(repoRoot, "apps/web/src/components/sidebar.tsx"),
  "utf8",
);
const layout = readFileSync(
  resolve(repoRoot, "apps/web/src/routes/layout.tsx"),
  "utf8",
);
const demo = readFileSync(
  resolve(repoRoot, "demo/sidebar-worktree-band-v3.html"),
  "utf8",
);

describe("rail omits status-first pulse / filter chrome", () => {
  const removedTestIds = [
    "sidebar-pulse",
    "sidebar-filter-input",
    "sidebar-filter-clear",
    "sidebar-workspaces-filter",
    "sidebar-terminals-filter",
    "sidebar-attention-lane",
  ];

  for (const id of removedTestIds) {
    test(`sidebar.tsx has no data-testid="${id}"`, () => {
      expect(sidebar).not.toContain(`data-testid="${id}"`);
    });
  }

  test("no attention lane label", () => {
    expect(sidebar).not.toContain("Needs attention");
  });

  test("no refresh control or pulse component", () => {
    expect(sidebar).not.toContain("RailPulse");
    expect(sidebar).not.toContain("computeWorkspacePulse");
    expect(sidebar).not.toContain("computeTerminalsPulse");
  });

  test("no visible sidebar keyboard hints", () => {
    expect(sidebar).not.toContain("⌘N");
    expect(sidebar).not.toContain("⌘F");
  });

  test("no per-project running/total count", () => {
    expect(sidebar).not.toMatch(/\{runningCount\}\/\{totalCount\}/);
    expect(sidebar).not.toContain("countSidebarRunningWorktrees");
  });
});

describe("the rail is a single unified surface (no rail mode)", () => {
  test("no rail mode switch / mode store", () => {
    expect(sidebar).not.toContain('data-testid="sidebar-mode-switch"');
    expect(sidebar).not.toContain("RailMode");
    expect(sidebar).not.toContain("useRailMode");
    expect(sidebar).not.toContain("setRailMode");
  });

  test("the attention filter bar uses SegmentedControl variant=filter", () => {
    // SegmentedControl is legitimately used for the attention filter bar; only
    // the rail *mode* switch is gone.
    expect(sidebar).toContain('variant="filter"');
  });

  test("no flat Terminals view / cross-project grouping", () => {
    expect(sidebar).not.toContain("TerminalsView");
    expect(sidebar).not.toContain("TerminalProjectGroup");
    expect(sidebar).not.toContain("groupTerminalSessions");
  });
});

describe("worktrees band anatomy", () => {
  test("renders the project switcher", () => {
    expect(sidebar).toContain("ProjectSwitcher");
  });

  test("worktree band rows lead with a status dot, not a branch icon", () => {
    const rowBlock = sidebar.match(
      /data-testid="sidebar-worktree-row"[\s\S]*?data-testid="sidebar-worktree-more"/,
    );
    expect(rowBlock).not.toBeNull();
    expect(rowBlock![0]).toContain("StatusDot");
    expect(rowBlock![0]).toContain("statusDotVariant(wt.status)");
    // The open button carries no branch icon — the leading signal is the dot.
    const openBlock = sidebar.match(
      /data-testid="sidebar-worktree-open"[\s\S]*?<\/button>/,
    );
    expect(openBlock).not.toBeNull();
    expect(openBlock![0]).not.toContain("GitBranch");
  });

  test("the band has a row overflow menu and is collapsible", () => {
    expect(sidebar).toContain('data-testid="sidebar-worktree-more"');
    expect(sidebar).toContain('data-testid="sidebar-band-toggle"');
    expect(sidebar).toContain("WorktreeContextMenu");
  });

  test("each band row exposes a quick New-session action", () => {
    expect(sidebar).toContain('data-testid="sidebar-worktree-new-session"');
    const rowBlock = sidebar.match(
      /data-testid="sidebar-worktree-row"[\s\S]*?data-testid="sidebar-worktree-more"/,
    );
    expect(rowBlock).not.toBeNull();
    // The quick `+` sits in the row's trailing action cluster, before `⋯`.
    expect(rowBlock![0]).toContain('data-testid="sidebar-worktree-new-session"');
    expect(rowBlock![0]).toContain("onNewSession(wt)");
  });

  test("band rows do not nest runtime, sessions, or a new-terminal row", () => {
    expect(sidebar).not.toContain('data-testid="rail-runtime-line"');
    expect(sidebar).not.toContain('data-testid="rail-new-terminal"');
  });
});

describe("source worktree row renders the root badge", () => {
  test("sidebar.tsx renders `root`, not `source`, as the visible badge", () => {
    const badge = sidebar.match(/wt\.isSource && \([\s\S]{0,260}?<\/span>/);
    expect(badge).not.toBeNull();
    expect(badge![0]).toContain("root");
    expect(badge![0]).not.toMatch(/>\s*source\s*</);
  });
});

describe("desktop rail is resizable", () => {
  test("renders a right-edge resize handle with separator semantics", () => {
    expect(sidebar).toContain('data-testid="sidebar-resize-handle"');
    expect(sidebar).toContain('role="separator"');
    expect(sidebar).toContain('aria-orientation="vertical"');
    expect(sidebar).toContain('aria-label="Resize sidebar"');
  });

  test("handle exposes current/minimum/maximum width values", () => {
    expect(sidebar).toContain("aria-valuemin={SIDEBAR_MIN_WIDTH}");
    expect(sidebar).toContain("aria-valuemax={max}");
    expect(sidebar).toContain("aria-valuenow={Math.round(width)}");
  });

  test("desktop width is applied as an inline style, gated off the fixed rail", () => {
    expect(sidebar).toContain("const desktopResizable =");
    expect(sidebar).toContain("style={desktopResizable ? { width:");
    // The fixed 16rem rail survives only as the non-resizable fallback.
    expect(sidebar).toContain('!desktopResizable && "w-[16rem]"');
  });

  test("text selection is suppressed during the drag", () => {
    expect(sidebar).toContain('document.body.style.userSelect = "none"');
  });

  test("the shell owns and persists the width via the storage helper", () => {
    expect(layout).toContain('from "@/lib/sidebar-width"');
    expect(layout).toContain("persistSidebarWidth");
    expect(layout).toContain("readStoredSidebarWidth");
  });
});

describe("demo reference matches the worktrees-band rail", () => {
  test("no legacy pulse / search / mode-switch chrome", () => {
    expect(demo).not.toContain('class="rail__pulse');
    expect(demo).not.toContain('class="rail__search');
    expect(demo).not.toContain('class="segs"');
    expect(demo).not.toContain('class="attn"');
    expect(demo).not.toContain("Needs attention");
  });

  test("has a session stream and a collapsible worktrees band", () => {
    expect(demo).toContain('class="filterbar"');
    expect(demo).toContain('class="row'); // stream session rows
    expect(demo).toContain('class="wtband"');
    expect(demo).toContain('class="wtband__head"');
    expect(demo).toContain('class="wtrow"');
    expect(demo).toContain('class="wtrow__menu"');
  });

  test("band rows lead with a status dot", () => {
    expect(demo).toContain('class="sdot sdot--run"');
  });

  test("source worktree badge reads `root`", () => {
    expect(demo).toContain('class="root">root');
  });

  test("grounds the rail with a profile footer", () => {
    expect(demo).toContain('class="rail__foot"');
    expect(demo).toContain('class="avatar"');
  });
});
