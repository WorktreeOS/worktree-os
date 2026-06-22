import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@worktreeos/daemon/daemon-server";
import {
  createDaemonTestHome,
  teardownDaemonTestHome,
  withDaemonDefaults,
} from "./helpers/daemon-test-harness.ts";
import {
  shouldHideSettingsNav,
  shouldRenderSettingsUnavailable,
} from "../apps/web/src/lib/settings-access";
import type { PublicAuthState } from "../apps/web/src/lib/public-auth-state";
import {
  SETTINGS_SECTIONS,
  DEFAULT_SETTINGS_SLUG,
  fieldInSection,
  firstErroredSlug,
  sectionsWithErrors,
} from "../apps/web/src/routes/settings/sections";

const read = async (relPath: string): Promise<string> => {
  const file = Bun.file(new URL(`../${relPath}`, import.meta.url).pathname);
  return await file.text();
};
const routerSource = () => read("apps/web/src/router.tsx");
const layoutSource = () => read("apps/web/src/routes/settings/layout.tsx");
const sharedSource = () => read("apps/web/src/routes/settings/shared.tsx");
const terminalSource = () => read("apps/web/src/routes/settings/pages/terminal.tsx");
const aiProvidersSource = () =>
  read("apps/web/src/routes/settings/pages/ai-providers.tsx");

describe("settings-access decisions", () => {
  test("local sessions show settings nav", () => {
    const local: PublicAuthState = {
      kind: "ready",
      authenticated: false,
      requiresAuth: false,
    };
    expect(shouldHideSettingsNav(local)).toBe(false);
    expect(shouldRenderSettingsUnavailable(local)).toBe(false);
  });

  test("authenticated public sessions hide settings nav", () => {
    const publicSession: PublicAuthState = {
      kind: "ready",
      authenticated: true,
      requiresAuth: true,
    };
    expect(shouldHideSettingsNav(publicSession)).toBe(true);
    expect(shouldRenderSettingsUnavailable(publicSession)).toBe(true);
  });

  test("loading auth state defers to local navigation default", () => {
    expect(shouldHideSettingsNav({ kind: "loading" })).toBe(false);
    expect(shouldRenderSettingsUnavailable({ kind: "loading" })).toBe(false);
  });
});

describe("settings route module surface", () => {
  test("router registers nested /settings routes with an index redirect", async () => {
    const text = await routerSource();
    expect(text).toContain("SettingsRoute");
    expect(text).toMatch(/path:\s*"settings"/);
    // Nested children built from the section table + index redirect to default.
    expect(text).toContain("children:");
    expect(text).toContain("SETTINGS_SECTIONS.map");
    expect(text).toContain("Navigate");
    expect(text).toContain("DEFAULT_SETTINGS_SLUG");
    expect(text).toContain("index: true");
  });

  test("SettingsRoute component is exported", async () => {
    const mod = await import("../apps/web/src/routes/settings");
    expect(typeof mod.SettingsRoute).toBe("function");
  });

  test("default section slug is web", () => {
    expect(DEFAULT_SETTINGS_SLUG).toBe("web");
  });
});

describe("settings route — section route table", () => {
  test("table covers every section as a distinct slug + label", () => {
    const slugs = SETTINGS_SECTIONS.map((s) => s.slug);
    expect(slugs).toEqual([
      "web",
      "services",
      "tunnel",
      "terminal",
      "healthchecks",
      "ai-providers",
      "statuses",
      "notifications",
    ]);
    const labels = SETTINGS_SECTIONS.map((s) => s.label);
    expect(labels).toContain("Web");
    expect(labels).toContain("Tunnel");
    expect(labels).toContain("Terminal");
    expect(labels).toContain("Healthchecks");
    expect(labels).toContain("AI providers");
    expect(labels).toContain("Workflow statuses");
    expect(labels).toContain("Notifications");
  });

  test("each section entry carries a Component and field prefixes", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(typeof section.Component).toBe("function");
      expect(Array.isArray(section.fieldPrefixes)).toBe(true);
    }
    const tunnel = SETTINGS_SECTIONS.find((s) => s.slug === "tunnel");
    expect(tunnel?.fieldPrefixes).toContain("tunnel");
    const terminal = SETTINGS_SECTIONS.find((s) => s.slug === "terminal");
    expect(terminal?.fieldPrefixes).toContain("terminalBackend");
  });
});

describe("settings route — active-aware navigation", () => {
  test("nav uses NavLink with active state instead of anchor links", async () => {
    const text = await layoutSource();
    expect(text).toContain("NavLink");
    expect(text).toContain("isActive");
    expect(text).toContain("settings-section-nav");
    // The legacy in-page anchor links are gone.
    expect(text).not.toContain("href={`#${section.id}`}");
  });

  test("nav badges sections that hold validation errors", async () => {
    const text = await layoutSource();
    expect(text).toContain("erroredSlugs");
    expect(text).toContain("sectionsWithErrors");
    expect(text).toContain("settings-nav-error-");
  });

  test("sidebar is responsive (mobile horizontal list, desktop sticky rail)", async () => {
    const text = await layoutSource();
    expect(text).toContain("overflow-x-auto");
    expect(text).toContain("lg:flex-col");
    expect(text).toContain("lg:sticky");
  });
});

describe("settings route — cross-page validation routing", () => {
  test("fieldInSection matches owned prefixes and their dotted children", () => {
    expect(fieldInSection("tunnel.port", ["tunnel"])).toBe(true);
    expect(fieldInSection("tunnel", ["tunnel"])).toBe(true);
    expect(fieldInSection("serviceBind", ["serviceBind"])).toBe(true);
    expect(fieldInSection("web.host", ["serviceBind"])).toBe(false);
    // serviceBind prefix must not swallow tunnel.serviceTunnels.*
    expect(fieldInSection("tunnel.serviceTunnels.whitelistIps", ["serviceBind"])).toBe(
      false,
    );
  });

  test("sectionsWithErrors flags every section owning an error", () => {
    const slugs = sectionsWithErrors([
      { field: "tunnel.port" },
      { field: "healthcheck.retries" },
    ]);
    expect(slugs.has("tunnel")).toBe(true);
    expect(slugs.has("healthchecks")).toBe(true);
    expect(slugs.has("web")).toBe(false);
  });

  test("firstErroredSlug returns the first section in display order", () => {
    // Tunnel precedes Healthchecks in the table, so tunnel wins even when its
    // error is listed second.
    expect(
      firstErroredSlug([{ field: "healthcheck.retries" }, { field: "tunnel.port" }]),
    ).toBe("tunnel");
    expect(firstErroredSlug([{ field: "web.port" }])).toBe("web");
    expect(firstErroredSlug([])).toBeNull();
  });

  test("layout navigates to the first errored section on rejected save", async () => {
    const text = await layoutSource();
    expect(text).toContain("firstErroredSlug(e.fieldErrors)");
    expect(text).toContain("navigate(`/settings/${slug}`)");
  });
});

describe("settings route — terminal backend checkbox + availability", () => {
  test("backend control is a checkbox toggling tmux/default", async () => {
    const text = await terminalSource();
    expect(text).toContain("settings-terminal-backend");
    expect(text).toContain('form.terminalBackend === "tmux"');
    expect(text).toContain('v ? "tmux" : "default"');
    // The legacy dropdown is gone.
    expect(text).not.toContain("TERMINAL_BACKEND_OPTIONS");
  });

  test("legacy TERMINAL_BACKEND_OPTIONS dropdown is removed from shared", async () => {
    const text = await sharedSource();
    expect(text).not.toContain("TERMINAL_BACKEND_OPTIONS");
  });

  test("terminal page fetches availability and offers re-check", async () => {
    const text = await terminalSource();
    expect(text).toContain("getTerminalBackendAvailability");
    expect(text).toContain("useEffect");
    expect(text).toContain("Check again");
    expect(text).toContain("settings-terminal-check-again");
  });

  test("unavailable state shows platform-aware install guidance with a link", async () => {
    const text = await terminalSource();
    expect(text).toContain("settings-terminal-unavailable");
    expect(text).toContain("psmux");
    expect(text).toContain("tmux");
    expect(text).toContain("winget install psmux");
    expect(text).toContain("settings-terminal-install-link");
  });

  test("checkbox is disabled while loading or when unavailable", async () => {
    const text = await terminalSource();
    expect(text).toContain("checkboxDisabled");
    expect(text).toContain("loading || !available");
  });

  test("editor command and agent plugins controls live on the terminal page", async () => {
    const text = await terminalSource();
    expect(text).toContain("settings-editor-command");
    expect(text).toContain("settings-auto-inject-agent-plugins");
  });
});

describe("settings route — web.host and serviceBind controls", () => {
  test("buildDraft writes web.host and serviceBind into the save payload", async () => {
    const text = await sharedSource();
    expect(text).toContain("web.host = state.webHost.trim()");
    expect(text).toContain("draft.serviceBind = state.serviceBind.trim()");
  });

  test("field error map covers web.host and serviceBind", async () => {
    const text = await sharedSource();
    expect(text).toContain('field === "web.host"');
    expect(text).toContain('field === "serviceBind"');
  });

  test("form hydrates web.host and serviceBind from raw with effective fallback", async () => {
    const text = await sharedSource();
    expect(text).toContain("raw.web?.host");
    expect(text).toContain("eff.web.host");
    expect(text).toContain("raw.serviceBind");
    expect(text).toContain("eff.serviceBind");
  });
});

describe("settings route — terminal backend persistence", () => {
  test("buildDraft writes terminalBackend into save payload and field error maps", async () => {
    const text = await sharedSource();
    expect(text).toContain("draft.terminalBackend = state.terminalBackend");
    expect(text).toContain('field === "terminalBackend"');
  });

  test("form hydrates terminalBackend from raw with effective fallback", async () => {
    const text = await sharedSource();
    expect(text).toContain("isTerminalBackend(raw.terminalBackend)");
    expect(text).toContain("eff.terminalBackend");
  });
});

describe("settings route — Cloudflare Let's Encrypt provider", () => {
  test("source renders DNS challenge provider selector with Cloudflare option", async () => {
    const text = await sharedSource();
    expect(text).toContain("LE_PROVIDER_OPTIONS");
    expect(text).toContain('value: "cloudflare"');
    expect(text).toContain('value: "hook"');
    expect(text).toContain("settings-${prefix}-le-provider");
  });

  test("source renders Cloudflare-specific inputs and gates hook inputs", async () => {
    const text = await sharedSource();
    expect(text).toContain("settings-${prefix}-le-cf-token-env");
    expect(text).toContain("settings-${prefix}-le-cf-api-token");
    expect(text).toContain("settings-${prefix}-le-cf-zone-id");
    expect(text).toContain("HookChallengeFields");
    expect(text).toContain("CloudflareChallengeFields");
  });

  test("fieldKeyMatches maps Cloudflare validation paths for tunnel.ssl", async () => {
    const text = await sharedSource();
    expect(text).not.toContain('"web.ssl.letsencrypt');
    expect(text).toContain('"tunnel.ssl.letsencrypt.challenge.apiTokenEnv"');
    expect(text).toContain('"tunnel.ssl.letsencrypt.challenge.apiToken"');
    expect(text).toContain('"tunnel.ssl.letsencrypt.challenge.zoneId"');
  });

  test("PublicUnavailable renders for public sessions (no editable Cloudflare controls)", async () => {
    const text = await layoutSource();
    expect(text).toContain("PublicUnavailable");
    expect(text).toContain("Settings are local-only");
  });
});

describe("settings route — restart required banner", () => {
  test("source renders restart-required banner for saved settings", async () => {
    const text = await layoutSource();
    expect(text).toContain("settings-restart-required");
    expect(text).toContain("Restart the WorktreeOS daemon");
  });
});

describe("settings route — local SPA fallback", () => {
  let tmpHome: string;
  let daemon: DaemonHandle | null;
  let assetRoot: string;

  beforeEach(async () => {
    tmpHome = await createDaemonTestHome("wos-web-settings-route-");
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

  test("direct local navigation to /settings serves the SPA shell", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<h1");
  });

  test("direct local navigation to a settings subpage serves the SPA shell", async () => {
    daemon = await startDaemon(
      withDaemonDefaults(tmpHome, {
        resolveSession: async () => ({}) as any,
        web: { port: 0, assetRoot },
      }),
    );
    const res = await fetch(`${daemon.webUrl}/settings/terminal`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });
});

describe("settings route — AI providers controls", () => {
  test("renders the AI providers section with all supported provider types", async () => {
    const text = await sharedSource();
    expect(text).toContain("AI_PROVIDER_TYPE_OPTIONS");
    expect(text).toContain('value: "openai"');
    expect(text).toContain('value: "anthropic"');
    expect(text).toContain('value: "openrouter"');
    expect(text).toContain('value: "openai-like"');
    expect(text).toContain('value: "anthropic-like"');
  });

  test("renders type, name, API key, base URL, and models controls", async () => {
    const text = await aiProvidersSource();
    expect(text).toContain('title="AI providers"');
    expect(text).toContain("settings-ai-provider-type");
    expect(text).toContain("settings-ai-provider-name");
    expect(text).toContain("settings-ai-provider-api-key");
    expect(text).toContain("settings-ai-provider-base-url");
    expect(text).toContain("settings-ai-provider-models");
  });

  test("supports add, edit, and remove provider interactions", async () => {
    const text = await aiProvidersSource();
    expect(text).toContain("addProvider");
    expect(text).toContain("updateProvider");
    expect(text).toContain("removeProvider");
    expect(text).toContain("settings-ai-provider-add");
    expect(text).toContain("settings-ai-provider-remove");
  });

  test("masks the API key by default with a reveal action", async () => {
    const text = await aiProvidersSource();
    expect(text).toContain('revealedKeys[index] ? "text" : "password"');
    expect(text).toContain("toggleReveal");
    expect(text).toContain("settings-ai-provider-reveal");
  });

  test("discloses plaintext storage location for API keys", async () => {
    const text = await aiProvidersSource();
    expect(text).toContain("stored in plaintext");
    expect(text).toContain("{snapshot.path}");
  });

  test("models are submitted as an ordered list parsed from the text input", async () => {
    const text = await sharedSource();
    expect(text).toContain("parseWhitelistInput(p.models)");
  });

  test("buildDraft submits AI providers as aiProviders", async () => {
    const text = await sharedSource();
    expect(text).toContain("draft.aiProviders = state.aiProviders.map");
  });

  test("form hydrates aiProviders from raw with effective fallback", async () => {
    const text = await sharedSource();
    expect(text).toContain("aiProvidersToForm(raw.aiProviders, eff.aiProviders)");
  });

  test("maps validation field paths to provider controls and the field-error clear key", async () => {
    const aiText = await aiProvidersSource();
    expect(aiText).toContain("providerFieldError(index,");
    expect(aiText).toContain("providerModelsError(index)");
    const sharedText = await sharedSource();
    expect(sharedText).toContain(
      'field === "aiProviders" || field.startsWith("aiProviders.")',
    );
  });
});
