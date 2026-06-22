import { createBrowserRouter, Navigate } from "react-router";

import { BoardRoute } from "./routes/board";
import { DeployConfigDocsRoute } from "./routes/docs-deploy-config";
import { MissionControlRoute } from "./routes/mission-control";
import { RootLayout } from "./routes/layout";
import { NotFoundRoute } from "./routes/not-found";
import { SelectWorktreeRoute } from "./routes/select-worktree";
import { SetupRoute } from "./routes/setup";
import {
  DEFAULT_SETTINGS_SLUG,
  SETTINGS_SECTIONS,
  SettingsRoute,
} from "./routes/settings";
import { WorktreeRoute } from "./routes/worktree";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, Component: MissionControlRoute },
      { path: "board", Component: BoardRoute },
      { path: "select", Component: SelectWorktreeRoute },
      { path: "worktree", Component: WorktreeRoute },
      {
        path: "settings",
        Component: SettingsRoute,
        children: [
          {
            index: true,
            element: <Navigate to={DEFAULT_SETTINGS_SLUG} replace />,
          },
          ...SETTINGS_SECTIONS.map((section) => ({
            path: section.slug,
            Component: section.Component,
          })),
        ],
      },
      { path: "setup", Component: SetupRoute },
      { path: "docs/deploy-config", Component: DeployConfigDocsRoute },
      { path: "*", Component: NotFoundRoute },
    ],
  },
]);
