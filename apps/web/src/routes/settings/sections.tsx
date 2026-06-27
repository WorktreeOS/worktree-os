import type { ComponentType } from "react";
import { AiProvidersPage } from "./pages/ai-providers";
import { HealthchecksPage } from "./pages/healthchecks";
import { NotificationsPage } from "./pages/notifications";
import { ProjectsPage } from "./pages/projects";
import { ServicesPage } from "./pages/services";
import { StatusesPage } from "./pages/statuses";
import { TerminalPage } from "./pages/terminal";
import { TunnelPage } from "./pages/tunnel";
import { WebPage } from "./pages/web";

/**
 * One settings section page. The single source of truth for route
 * registration, navigation rendering, and validation-error-to-section mapping.
 * `fieldPrefixes` lists the validation field paths the section owns (e.g.
 * Tunnel owns `tunnel.*`, Healthchecks owns `healthcheck.*`).
 */
export interface SettingsSection {
  slug: string;
  label: string;
  Component: ComponentType;
  fieldPrefixes: string[];
}

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  { slug: "web", label: "Web", Component: WebPage, fieldPrefixes: ["web"] },
  {
    slug: "services",
    label: "Services",
    Component: ServicesPage,
    fieldPrefixes: ["serviceBind"],
  },
  {
    slug: "tunnel",
    label: "Tunnel",
    Component: TunnelPage,
    fieldPrefixes: ["tunnel"],
  },
  {
    slug: "terminal",
    label: "Terminal",
    Component: TerminalPage,
    fieldPrefixes: ["terminalBackend", "editorCommand", "autoInjectAgentPlugins"],
  },
  {
    slug: "healthchecks",
    label: "Healthchecks",
    Component: HealthchecksPage,
    fieldPrefixes: ["healthcheck"],
  },
  {
    slug: "ai-providers",
    label: "AI providers",
    Component: AiProvidersPage,
    fieldPrefixes: ["aiProviders", "commitMessages"],
  },
  {
    slug: "statuses",
    label: "Workflow statuses",
    Component: StatusesPage,
    fieldPrefixes: [],
  },
  {
    slug: "projects",
    label: "Projects",
    Component: ProjectsPage,
    fieldPrefixes: [],
  },
  {
    slug: "notifications",
    label: "Notifications",
    Component: NotificationsPage,
    fieldPrefixes: [],
  },
];

/** Section the `/settings` index redirects to. */
export const DEFAULT_SETTINGS_SLUG = "web";

/** Whether a validation `field` path is owned by a section's prefixes. */
export function fieldInSection(
  field: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((p) => field === p || field.startsWith(`${p}.`));
}

/** Slugs of the sections that contain at least one of the given errors. */
export function sectionsWithErrors(
  errors: ReadonlyArray<{ field: string }>,
): Set<string> {
  const slugs = new Set<string>();
  for (const section of SETTINGS_SECTIONS) {
    if (errors.some((e) => fieldInSection(e.field, section.fieldPrefixes))) {
      slugs.add(section.slug);
    }
  }
  return slugs;
}

/** First section (in display order) holding an error, for save-failure routing. */
export function firstErroredSlug(
  errors: ReadonlyArray<{ field: string }>,
): string | null {
  for (const section of SETTINGS_SECTIONS) {
    if (errors.some((e) => fieldInSection(e.field, section.fieldPrefixes))) {
      return section.slug;
    }
  }
  return null;
}
