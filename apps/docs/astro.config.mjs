// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "WorktreeOS",
      description:
        "One control plane for every worktree, every project, every agent. WorktreeOS is a control plane for parallel, agent-driven development: navigate every worktree, run agents, stay informed, review, deploy via Docker Compose, and expose your work — all from one place.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kwolfy/depboy",
        },
      ],
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Overview", link: "/" },
            { slug: "start/get-started" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/worktrees" },
            { slug: "concepts/daemon-and-web-ui" },
          ],
        },
        {
          label: "Worktree Runtime",
          items: [
            { slug: "concepts/deployment-lifecycle" },
            { slug: "guides/run-a-worktree" },
            { slug: "guides/selective-startup" },
            { slug: "guides/detached-startup" },
            { slug: "configuration/generated-mode" },
            { slug: "configuration/compose-mode" },
            { slug: "configuration/shell-mode" },
            { slug: "configuration/services-and-ports" },
            { slug: "configuration/healthchecks" },
            { slug: "configuration/dependencies" },
            { slug: "configuration/clone-volumes" },
            { slug: "configuration/cache" },
            { slug: "configuration/targets" },
            { slug: "configuration/arguments" },
            { slug: "reference/deploy-config" },
            { slug: "troubleshooting/config-errors" },
            { slug: "troubleshooting/port-conflicts" },
            { slug: "troubleshooting/healthcheck-failures" },
            { slug: "troubleshooting/init-and-volume-failures" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/web-ui" },
            { slug: "guides/remove-a-worktree" },
            { slug: "guides/windows" },
            { slug: "guides/wsl-access" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "reference/cli" },
            { slug: "reference/storage-and-sessions" },
            { slug: "reference/daemon" },
            { slug: "reference/release-binary" },
            { slug: "reference/skills" },
          ],
        },
        {
          label: "Troubleshooting",
          items: [{ slug: "troubleshooting/daemon-errors" }],
        },
        {
          label: "Development",
          items: [
            { slug: "development/repository-layout" },
            { slug: "development/build-and-test" },
            { slug: "development/architecture" },
          ],
        },
      ],
    }),
  ],
});
