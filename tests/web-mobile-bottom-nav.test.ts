import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/* Source-text fidelity guards for the mobile bottom navigation (mobile-nav v3).
 *
 * apps/web has no jsdom/RTL setup, so — like the rail's `sidebar-simplified`
 * suite — we assert against the components and their living reference
 * (demo/mobile-nav.html) directly. These catch a regression back to the old
 * crowded bar (`Menu · Overview · Runtime · Review · Files · Terminal`), the
 * left slide-in drawer, the terminal count badge / long-press picker, and they
 * confirm the new anatomy: bottom destinations + a center Menu, a bottom-sheet
 * navigator, a More sheet, a Sessions sheet, and status as a local accent.
 *
 * Test ids reach the DOM through prop indirection (`testId="x"` →
 * `data-testid={testId}`), so we assert the quoted id rather than the attribute. */

const repoRoot = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

const worktree = read("apps/web/src/routes/worktree/worktree-view.tsx");
const layout = read("apps/web/src/routes/layout.tsx");
const sidebar = read("apps/web/src/components/sidebar.tsx");
const bottomSheet = read("apps/web/src/components/ui/bottom-sheet.tsx");
const indexCss = read("apps/web/src/index.css");
const demo = read("demo/mobile-nav.html");

/* Slice one top-level function declaration out of a source file (from its
 * `function NAME` to just before the next top-level `function`). Robust to
 * `}: {` destructured params, unlike a non-greedy `\n}` match. */
function fnBlock(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextIdx = src.slice(start + 1).indexOf("\nfunction ");
  return nextIdx < 0 ? src.slice(start) : src.slice(start, start + 1 + nextIdx);
}

describe("bottom bar destinations replace the old crowded tab bar", () => {
  test("bar exposes Overview · Runtime · Sessions · More destinations", () => {
    expect(worktree).toContain('data-testid="mobile-tab-bar"');
    for (const id of [
      "mobile-tab-overview",
      "mobile-tab-runtime",
      "mobile-tab-sessions",
      "mobile-tab-more",
    ]) {
      expect(worktree).toContain(`"${id}"`);
    }
  });

  test("old per-tab destinations and the drawer Menu are gone", () => {
    for (const id of [
      "mobile-tab-menu", // was the left-drawer opener
      "mobile-tab-home",
      "mobile-tab-review",
      "mobile-tab-files",
      "mobile-tab-terminal",
    ]) {
      expect(worktree).not.toContain(`"${id}"`);
    }
  });

  test("the long-press session picker and count badge are removed", () => {
    expect(worktree).not.toContain("LONG_PRESS_MS");
    expect(worktree).not.toContain("onLongPress");
    expect(worktree).not.toContain("onTerminalSwitch");
    expect(worktree).not.toContain("TerminalSessionSheet");
  });
});

describe("center Menu opens the navigator with the black-solid treatment", () => {
  test("a center Menu control routes to the navigator", () => {
    expect(worktree).toContain('data-testid="mobile-nav-menu"');
    expect(worktree).toContain("onOpenNavigator");
    expect(worktree).toContain("openNavigator");
  });

  test("the center Menu is black-solid, never the amber command accent", () => {
    const block = fnBlock(worktree, "MobileMenuButton");
    expect(block).toContain("bg-[color:var(--ink)]");
    expect(block).toContain("text-[color:var(--surface)]");
    // amber `--accent-cmd` is reserved for slash commands — never the bar.
    expect(worktree).not.toContain("accent-cmd");
  });
});

describe("active destination uses a soft-fill capsule, not an accent border", () => {
  test("active item soft-fills the icon capsule and emphasizes its label", () => {
    const block = fnBlock(worktree, "MobileNavItem");
    expect(block).toContain("bg-[color:var(--hover)]");
    expect(block).toContain("font-semibold");
    expect(block).not.toMatch(/border-\[color:var\(--accent/);
  });
});

describe("status is a local accent dot on a tab", () => {
  test("runtime partial/failed map to amber/red accents", () => {
    const block = fnBlock(worktree, "runtimeTabAccent");
    expect(block).toContain("#F59E0B"); // partial amber
    expect(block).toContain("var(--bad)"); // failed red
  });

  test("a live session lights the Sessions tab green; Review dirty flags More", () => {
    expect(worktree).toContain('dotColor={sessionsLive ? "var(--good)" : null}');
    expect(worktree).toContain('dotColor={reviewDirty ? "var(--ink-2)" : null}');
  });

  test("the bar carries no global status chrome (banner / colored bar)", () => {
    const bar = fnBlock(worktree, "MobileTabBar");
    expect(bar).not.toContain("signal-error");
    expect(bar).not.toContain("signal-warn");
  });
});

describe("More sheet exposes the demoted secondary views", () => {
  test("More routes to Review · Files · Logs · Open web", () => {
    for (const id of [
      "mobile-more-sheet",
      "more-review",
      "more-files",
      "more-logs",
      "more-open-web",
    ]) {
      expect(worktree).toContain(`"${id}"`);
    }
  });

  test("Review keeps a dirty indicator", () => {
    expect(worktree).toContain('data-testid="more-review-dirty"');
  });

  test("Logs routes to the Runtime panel (where the log tail lives)", () => {
    expect(worktree).toMatch(/onLogs=\{\(\) => \{\s*onMobileSelectTab\("runtime"\)/);
  });
});

describe("Sessions destination lists agents/terminals with attach + New terminal", () => {
  test("Sessions sheet lists sessions and offers New terminal", () => {
    for (const id of [
      "mobile-sessions-sheet",
      "mobile-session-row",
      "mobile-sessions-new",
    ]) {
      expect(worktree).toContain(`"${id}"`);
    }
    expect(worktree).toContain("createTerminalLayerSession");
    // agent-aware glyphs
    expect(worktree).toContain("terminalAgent");
  });
});

describe("mobile app-bar title chip is a secondary navigator trigger", () => {
  test("the worktree title chip opens the navigator", () => {
    expect(worktree).toContain('data-testid="mobile-appbar-title"');
    const bar = fnBlock(worktree, "MobileAppBar");
    expect(bar).toContain("onOpenNavigator");
  });
});

describe("the left slide-in drawer is removed from layout", () => {
  test("no edge-swipe gesture remains", () => {
    expect(layout).not.toContain("EDGE_ZONE_PX");
    expect(layout).not.toContain("SWIPE_THRESHOLD_PX");
    expect(layout).not.toContain("onShellTouchStart");
    expect(layout).not.toContain("onShellTouchMove");
  });

  test("no mobile drawer backdrop / fixed left drawer rendering", () => {
    expect(layout).not.toContain("Mobile backdrop");
  });
});

describe("navigator is mounted as a bottom sheet (open / dismiss)", () => {
  test("layout raises the embedded rail as a BottomSheet", () => {
    expect(layout).toContain("BottomSheet");
    expect(layout).toContain('"mobile-navigator-sheet"');
    expect(layout).toContain("navigatorOpen");
    expect(layout).toContain("openNavigator");
    // selecting / dismissing closes it
    expect(layout).toContain("setNavigatorOpen(false)");
    // reuses sidebar.tsx content via the embedded mode
    expect(layout).toMatch(/<Sidebar[\s\S]*?embedded/);
  });

  test("the rail supports an embedded sheet mode", () => {
    expect(sidebar).toContain("embedded");
  });
});

describe("BottomSheet primitive honors the touch + motion constraints", () => {
  test("the primitive exists with safe-area padding and reduced-motion fallback", () => {
    expect(
      existsSync(resolve(repoRoot, "apps/web/src/components/ui/bottom-sheet.tsx")),
    ).toBe(true);
    expect(bottomSheet).toContain("env(safe-area-inset-bottom)");
    expect(bottomSheet).toContain("bottom-sheet-in");
    expect(bottomSheet).toContain('e.key === "Escape"');
  });

  test("the standalone session sheet component is folded away", () => {
    expect(
      existsSync(resolve(repoRoot, "apps/web/src/components/terminal-session-sheet.tsx")),
    ).toBe(false);
  });

  test("reduced motion disables the reveal + sheet slide-up", () => {
    expect(indexCss).toContain("prefers-reduced-motion");
    expect(indexCss).toContain("bottom-sheet-in");
  });
});

describe("demo/mobile-nav.html matches production", () => {
  test("the center is a Menu button, not a + command", () => {
    expect(demo).toContain('data-lucide="menu"');
    expect(demo).not.toContain('title="New · run command"');
  });

  test("the freed Worktrees slot becomes More", () => {
    expect(demo).not.toContain('<span class="tab__label">Worktrees</span>');
    expect(demo).toContain('<span class="tab__label">More</span>');
  });

  test("the title chip stays a navigator trigger and the navigator is a sheet", () => {
    expect(demo).toContain('class="appbar__title"');
    expect(demo).toContain('class="sheet"');
    expect(demo).not.toContain("left drawer");
  });
});

describe("desktop sidebar resize does not leak into the mobile navigator", () => {
  test("the embedded navigator Sidebar receives no desktop width props", () => {
    const embedded = layout.match(/<Sidebar\s+embedded[\s\S]*?\/>/);
    expect(embedded).not.toBeNull();
    expect(embedded![0]).not.toContain("width=");
    expect(embedded![0]).not.toContain("onWidthChange");
    expect(embedded![0]).not.toContain("onWidthCommit");
  });

  test("resize is gated on desktop AND non-embedded mode", () => {
    expect(sidebar).toContain("isDesktop && !embedded && width != null");
  });

  test("the embedded rail keeps its sheet-owned fill layout", () => {
    expect(sidebar).toContain('"min-h-0 w-full flex-1"');
  });

  test("the worktree detail area stays flexible beside the rail", () => {
    expect(layout).toContain("relative flex-1 bg-[color:var(--surface)]");
  });
});
