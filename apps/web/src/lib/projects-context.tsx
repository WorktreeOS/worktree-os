import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useUiApi } from "./api-context";
import { useUnifiedEvents } from "./events-context";
import type { ProjectSummary } from "./ui-api";

const PROJECT_REFETCH_TYPES = new Set([
  "project.added",
  "project.updated",
  "project.removed",
  "project.stale",
  "project.recovered",
  "worktree.added",
  "worktree.removed",
  "worktree.updated",
  "worktree.created",
  "worktree.deployment-status.changed",
  "worktree.board.changed",
  "operation.started",
  "operation.finished",
  "operation.failed",
]);

interface ProjectsContextValue {
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({
  children,
  refreshIntervalMs = 5000,
}: {
  children: ReactNode;
  refreshIntervalMs?: number;
}) {
  const api = useUiApi();
  const events = useUnifiedEvents();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listProjects();
      setProjects(res.projects);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(id);
  }, [refresh, refreshIntervalMs]);

  useEffect(() => {
    const unsubscribe = events.subscribe((env) => {
      if (PROJECT_REFETCH_TYPES.has(env.type)) {
        void refresh();
      }
    });
    return unsubscribe;
  }, [events, refresh]);

  const value = useMemo<ProjectsContextValue>(
    () => ({ projects, loading, error, refresh }),
    [projects, loading, error, refresh],
  );

  return (
    <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsContextValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("ProjectsProvider is missing in the tree");
  return ctx;
}
