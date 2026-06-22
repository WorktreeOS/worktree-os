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
import type { WorkflowStatusDto } from "./ui-api";

interface StatusCatalogContextValue {
  statuses: WorkflowStatusDto[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Look up a status by id; undefined for unknown/unassigned. */
  byId: (id: string | undefined) => WorkflowStatusDto | undefined;
}

const StatusCatalogContext = createContext<StatusCatalogContextValue | null>(
  null,
);

export function StatusCatalogProvider({ children }: { children: ReactNode }) {
  const api = useUiApi();
  const events = useUnifiedEvents();
  const [statuses, setStatuses] = useState<WorkflowStatusDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listStatuses();
      setStatuses(res.statuses);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = events.subscribe((env) => {
      if (env.type === "status.catalog.changed") void refresh();
    });
    return unsubscribe;
  }, [events, refresh]);

  const value = useMemo<StatusCatalogContextValue>(() => {
    const map = new Map(statuses.map((s) => [s.id, s]));
    return {
      statuses,
      loading,
      error,
      refresh,
      byId: (id) => (id ? map.get(id) : undefined),
    };
  }, [statuses, loading, error, refresh]);

  return (
    <StatusCatalogContext.Provider value={value}>
      {children}
    </StatusCatalogContext.Provider>
  );
}

export function useStatusCatalog(): StatusCatalogContextValue {
  const ctx = useContext(StatusCatalogContext);
  if (!ctx) throw new Error("StatusCatalogProvider is missing in the tree");
  return ctx;
}
